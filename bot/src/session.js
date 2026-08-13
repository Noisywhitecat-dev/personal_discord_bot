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

function endSessionForUser(userId) {
  if (activeSession && activeSession.userId === userId) {
    endSession();
    return true;
  }
  return false;
}

module.exports = { getSession, isLocked, startSession, endSession, endSessionForUser };
