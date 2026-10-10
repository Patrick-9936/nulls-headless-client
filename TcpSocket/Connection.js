const Messaging = require('../Messaging/Messaging');
const Queue = require('../DataStream/Queue');
module.exports = function Connection(client, options) {
  const queue = new Queue();
  const messaging = new Messaging(client, queue, options);
  messaging.sendPepperAuthentication();
  client.on('data', data => {
    queue.add(data);
    while (messaging.pendingJob()) messaging.update();
  });
  client.on('close', () => Debugger.info('connection closed'));
};
