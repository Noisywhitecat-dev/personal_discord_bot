const crypto = require('node:crypto');
const { WebSocketServer } = require('ws');
const { PassThrough } = require('node:stream');
const { createAudioResource, StreamType } = require('@discordjs/voice');
const session = require('./session');

const AUTH_FAIL_LIMIT = 5;
const AUTH_FAIL_WINDOW_MS = 60_000;
const AUTH_BLOCK_MS = 60_000;
// 오디오 청크는 약 19KB(100ms 분량)다. 인증 전에도 적용되므로 큰 메시지로 메모리를 채우는 걸 막는다.
const MAX_MESSAGE_BYTES = 64 * 1024;

function isSecretValid(received, expected) {
  if (typeof received !== 'string') {
    return false;
  }
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  if (receivedBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
}

// 인증 실패를 IP별로 메모리에만 기록한다. 창(window) 안에 한도만큼 실패하면 잠시 차단한다.
function createAuthRateLimiter(now = Date.now) {
  const entries = new Map();

  return {
    isBlocked(ip) {
      const entry = entries.get(ip);
      return entry !== undefined && entry.blockedUntil > now();
    },
    recordFailure(ip) {
      const t = now();
      let entry = entries.get(ip);
      const expired = entry && (t - entry.windowStart > AUTH_FAIL_WINDOW_MS || (entry.blockedUntil > 0 && entry.blockedUntil <= t));
      if (!entry || expired) {
        entry = { count: 0, windowStart: t, blockedUntil: 0 };
        entries.set(ip, entry);
      }
      entry.count += 1;
      if (entry.count >= AUTH_FAIL_LIMIT) {
        entry.blockedUntil = t + AUTH_BLOCK_MS;
      }
    },
    recordSuccess(ip) {
      entries.delete(ip);
    },
    prune() {
      const t = now();
      for (const [ip, entry] of entries) {
        if (t - entry.windowStart > AUTH_FAIL_WINDOW_MS && entry.blockedUntil <= t) {
          entries.delete(ip);
        }
      }
    },
  };
}

async function notifySessionChannel(current, message) {
  if (!current.textChannel) {
    console.log(`[notify] 알림을 보낼 채널이 없어 로그만 남깁니다: ${message}`);
    return;
  }
  try {
    await current.textChannel.send(message);
  } catch (error) {
    console.log(`[notify] 채널 알림 전송 실패, 로그만 남깁니다 (${message}): ${error.message}`);
  }
}

function startWsSessionServer(port, { heartbeatMs = 15_000 } = {}) {
  const secret = process.env.WS_SECRET;
  if (!secret) {
    throw new Error('WS_SECRET이 설정되어 있지 않아 WebSocket 서버를 시작할 수 없습니다.');
  }

  const wss = new WebSocketServer({ port, maxPayload: MAX_MESSAGE_BYTES });
  const limiter = createAuthRateLimiter();
  console.log(`오디오 릴레이 WebSocket 서버가 ${port}번 포트에서 대기 중입니다.`);

  setInterval(() => limiter.prune(), 60_000).unref();

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

  // 세션당 클라이언트는 하나뿐이라, 네트워크가 끊겨 FIN 없이 죽은 연결이 슬롯을 계속 차지하면
  // 재접속이 4005로 막힌다. 일정 시간 아무 응답(pong/메시지)이 없는 연결은 끊어서 슬롯을 비운다.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();

  wss.on('connection', (ws, req) => {
    const ip = (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    if (limiter.isBlocked(ip)) {
      console.log(`인증 실패가 많은 IP의 접속을 잠시 거부했습니다. (${ip})`);
      ws.close(4006, '인증 실패가 너무 많아 잠시 차단됨');
      return;
    }

    const authTimeout = setTimeout(() => {
      ws.close(4001, '인증 시간 초과');
    }, 5000);
    ws.on('close', () => clearTimeout(authTimeout));

    ws.once('message', (data) => {
      clearTimeout(authTimeout);
      ws.isAlive = true;

      let receivedSecret;
      try {
        receivedSecret = JSON.parse(data.toString()).secret;
      } catch {
        limiter.recordFailure(ip);
        ws.close(4000, '잘못된 인증 메시지');
        return;
      }

      if (!isSecretValid(receivedSecret, secret)) {
        console.log(`잘못된 비밀키로 접속을 시도해 연결을 거부했습니다. (${ip})`);
        limiter.recordFailure(ip);
        ws.close(4003, '인증 실패');
        return;
      }
      limiter.recordSuccess(ip);

      const current = session.getSession();
      if (!current) {
        ws.close(4004, '활성화된 릴레이 세션이 없습니다. 먼저 디스코드에서 /start를 실행해주세요.');
        return;
      }

      if (current.client) {
        console.log(`이미 연결된 클라이언트가 있어 새 연결을 거부했습니다. (${ip})`);
        ws.close(4005, '이미 다른 클라이언트가 연결되어 있습니다');
        return;
      }
      current.client = ws;

      console.log(`클라이언트가 연결되었습니다. (세션 사용자: ${current.userId}, ${ip})`);
      notifySessionChannel(current, '오디오 클라이언트 연결됨');

      const audioStream = new PassThrough();
      const resource = createAudioResource(audioStream, { inputType: StreamType.Raw });
      current.player.play(resource);

      let bytesSinceLastLog = 0;
      const receiveLogInterval = setInterval(() => {
        console.log(`[relay] 최근 30초간 수신량: ${(bytesSinceLastLog / 1024).toFixed(1)} KB`);
        bytesSinceLastLog = 0;
      }, 30_000);

      ws.on('message', (chunk, isBinary) => {
        ws.isAlive = true;
        if (isBinary) {
          bytesSinceLastLog += chunk.length;
          audioStream.write(chunk);
        }
      });

      ws.on('close', (code, reason) => {
        console.log(`클라이언트 연결 종료 (code=${code}, reason=${reason.toString() || '없음'})`);
        clearInterval(receiveLogInterval);
        audioStream.end();
        if (current.client === ws) {
          current.client = null;
          notifySessionChannel(current, '오디오 클라이언트 연결 해제됨');
        }
      });
    });

    ws.on('error', (error) => {
      console.error('WebSocket 오류:', error);
    });
  });

  return wss;
}

module.exports = { startWsSessionServer, createAuthRateLimiter };
