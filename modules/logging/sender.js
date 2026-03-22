async function sendPayload(channel, payload) {
  if (!channel) return false;

  try {
    await channel.send(payload);
    return true;
  } catch (error) {
    console.error('❌ logging.sendPayload:', error?.message || error);
    return false;
  }
}

async function sendWithFallback({ channel, embed, text, useEmbeds, fallbackToText }) {
  if (useEmbeds && embed) {
    const ok = await sendPayload(channel, { embeds: [embed] });
    if (ok) return true;
  }

  if (fallbackToText && text) {
    return await sendPayload(channel, { content: text });
  }

  return false;
}

module.exports = {
  sendWithFallback,
};
