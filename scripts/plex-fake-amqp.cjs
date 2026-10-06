const { EventEmitter } = require('node:events');

// Deterministic AMQP double: routing, prefetch, explicit acknowledgements and redelivery.
function fakeAmqp() {
  const queues = new Map();
  const connections = [];
  const publications = [];
  const state = { queues, connections, publications, failConnect: false, failPublish: false, duplicateAsks: false, holdResults: false };
  const flush = () => {
    for (const [name, queue] of queues) {
      if (state.holdResults && name.endsWith('.results')) continue;
      const consumer = queue.consumer;
      while (consumer && !consumer.channel.closed && queue.messages.length &&
        consumer.channel.pending.size < consumer.channel.limit) {
        const message = queue.messages.shift();
        consumer.channel.pending.set(message, queue);
        consumer.callback(message);
      }
    }
  };
  state.flush = flush;
  class Channel extends EventEmitter {
    constructor() {
      super();
      this.pending = new Map();
      this.limit = Infinity;
      this.closed = false;
    }
    async assertExchange() {}
    async assertQueue(name, options) {
      if (!queues.has(name)) queues.set(name, { messages: [], options, bindings: new Set(), consumer: null });
      return { queue: name };
    }
    async bindQueue(name, exchange, key) { queues.get(name).bindings.add(`${exchange}:${key}`); }
    async prefetch(limit) { this.limit = limit; }
    async consume(name, callback, options) {
      const queue = queues.get(name);
      if (queue.consumer && options.exclusive) throw new Error('Exclusive consumer already exists');
      queue.consumer = { callback, channel: this };
      queueMicrotask(flush);
      return { consumerTag: name };
    }
    publish(exchange, key, content, options, confirm) {
      publications.push({ exchange, key, payload: JSON.parse(content), options });
      if (state.transform) content = Buffer.from(JSON.stringify(state.transform(exchange, JSON.parse(content))));
      if (state.failPublish) { queueMicrotask(() => confirm(new Error('Publish failed'))); return true; }
      const target = exchange === '' ? queues.get(key) :
        [...queues.values()].find(queue => queue.bindings.has(`${exchange}:${key}`));
      if (!target) queueMicrotask(() => this.emit('return', {}));
      else {
        const message = () => ({ content, properties: options, fields: { routingKey: key, redelivered: false } });
        target.messages.push(message());
        if (state.duplicateAsks && exchange.endsWith('.asks')) target.messages.push(message());
      }
      queueMicrotask(() => { confirm(null); flush(); });
      return true;
    }
    ack(message) {
      if (!this.pending.delete(message)) throw new Error('Unknown acknowledgement');
      queueMicrotask(flush);
    }
    nack(message, all, requeue) {
      const queue = this.pending.get(message);
      if (!queue) throw new Error('Unknown negative acknowledgement');
      this.pending.delete(message);
      if (requeue) queue.messages.push(message);
      else queues.get(queue.options.arguments['x-dead-letter-routing-key']).messages.push(message);
      queueMicrotask(flush);
    }
    async close() {
      this.closed = true;
      for (const [message, queue] of this.pending) {
        message.fields.redelivered = true;
        queue.messages.unshift(message);
      }
      this.pending.clear();
      for (const queue of queues.values()) if (queue.consumer?.channel === this) queue.consumer = null;
      this.emit('close');
    }
  }
  state.amqp = {
    connect: async () => {
      if (state.failConnect) throw new Error('Connection refused');
      const connection = new EventEmitter();
      connection.channels = [];
      connection.createChannel = connection.createConfirmChannel = async () => {
        const channel = new Channel();
        connection.channels.push(channel);
        return channel;
      };
      connection.close = async () => {
        if (connection.closed) return;
        connection.closed = true;
        for (const channel of connection.channels) await channel.close();
        connection.emit('close');
      };
      connections.push(connection);
      return connection;
    },
  };
  return state;
}

module.exports = { fakeAmqp };
