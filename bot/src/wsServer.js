const { WebSocketServer } = require('ws');
const { PassThrough } = require('node:stream');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
  entersState,
} = require('@discordjs/voice');

async function startWsRelay(client, port) {
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

  const player = createAudioPlayer();
  connection.subscribe(player);

  player.on('error', (error) => {
    console.error('오디오 재생 오류:', error);
  });

  const wss = new WebSocketServer({ port });
  console.log(`WebSocket 서버 대기 중 (port ${port})`);

  wss.on('connection', (ws, req) => {
    console.log(`클라이언트 연결됨: ${req.socket.remoteAddress}`);

    const audioStream = new PassThrough();
    const resource = createAudioResource(audioStream, { inputType: StreamType.Raw });
    player.play(resource);

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        audioStream.write(data);
      }
    });

    ws.on('close', () => {
      console.log('클라이언트 연결 종료');
      audioStream.end();
    });

    ws.on('error', (error) => {
      console.error('WebSocket 오류:', error);
    });
  });

  return { connection, player, wss };
}

module.exports = { startWsRelay };
