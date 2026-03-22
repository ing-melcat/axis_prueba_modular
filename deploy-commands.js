require('dotenv').config();
const { REST, Routes, SlashCommandBuilder } = require('discord.js');

const DISCORD_TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const APPLICATION_ID = (process.env.APPLICATION_ID || '').trim();
const GUILD_ID = (process.env.GUILD_ID || '').trim();

if (!DISCORD_TOKEN || !APPLICATION_ID || !GUILD_ID) {
  console.error('❌ Faltan DISCORD_TOKEN, APPLICATION_ID o GUILD_ID en .env local');
  process.exit(1);
}

const commands = [
  new SlashCommandBuilder()
    .setName('sesiones')
    .setDescription('Ver y cerrar sesiones activas (Admin)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('clean')
    .setDescription('Borra mensajes recientes del canal actual (Admin)')
    .addIntegerOption((option) =>
      option
        .setName('cantidad')
        .setDescription('Cantidad de mensajes a borrar (1-100)')
        .setMinValue(1)
        .setMaxValue(100)
        .setRequired(true)
    )
    .toJSON(),
];

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID), {
      body: commands,
    });
    console.log('✅ Comandos desplegados (/sesiones, /clean).');
  } catch (e) {
    console.error('❌ Error deploy-commands:', e?.message || e);
    process.exit(1);
  }
})();
