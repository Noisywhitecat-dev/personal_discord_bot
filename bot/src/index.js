require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const { joinAndPlay } = require('./voice');

console.log('봇 시작');

const { DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID, TEST_AUDIO_FILE } = process.env;

if (!DISCORD_TOKEN || !GUILD_ID || !VOICE_CHANNEL_ID) {
  console.error('DISCORD_TOKEN, GUILD_ID, VOICE_CHANNEL_ID를 .env에 설정해주세요.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('ready', async () => {
  console.log(`로그인됨: ${client.user.tag}`);

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel || !channel.isVoiceBased()) {
    console.error('VOICE_CHANNEL_ID가 음성 채널을 가리키지 않습니다.');
    return;
  }

  await joinAndPlay(channel, TEST_AUDIO_FILE || './assets/test.mp3');
  console.log(`${channel.name} 채널에서 재생 시작`);
});

client.login(DISCORD_TOKEN);
