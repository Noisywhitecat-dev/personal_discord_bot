require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { relayFromClientProcess } = require('./relayClientProcess');

const { DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID } = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID를 .env에 설정해주세요.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log(`로그인됨: ${client.user.tag}`);
  // 클라이언트가 콘솔에서 캡처할 프로세스 번호를 입력받으므로 stdin을 이 터미널에 연결합니다.
  await relayFromClientProcess(client, { inheritStdin: true });
});

client.login(DISCORD_TOKEN);
