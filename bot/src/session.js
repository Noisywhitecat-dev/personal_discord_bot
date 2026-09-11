let activeSession = null;

function getSession() {
  return activeSession;
}

function isLocked() {
  return activeSession !== null;
}

function startSession(userId, connection, player, channelId) {
  activeSession = { userId, connection, player, channelId };
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
