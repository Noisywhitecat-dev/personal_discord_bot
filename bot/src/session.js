const crypto = require('node:crypto');

const JOIN_CODE_TTL_MS = 10 * 60_000;
// 6자리 코드는 무차별 대입에 약하므로, 틀린 시도가 이만큼 쌓이면 코드를 무효화한다. (성공 확률 상한 100/1,000,000)
const JOIN_CODE_MAX_FAILURES = 100;

let activeSession = null;

function getSession() {
  return activeSession;
}

function isLocked() {
  return activeSession !== null;
}

// textChannel: /start를 실행한 텍스트 채널(클라이언트 연결/해제 알림용). client: 현재 연결된 WS 클라이언트(세션당 하나).
function startSession(userId, connection, player, channelId, textChannel = null) {
  activeSession = { userId, connection, player, channelId, textChannel, client: null, joinCode: null };
}

function endSession() {
  if (activeSession) {
    activeSession.connection.destroy();
    activeSession = null;
  }
}

// 현재 세션에 접속할 6자리 일회용 코드를 새로 발급한다. 이전 코드는 즉시 무효가 된다. 세션이 없으면 null.
function issueJoinCode(now = Date.now) {
  if (!activeSession) {
    return null;
  }
  const value = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  activeSession.joinCode = { value, expiresAt: now() + JOIN_CODE_TTL_MS, used: false, failures: 0 };
  return value;
}

// 코드를 검사하고 맞으면 소모한다. 'ok' | 'wrong' | 'locked_now'(이번 실패로 시도 한도 도달)
// | 'locked' | 'expired' | 'used' | 'none'. 'ok' 말고는 전부 접속 거부 대상이다.
function useJoinCode(candidate, now = Date.now) {
  const joinCode = activeSession?.joinCode;
  if (!joinCode) return 'none';
  if (joinCode.used) return 'used';
  if (joinCode.failures >= JOIN_CODE_MAX_FAILURES) return 'locked';
  if (now() > joinCode.expiresAt) return 'expired';

  const candidateBuffer = Buffer.from(typeof candidate === 'string' ? candidate : '');
  const valueBuffer = Buffer.from(joinCode.value);
  const matches = candidateBuffer.length === valueBuffer.length && crypto.timingSafeEqual(candidateBuffer, valueBuffer);
  if (!matches) {
    joinCode.failures += 1;
    return joinCode.failures >= JOIN_CODE_MAX_FAILURES ? 'locked_now' : 'wrong';
  }

  joinCode.used = true;
  return 'ok';
}

// connection이 이미 죽었을 때(destroy 이벤트 등) 세션 상태만 비운다. connection.destroy()를 다시 호출하지 않는다.
function clearSessionState() {
  activeSession = null;
}

function endSessionForUser(userId) {
  if (activeSession && activeSession.userId === userId) {
    endSession();
    return true;
  }
  return false;
}

module.exports = {
  getSession,
  isLocked,
  startSession,
  endSession,
  endSessionForUser,
  clearSessionState,
  issueJoinCode,
  useJoinCode,
  JOIN_CODE_MAX_FAILURES,
};
