let activeSession = null;

function getSession() {
  return activeSession;
}

function isLocked() {
  return activeSession !== null;
}

// textChannel: /start를 실행한 텍스트 채널(클라이언트 연결/해제 알림용). client: 현재 연결된 WS 클라이언트(세션당 하나).
function startSession(userId, connection, player, channelId, textChannel = null) {
  activeSession = { userId, connection, player, channelId, textChannel, client: null };
}

function endSession() {
  if (activeSession) {
    activeSession.connection.destroy();
    activeSession = null;
  }
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

module.exports = { getSession, isLocked, startSession, endSession, endSessionForUser, clearSessionState };
