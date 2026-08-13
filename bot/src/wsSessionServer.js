const { WebSocketServer } = require('ws');
const { PassThrough } = require('node:stream');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const session = require('./session');

function startWsSessionServer(port) {
  const secret = process.env.WS_SECRET;
  const wss = new WebSocketServer({ port });
  console.log(`WebSocket 서버 대기 중 (port ${port})`);

  wss.on('connection', (ws) => {
    const authTimeout = setTimeout(() => {
      ws.close(4001, '인증 시간 초과');
    }, 5000);

    ws.once('message', (data) => {
      clearTimeout(authTimeout);

      let receivedSecret;
      try {
        receivedSecret = JSON.parse(data.toString()).secret;
      } catch {
        ws.close(4000, '잘못된 인증 메시지');
        return;
      }

      if (secret && receivedSecret !== secret) {
        console.log('잘못된 비밀키로 연결 거부');
        ws.close(4003, '인증 실패');
        return;
      }

      const current = session.getSession();
      if (!current) {
        ws.close(4004, '활성화된 릴레이 세션이 없습니다. 먼저 디스코드에서 /start를 실행해주세요.');
        return;
      }

      console.log(`클라이언트 연결됨 (세션 사용자 ${current.userId})`);

      const audioStream = new PassThrough();
      const resource = createAudioResource(audioStream, { inputType: StreamType.Raw });
      current.player.play(resource);

      ws.on('message', (chunk, isBinary) => {
        if (isBinary) {
          audioStream.write(chunk);
        }
      });

      ws.on('close', () => {
        audioStream.end();
      });
    });

    ws.on('error', (error) => {
      console.error('WebSocket 오류:', error);
    });
  });

  return wss;
}

module.exports = { startWsSessionServer };
