require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { registerCommands } = require('./commands');
const { handleInteraction } = require('./interactions');
const { startWsSessionServer } = require('./wsSessionServer');
const session = require('./session');

console.log('오디오 릴레이 봇을 시작합니다...');

const { DISCORD_TOKEN, GUILD_ID, WS_PORT } = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !WS_PORT) {
  console.error('DISCORD_TOKEN, GUILD_ID, WS_PORT를 .env에 설정해주세요.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`디스코드 로그인 완료: ${readyClient.user.tag}`);
  await registerCommands(DISCORD_TOKEN, readyClient.user.id, GUILD_ID);
  console.log('슬래시 커맨드 등록 완료: /start, /stop');
  startWsSessionServer(Number(WS_PORT));
});

client.on(Events.InteractionCreate, handleInteraction);

// 세션 소유자가 /stop 없이 음성 채널을 나가면(퇴장/이동/연결끊김) 세션을 자동 종료해
// 다른 길드원이 잠금 해제를 기다리지 않고 바로 /start 할 수 있게 한다.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const current = session.getSession();
  if (!current || oldState.member?.id !== current.userId) {
    return;
  }

  if (newState.channelId !== current.channelId) {
    console.log(`세션 소유자가 음성 채널을 나가 릴레이를 자동으로 종료했습니다. (사용자: ${current.userId})`);
    session.endSession();
  }
});

client.login(DISCORD_TOKEN);
