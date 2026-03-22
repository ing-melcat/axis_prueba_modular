# axis-bot-modular

Baseado en `ing-melcat/axis-bot`, pero con logging modular para embeds y fallback a texto.

## Qué hace
- se conecta a Discord
- consume la cola Redis
- abre y cierra sesiones
- manda logs al canal
- conserva `/sesiones` para admins
- persiste sesiones en Redis

## Cambio principal
La lógica de embeds ya no vive directo en `index.js`.
Ahora está separada en:

- `modules/logging/builders.js`
- `modules/logging/sender.js`
- `modules/logging/index.js`

Así, si cambias la presentación visual, no tocas el flujo principal de sesiones.

## Variables
- `DISCORD_TOKEN`
- `APPLICATION_ID`
- `GUILD_ID`
- `LOG_CHANNEL_ID`
- `ADMIN_CHANNEL_ID`
- `WEBHOOK_KEY`
- `SESSIONS_POST_URL` opcional
- `REDIS_URL`
- `QUEUE_KEY` opcional
- `SEND_NOTIFICATIONS_ON_RESTORE=false` opcional
- `USE_EMBEDS=true` opcional
- `LOG_FALLBACK_TO_TEXT=true` opcional

## Railway
Este servicio no necesita dominio público.
