const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

const CLIENT_EXE = path.join(
  __dirname, '..', '..', 'client', 'bin', 'Release', 'net9.0-windows10.0.19041.0', 'AudioRelayClient.exe'
);

async function relayFromClientProcess(client, { clientArgs = [], inheritStdin = false } = {}) {
  const { GUILD_ID, VOICE_CHANNEL_ID } = process.env;

  const guild = await client.guilds.fetch(GUILD_ID);
  const channel = await guild.channels.fetch(VOICE_CHANNEL_ID);

  if (!channel || !channel.isVoiceBased()) {
    throw new Error('VOICE_CHANNEL_ID가 음성 채널을 가리키지 않습니다.');
  }

  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 10_000);

  console.log('로컬 클라이언트 실행 중...');
  const capture = spawn(CLIENT_EXE, clientArgs, {
    stdio: [inheritStdin ? 'inherit' : 'pipe', 'pipe', 'pipe'],
  });

  capture.stderr.on('data', (chunk) => {
    process.stderr.write(`[client] ${chunk}`);
  });

  capture.on('exit', (code) => {
    console.log(`클라이언트 프로세스 종료 (code=${code})`);
  });

  const resource = createAudioResource(capture.stdout, {
    inputType: StreamType.Raw,
  });

  const player = createAudioPlayer();
  connection.subscribe(player);
  player.play(resource);

  player.on('error', (error) => {
    console.error('오디오 재생 오류:', error);
  });

  console.log(`${channel.name} 채널로 실시간 릴레이 시작`);

  process.on('SIGINT', () => {
    capture.kill();
    connection.destroy();
    process.exit(0);
  });

  return { connection, capture, player };
}

module.exports = { relayFromClientProcess };
