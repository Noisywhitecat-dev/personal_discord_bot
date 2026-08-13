require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { startWsRelay } = require('./wsServer');

const { DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID, WS_PORT } = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID || !WS_PORT) {
  console.error('DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID, WS_PORT를 .env에 설정해주세요.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log(`로그인됨: ${client.user.tag}`);
  await startWsRelay(client, Number(WS_PORT));
});

client.login(DISCORD_TOKEN);
