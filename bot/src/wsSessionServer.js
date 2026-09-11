const { WebSocketServer } = require('ws');
const { PassThrough } = require('node:stream');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const session = require('./session');

function startWsSessionServer(port) {
  const secret = process.env.WS_SECRET;
  const wss = new WebSocketServer({ port });
  console.log(`오디오 릴레이 WebSocket 서버가 ${port}번 포트에서 대기 중입니다.`);

  // 세션이 살아있는 동안 connection/player 상태를 주기적으로 남겨서,
  // "겉으론 연결된 것처럼 보이는데 실제로는 멈춘" 상황의 원인 추적에 사용한다.
  setInterval(() => {
    const current = session.getSession();
    if (!current) {
      return;
    }
    console.log(
      `[watchdog] connection=${current.connection.state.status}, player=${current.player.state.status}`
    );
  }, 30_000);

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
        console.log('잘못된 비밀키로 접속을 시도해 연결을 거부했습니다.');
        ws.close(4003, '인증 실패');
        return;
      }

      const current = session.getSession();
      if (!current) {
        ws.close(4004, '활성화된 릴레이 세션이 없습니다. 먼저 디스코드에서 /start를 실행해주세요.');
        return;
      }

      console.log(`클라이언트가 연결되었습니다. (세션 사용자: ${current.userId})`);

      const audioStream = new PassThrough();
      const resource = createAudioResource(audioStream, { inputType: StreamType.Raw });
      current.player.play(resource);

      let bytesSinceLastLog = 0;
      const receiveLogInterval = setInterval(() => {
        console.log(`[relay] 최근 30초간 수신량: ${(bytesSinceLastLog / 1024).toFixed(1)} KB`);
        bytesSinceLastLog = 0;
      }, 30_000);

      ws.on('message', (chunk, isBinary) => {
        if (isBinary) {
          bytesSinceLastLog += chunk.length;
          audioStream.write(chunk);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`클라이언트 연결 종료 (code=${code}, reason=${reason.toString() || '없음'})`);
        clearInterval(receiveLogInterval);
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
