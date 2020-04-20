const leveldown = require('leveldown');
const { clone } = require('../dist');

Error.stackTraceLimit = Infinity;

const [, , cloneId, domain, tmpDirName, requestId, mqttPort] = process.argv;

clone(leveldown(tmpDirName), {
  '@id': cloneId, '@domain': domain,
  mqttOpts: {
    host: 'localhost',
    port: Number(mqttPort),
    connectTimeout: 100, // Short for testing partitioning
    keepalive: 1 // Short for testing partitioning
  }
}).then(meld => {
  send(requestId, 'started', { cloneId });

  const handlers = {
    transact: message => meld.transact(message.request).subscribe({
      next: subject => send(message.id, 'next', { body: subject }),
      complete: () => send(message.id, 'complete'),
      error: errorHandler(message)
    }),
    stop: message => meld.close()
      .then(() => send(message.id, 'stopped'))
      .catch(errorHandler(message)),
    destroy: message => meld.close()
      .then(() => send(message.id, 'destroyed'))
      .catch(errorHandler(message))
  };

  process.on('message', message => {
    if (message['@type'] in handlers)
      handlers[message['@type']](message);
    else
      send(message.id, 'error', { err: `No handler for ${message['@type']}` });
  });

  meld.follow().subscribe({
    next: update => send(requestId, 'updated', { body: update }),
    complete: () => send(requestId, 'closed'),
    error: err => sendError(requestId, err)
  });
}).catch(err => {
  console.error(`${cloneId}: ${err}`);
  send(requestId, 'unstarted', { err: `${err}` });
});

function send(requestId, type, params) {
  process.send({ requestId, '@type': type, ...params });
}

function errorHandler(message) {
  return err => sendError(message.id, err);
}

function sendError(requestId, err) {
  return send(requestId, 'error', { err: `${err}` });
}
