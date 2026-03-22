const {
  buildOpenEmbed,
  buildCloseEmbed,
  buildOpenText,
  buildCloseText,
  buildCleanEmbed,
  buildCleanText,
} = require('./builders');

const { sendWithFallback } = require('./sender');

function createLogger({ client, logChannelId, useEmbeds = true, fallbackToText = true }) {
  async function getLogChannel() {
    try {
      return await client.channels.fetch(logChannelId);
    } catch {
      return null;
    }
  }

  async function post(payload) {
    const channel = await getLogChannel();

    if (!channel) {
      console.warn('⚠️ logging: no pude obtener el canal de logs');
      return false;
    }

    return await sendWithFallback({
      channel,
      embed: payload.embed || null,
      text: payload.text || '',
      useEmbeds,
      fallbackToText,
    });
  }

  async function sessionOpened(data) {
    return await post({
      embed: buildOpenEmbed(data),
      text: buildOpenText(data),
    });
  }

  async function sessionClosed(data) {
    return await post({
      embed: buildCloseEmbed(data),
      text: buildCloseText(data),
    });
  }

  async function cleanPerformed(data) {
    return await post({
      embed: buildCleanEmbed(data),
      text: buildCleanText(data),
    });
  }

  return {
    post,
    sessionOpened,
    sessionClosed,
    cleanPerformed,
  };
}

module.exports = {
  createLogger,
};
