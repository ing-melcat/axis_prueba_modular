require('dotenv').config();
const express = require('express');
const Redis = require('ioredis');
const {
  Client,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  InteractionType,
  PermissionsBitField,
  Events,
} = require('discord.js');
const { createLogger } = require('./modules/logging');

// ===== ENV =====
const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const LOG_CHANNEL_ID = (process.env.LOG_CHANNEL_ID || '').trim();
const ADMIN_CHANNEL_ID = (process.env.ADMIN_CHANNEL_ID || '').trim();
const WEBHOOK_KEY = (process.env.WEBHOOK_KEY || '').trim();
const SESSIONS_POST_URL = (process.env.SESSIONS_POST_URL || '').trim();
const REDIS_URL = (process.env.REDIS_URL || '').trim();
const QUEUE_KEY = (process.env.QUEUE_KEY || 'axis:webhook:queue').trim();

const SESSION_KEY = (process.env.SESSION_KEY || 'axis:sessions:v1').trim();
const DEDUPE_KEY = (process.env.DEDUPE_KEY || 'axis:dedupe:v1').trim();
const DEDUPE_WINDOW_SEC = Number(process.env.DEDUPE_WINDOW_SEC || 15);

const SEND_NOTIFICATIONS_ON_RESTORE =
  String(process.env.SEND_NOTIFICATIONS_ON_RESTORE || 'false')
    .trim()
    .toLowerCase() === 'true';

const MAX_SESSION_HOURS = Number(process.env.MAX_SESSION_HOURS || 12);
const MAX_SESSION_MS = MAX_SESSION_HOURS * 60 * 60 * 1000;
const SWEEP_INTERVAL_SEC = Number(process.env.SWEEP_INTERVAL_SEC || 60);

const USE_EMBEDS =
  String(process.env.USE_EMBEDS || 'true').trim().toLowerCase() === 'true';

const LOG_FALLBACK_TO_TEXT =
  String(process.env.LOG_FALLBACK_TO_TEXT || 'true').trim().toLowerCase() === 'true';

// ===== Required =====
const required = {
  DISCORD_TOKEN,
  LOG_CHANNEL_ID,
  ADMIN_CHANNEL_ID,
  REDIS_URL,
  WEBHOOK_KEY,
};

for (const [k, v] of Object.entries(required)) {
  if (!v) {
    console.error(`❌ Missing ${k}`);
    process.exit(1);
  }
}

function withRedisFamily(url) {
  try {
    const u = new URL(url);
    if (!u.searchParams.has('family')) u.searchParams.set('family', '0');
    return u.toString();
  } catch {
    return url;
  }
}

const redis = new Redis(withRedisFamily(REDIS_URL), {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

const redisBlocking = new Redis(withRedisFamily(REDIS_URL), {
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on('error', (e) => console.warn('⚠️ Redis error:', e?.message || e));
redisBlocking.on('error', (e) => console.warn('⚠️ Redis blocking error:', e?.message || e));

// ===== Discord client =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

const logger = createLogger({
  client,
  logChannelId: LOG_CHANNEL_ID,
  useEmbeds: USE_EMBEDS,
  fallbackToText: LOG_FALLBACK_TO_TEXT,
});

// ===== Express =====
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '256kb' }));

// ===== In-memory state =====
const sessions = new Map();
const timers = new Map();
let workerRunning = true;

// ===== Routes =====
app.get('/', (req, res) => res.status(200).send('OK'));

app.get('/health', async (req, res) => {
  let redisOk = true;
  try {
    await redis.ping();
  } catch {
    redisOk = false;
  }

  res.status(200).json({
    ok: true,
    redisOk,
    sessions: sessions.size,
    queueKey: QUEUE_KEY,
    sessionKey: SESSION_KEY,
    embeds: USE_EMBEDS,
    fallbackToText: LOG_FALLBACK_TO_TEXT,
    time: new Date().toISOString(),
  });
});

// ===== Helpers =====
function fmtDuration(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

async function dm(discordId, text) {
  if (!discordId) return;
  const user = await client.users.fetch(discordId).catch(() => null);
  if (user) await user.send(text).catch(() => null);
}

async function postSessionToSheets(payload) {
  if (!SESSIONS_POST_URL) return;

  try {
    const r = await fetch(SESSIONS_POST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.warn('⚠️ Sheets update failed:', r.status, t.slice(0, 250));
    }
  } catch (e) {
    console.warn('⚠️ Sheets update error:', e?.message || e);
  }
}

// ===== Timers =====
function clearSessionTimers(uid) {
  const t = timers.get(uid);
  if (!t) return;

  if (t.t2h) clearTimeout(t.t2h);
  if (t.t3h) clearTimeout(t.t3h);
  if (t.t30m) clearInterval(t.t30m);

  timers.delete(uid);
}

function scheduleReminders(uid, opts = {}) {
  const { skipImmediatePastDue = false } = opts;
  const s = sessions.get(uid);
  if (!s) return;

  clearSessionTimers(uid);

  const timerState = {
    t2h: null,
    t3h: null,
    t30m: null,
  };

  const elapsed = Math.max(0, Date.now() - s.startMs);
  const t2 = 2 * 60 * 60 * 1000;
  const t3 = 3 * 60 * 60 * 1000;
  const wait2 = Math.max(0, t2 - elapsed);
  const wait3 = Math.max(0, t3 - elapsed);

  if (!(skipImmediatePastDue && elapsed >= t2)) {
    timerState.t2h = setTimeout(async () => {
      const cur = sessions.get(uid);
      if (!cur) return;
      await dm(
        cur.discordId,
        '⏰ Recordatorio: tu sesión sigue activa desde hace **2 horas**.\nPasa tu tarjeta para cerrar.\nSi no puedes, comunícate con un administrador.',
      );
    }, wait2);
  }

  if (!(skipImmediatePastDue && elapsed >= t3)) {
    timerState.t3h = setTimeout(async () => {
      const cur = sessions.get(uid);
      if (!cur) return;

      await dm(
        cur.discordId,
        '⚠️ Tu sesión sigue activa desde hace **3 horas**.\nPasa tu tarjeta o comunícate con un administrador.',
      );

      timerState.t30m = setInterval(async () => {
        const again = sessions.get(uid);
        if (!again) return;
        await dm(
          again.discordId,
          '⚠️ Recordatorio (cada 30 min): tu sesión sigue activa.\nComunícate con un administrador si no puedes pasar tu tarjeta.',
        );
      }, 30 * 60 * 1000);
    }, wait3);
  }

  timers.set(uid, timerState);
}

// ===== Redis persistence =====
async function persistSession(uid) {
  const s = sessions.get(uid);
  if (!s) return;
  await redis.hset(SESSION_KEY, uid, JSON.stringify(s));
}

async function removePersistedSession(uid) {
  await redis.hdel(SESSION_KEY, uid);
}

async function restoreSessions() {
  const data = await redis.hgetall(SESSION_KEY);
  let restored = 0;
  const now = Date.now();

  for (const [uid, raw] of Object.entries(data || {})) {
    try {
      const s = JSON.parse(raw);
      const age = now - (Number(s.startMs) || now);

      if (age > MAX_SESSION_MS) {
        await redis.hdel(SESSION_KEY, uid).catch(() => {});
        continue;
      }

      sessions.set(uid, s);
      scheduleReminders(uid, {
        skipImmediatePastDue: !SEND_NOTIFICATIONS_ON_RESTORE,
      });
      restored += 1;
    } catch {}
  }

  console.log(`🔄 Restored sessions: ${restored}`);
  console.log(
    `🔔 Notifications on restore: ${SEND_NOTIFICATIONS_ON_RESTORE ? 'enabled' : 'disabled'}`
  );
}

// ===== Dedup =====
async function markDedupe(eventId) {
  const ok = await redis.set(
    `${DEDUPE_KEY}:${eventId}`,
    '1',
    'EX',
    DEDUPE_WINDOW_SEC,
    'NX',
  );
  return ok === 'OK';
}

// ===== Session open/close =====
async function openSession({ uid, nombre, matricula, discordId, timestampMs, fecha, hora }) {
  const s = {
    uid,
    nombre,
    matricula,
    discordId,
    startMs: timestampMs,
    lastMs: timestampMs,
  };

  sessions.set(uid, s);
  scheduleReminders(uid);
  await persistSession(uid);

  await postSessionToSheets({
    uid,
    nombre: nombre || '',
    matricula: matricula || '',
    discordId: discordId || '',
    startMs: timestampMs,
    endMs: 0,
    active: true,
    closedBy: '',
    reason: '',
  });

  await logger.sessionOpened({
    uid,
    nombre,
    matricula,
    fecha,
    hora,
  });
}

async function closeSession(uid, closedBy, reason = '') {
  const s = sessions.get(uid);
  if (!s) return;

  clearSessionTimers(uid);

  const endMs = s.lastMs || Date.now();
  const dur = fmtDuration(endMs - s.startMs);

  sessions.delete(uid);
  await removePersistedSession(uid).catch(() => {});

  await postSessionToSheets({
    uid,
    nombre: s.nombre || '',
    matricula: s.matricula || '',
    discordId: s.discordId || '',
    startMs: s.startMs || 0,
    endMs,
    active: false,
    closedBy,
    reason: closedBy === 'admin' ? (reason || '') : '',
  }).catch(() => {});

  await logger.sessionClosed({
    uid,
    nombre: s.nombre,
    matricula: s.matricula,
    duration: dur,
    startMs: s.startMs,
    endMs,
    closedBy,
    reason,
  });
}

// ===== Process event =====
async function processEvent(body) {
  const uid = body.uid ? String(body.uid).trim().toUpperCase() : '';
  if (!uid) return;

  const eventId = `${uid}|${body.fecha || ''}|${body.hora || ''}|${body.nombre || ''}|${body.matricula || ''}`;
  const isNew = await markDedupe(eventId);
  if (!isNew) return;

  const timestampMs = Number(body.tsMs || 0) || Date.now();
  const nombre = body.nombre ? String(body.nombre) : '';
  const matricula = body.matricula ? String(body.matricula) : '';
  const discordId = body.discordId ? String(body.discordId) : '';

  if (!sessions.has(uid)) {
    await openSession({
      uid,
      nombre,
      matricula,
      discordId,
      timestampMs,
      fecha: body.fecha,
      hora: body.hora,
    });
  } else {
    const s = sessions.get(uid);
    s.lastMs = timestampMs;
    await persistSession(uid);
    await closeSession(uid, 'user');
  }
}

// ===== Worker loop (queue) =====
async function workerLoop() {
  console.log(`👂 Worker listening queue: ${QUEUE_KEY}`);

  while (workerRunning) {
    try {
      const result = await redisBlocking.blpop(QUEUE_KEY, 0);
      if (!result || !Array.isArray(result) || result.length < 2) continue;

      const raw = result[1];
      const payload = JSON.parse(raw);
      await processEvent(payload);
    } catch (e) {
      console.error('❌ worker loop error:', e?.message || e);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ===== Sweeper =====
async function sweepStaleSessions() {
  const now = Date.now();

  for (const [uid, s] of sessions.entries()) {
    const age = now - (Number(s.startMs) || now);

    if (age > MAX_SESSION_MS) {
      console.warn(`⚠️ Auto-close stale session uid=${uid} ageMs=${age}`);
      s.lastMs = now;
      await closeSession(
        uid,
        'admin',
        `Auto-cierre: sesión > ${MAX_SESSION_HOURS}h (posible abandono/bug)`,
      );
    }
  }
}

setInterval(() => {
  sweepStaleSessions().catch(() => {});
}, SWEEP_INTERVAL_SEC * 1000).unref();

// ===== Webhook endpoint =====
app.post('/webhook', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    if (WEBHOOK_KEY && key !== WEBHOOK_KEY) {
      return res.status(403).send('Forbidden');
    }

    const body = req.body || {};
    const uid = body.uid ? String(body.uid).trim().toUpperCase() : '';
    if (!uid) return res.status(400).send('Missing uid');

    await redis.rpush(QUEUE_KEY, JSON.stringify(body));
    return res.status(202).send('ENQUEUED');
  } catch (e) {
    console.error('❌ webhook enqueue error:', e?.message || e);
    return res.status(500).send('Error');
  }
});

// ===== Admin UI =====
client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'sesiones') {
      if (interaction.channelId !== ADMIN_CHANNEL_ID) {
        return interaction.reply({
          content: 'Usa este comando en el canal admin.',
          flags: 64,
        });
      }

      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({
          content: 'No tienes permisos.',
          flags: 64,
        });
      }

      const items = Array.from(sessions.entries()).slice(0, 25);
      if (!items.length) {
        return interaction.reply({
          content: 'No hay sesiones activas.',
          flags: 64,
        });
      }

      const menu = new StringSelectMenuBuilder()
        .setCustomId('close_session_select')
        .setPlaceholder('Selecciona una sesión activa...')
        .addOptions(
          items.map(([uid, s]) => ({
            label: `${s.nombre || 'Sin nombre'} / ${s.matricula || 'Sin matrícula'}`.slice(0, 100),
            description: `UID: ${uid}`.slice(0, 100),
            value: uid,
          })),
        );

      const row = new ActionRowBuilder().addComponents(menu);
      const embed = new EmbedBuilder()
        .setTitle('Sesiones activas')
        .setDescription('Selecciona una para cerrarla (admin).');

      return interaction.reply({ embeds: [embed], components: [row] });
    }

    if (interaction.isStringSelectMenu() && interaction.customId === 'close_session_select') {
      const uid = interaction.values[0];

      const modal = new ModalBuilder()
        .setCustomId(`close_session_modal:${uid}`)
        .setTitle('Cerrar sesión (Admin)');

      const reasonInput = new TextInputBuilder()
        .setCustomId('reason')
        .setLabel('Motivo del cierre')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(300);

      modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      return interaction.showModal(modal);
    }

    if (
      interaction.type === InteractionType.ModalSubmit &&
      interaction.customId.startsWith('close_session_modal:')
    ) {
      const uid = interaction.customId.split(':')[1];
      const reason = interaction.fields.getTextInputValue('reason');

      if (!interaction.memberPermissions?.has(PermissionsBitField.Flags.Administrator)) {
        return interaction.reply({
          content: 'No tienes permisos.',
          flags: 64,
        });
      }

      const s = sessions.get(uid);
      if (s) s.lastMs = Date.now();

      await closeSession(uid, 'admin', reason);

      return interaction.reply({
        content: `Sesión cerrada (UID ${uid}).`,
        flags: 64,
      });
    }
  } catch (e) {
    console.error(e);
    if (!interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Error interno.', flags: 64 }).catch(() => {});
    }
  }
});

// ===== Startup =====
client.once(Events.ClientReady, async () => {
  console.log(`✅ Bot listo: ${client.user.tag}`);
  console.log(
    `🎨 Embeds: ${USE_EMBEDS ? 'enabled' : 'disabled'} | Fallback texto: ${LOG_FALLBACK_TO_TEXT ? 'enabled' : 'disabled'}`
  );

  await restoreSessions();
  workerLoop().catch((e) => console.error('❌ worker fatal:', e?.message || e));
});

client.login(DISCORD_TOKEN);

// ===== Listen (Railway) =====
const port = Number(process.env.PORT || 3000);
app.listen(port, '0.0.0.0', () => {
  console.log(`✅ HTTP listo en :${port} (POST /webhook, GET /health)`);
});

// ===== Shutdown =====
async function shutdown() {
  console.log('🛑 shutting down...');
  workerRunning = false;

  for (const uid of timers.keys()) {
    clearSessionTimers(uid);
  }

  try {
    await redisBlocking.quit();
  } catch {}

  try {
    await redis.quit();
  } catch {}

  try {
    await client.destroy();
  } catch {}

  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
