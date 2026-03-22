const { EmbedBuilder } = require('discord.js');

function safeText(value, fallback = 'N/D') {
  const t = String(value ?? '').trim();
  return t || fallback;
}

function fmtDateTime(ms) {
  if (!ms) return 'N/D';
  try {
    return new Date(ms).toLocaleString('es-MX', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return 'N/D';
  }
}

function baseEmbed() {
  return new EmbedBuilder().setTimestamp(new Date());
}

function buildOpenEmbed(data) {
  const { uid, nombre, matricula, fecha, hora } = data;

  const whenText =
    fecha && hora
      ? `${fecha} ${hora}`
      : fecha
      ? `${fecha}`
      : hora
      ? `${hora}`
      : 'Sin fecha/hora';

  return baseEmbed()
    .setTitle('🟢 INICIO DE SESIÓN')
    .addFields(
      { name: 'UID', value: `\`${safeText(uid)}\``, inline: true },
      { name: 'Nombre', value: safeText(nombre, 'Sin nombre'), inline: true },
      { name: 'Matrícula', value: safeText(matricula, 'Sin matrícula'), inline: true },
      { name: 'Fecha/Hora', value: whenText, inline: false },
    );
}

function buildCloseEmbed(data) {
  const {
    uid,
    nombre,
    matricula,
    duration,
    startMs,
    endMs,
    closedBy,
    reason,
  } = data;

  const embed = baseEmbed()
    .setTitle('✅ CIERRE DE SESIÓN')
    .addFields(
      { name: 'UID', value: `\`${safeText(uid)}\``, inline: true },
      { name: 'Nombre', value: safeText(nombre, 'Sin nombre'), inline: true },
      { name: 'Matrícula', value: safeText(matricula, 'Sin matrícula'), inline: true },
      { name: 'Duración', value: `**${safeText(duration, '00:00:00')}**`, inline: true },
      { name: 'Inicio', value: fmtDateTime(startMs), inline: true },
      { name: 'Fin', value: fmtDateTime(endMs), inline: true },
    );

  if (closedBy === 'admin') {
    embed.addFields({
      name: 'Cerrada por admin',
      value: `Motivo: **${safeText(reason, 'Sin motivo')}**`,
      inline: false,
    });
  }

  return embed;
}

function buildOpenText(data) {
  const { uid, nombre, matricula, fecha, hora } = data;

  const whenText =
    fecha && hora
      ? `${fecha} ${hora}`
      : fecha
      ? `${fecha}`
      : hora
      ? `${hora}`
      : 'Sin fecha/hora';

  return [
    '🟢 INICIO DE SESIÓN',
    `UID: ${safeText(uid)}`,
    `Nombre: ${safeText(nombre, 'Sin nombre')}`,
    `Matrícula: ${safeText(matricula, 'Sin matrícula')}`,
    `Fecha/Hora: ${whenText}`,
  ].join('\n');
}

function buildCloseText(data) {
  const {
    uid,
    nombre,
    matricula,
    duration,
    startMs,
    endMs,
    closedBy,
    reason,
  } = data;

  const lines = [
    '✅ CIERRE DE SESIÓN',
    `UID: ${safeText(uid)}`,
    `Nombre: ${safeText(nombre, 'Sin nombre')}`,
    `Matrícula: ${safeText(matricula, 'Sin matrícula')}`,
    `Duración: ${safeText(duration, '00:00:00')}`,
    `Inicio: ${fmtDateTime(startMs)}`,
    `Fin: ${fmtDateTime(endMs)}`,
  ];

  if (closedBy === 'admin') {
    lines.push(`Cerrada por admin: ${safeText(reason, 'Sin motivo')}`);
  }

  return lines.join('\n');
}

module.exports = {
  buildOpenEmbed,
  buildCloseEmbed,
  buildOpenText,
  buildCloseText,
};
