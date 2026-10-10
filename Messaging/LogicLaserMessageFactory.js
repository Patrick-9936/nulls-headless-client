const ServerHelloMessage = require('./Messages/Server/ServerHelloMessage');
const LoginFailedMessage = require('./Messages/Server/LoginFailedMessage');
const LoginOkMessage = require('./Messages/Server/LoginOkMessage');
const HomeReadyMessage = require('./Messages/Server/HomeReadyMessage');
const SimpleStatusMessage = require('./Messages/Server/SimpleStatusMessage');

function includesCandidate(value, single, candidates) {
  return value === single || (Array.isArray(candidates) && candidates.includes(value));
}

module.exports = function createMessageByType(type, config) {
  const p = config.packetIds;
  if (type === p.serverHello) return new ServerHelloMessage();
  if (type === p.loginFailed) return new LoginFailedMessage();
  if (includesCandidate(type, p.loginOk, p.loginOkCandidates)) return new LoginOkMessage();
  if (includesCandidate(type, p.ownHomeData, p.ownHomeCandidates)) return new HomeReadyMessage();
  if (type === p.friendList) return new SimpleStatusMessage('Friend list received');
  if (type === p.friendListUpdate) return new SimpleStatusMessage('Friend list updated');
  if (type === p.addFriendFailed) return new SimpleStatusMessage('Friend request failed/rejected by server');
  if (type === p.spectateFailed) return new SimpleStatusMessage('Spectate failed/rejected by server');
  return null;
};
