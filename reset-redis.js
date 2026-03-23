require('dotenv').config();
const Redis = require('ioredis');

const REDIS_URL = (process.env.REDIS_URL || '').trim();
const SESSION_KEY = (process.env.SESSION_KEY || 'axis:sessions:v1').trim();
const QUEUE_KEY = (process.env.QUEUE_KEY || 'axis:webhook:queue').trim();
const DEDUPE_KEY = (process.env.DEDUPE_KEY || 'axis:dedupe:v1').trim();

if (!REDIS_URL) {
  console.error('❌ Missing REDIS_URL');
  process.exit(1);
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

(async () => {
  try {
    console.log('🧹 Limpiando sesiones...');
    const deletedSessions = await redis.del(SESSION_KEY);

    console.log('🧹 Limpiando cola...');
    const deletedQueue = await redis.del(QUEUE_KEY);

    console.log('🧹 Buscando dedupe...');
    const keys = await redis.keys(`${DEDUPE_KEY}:*`);

    let deletedDedupe = 0;
    if (keys.length) {
      deletedDedupe = await redis.del(...keys);
    }

    console.log('✅ Limpieza completada');
    console.log({
      deletedSessions,
      deletedQueue,
      deletedDedupe,
    });
  } catch (e) {
    console.error('❌ Error:', e?.message || e);
  } finally {
    await redis.quit().catch(() => {});
    process.exit(0);
  }
})();
