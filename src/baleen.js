var bunyan = require('bunyan');
var Promise = require('cargo-js/dist/promise.js');
var rabbitmq = require('./lib/rabbitmq.js');
var strfmt = require('util').format;

module.exports = Baleen;

function Baleen(exchange, queue, filterFn) {
    if (!exchange) throw new Error('Parameter #1 (exchange) required.');
    if (!queue) throw new Error('Parameter #2 (queue) required.');
    if (!filterFn) throw new Error('Parameter #3 (filterFN) required.');

    this.log = bunyan.createLogger({name: strfmt('baleen-filter.%s.%s', exchange, queue)});
    this.log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');
    this.exchange = exchange;
    this.routingKey = queue;
    this.queue = strfmt('%s.%s', exchange, queue);
    this.filterFn = filterFn;

}

Baleen.prototype.start = function () {
    var state = this;
    return new Promise(function (resolve, reject) {
        rabbitmq.connect(state.log).then(function (conn) {
            state.mq = {};
            state.mq.conn = conn;
            return conn.createConfirmChannel();
        }).then(function (channel) {
            state.mq.channel = channel;
            return channel.assertExchange(state.exchange, 'direct', {
                durable: true
            });
        }).then(function () {
            var channel = state.mq.channel;
            var queueName = strfmt('%s.%s', state.exchange, this.queue);
            return channel.assertQueue(queueName, {
                durable: true,
                arguments: {
                    messageTtl: 15000,
                    deadLetterExchange: 'DEAD_LETTERS'
                }
            });
        }).then(function (queueName) {
            var channel = state.mq.channel;
            return channel.bindQueue(state.queue, state.exchange, state.routingKey);
        }).then(function () {
            var channel = state.mq.channel;
            return channel.consume(state.queue, function (msg) {
                try {
                    state.onMessage(msg);
                } catch (error) {
                    // Defer the message with 'internal server error'
                }
            });
        }).then(function (consumer) {
            state.mq.consumer = consumer;
            resolve(state);
        }).catch(function (error) {
            state.log.error('Unable to start mail filter %s.%s: %s', state.exchange, state.queue, error);
            reject(error);
        });
    });
};

Baleen.prototype.stop = function () {
    var state = this;
    var channel = state.mq.channel;
    var log = state.log;
    if (!channel) {
        log.debug('Skipped stopping filter for queue %s. No MQ channel present.', state.queue);
        return;
    }
    if (state.mq && state.mq.consumer) {
        channel.cancel(state.mq.consumer)
            .finally(function () {
                channel.close();
            });
    }
};

Baleen.prototype.onMessage = function (msg) {
    var state = this;
    if (!msg) return;
    if (!msg.content) {
        log.debug('Ignoring empty message.');
        state.mq.channel.ack(msg);
        return;
    }

    var session;
    try {
        session = JSON.parse(msg.content.toString('utf-8'));
    } catch (error) {
        log.debug('Ignoring unparseable message: ' + error);
        state.mq.channel.ack(msg);
        return;
    }
    if (!session.id) {
        log.debug('Ignoring message without session ID.');
        state.mq.channel.ack(msg);
        return;
    }
    session.processedBy = session.processedBy || {};
    session.processedBy[state.queue] = session.processedBy[state.queue] || 0;
    session.processedBy[state.queue]++;
    var loopThreshold = parseInt(process.env.BALEEN_LOOP_THRESHOLD);
    if (loopThreshold <= 0 || isNaN(loopThreshold)) {
        loopThreshold = 20;
    }
    if (session.processedBy[state.queue] > loopThreshold) {
        log.error('%s - Loop detection threshold %d reached in queue %s.', session.id, loopThreshold, state.queue);
        state.mq.channel.nack(msg);
        return;
    }
    session.reject = _.bind(this.rejectFn, this, session);
    session.defer = _.bind(this.deferFn, this, session);
    session.discard = _.bind(this.discardFn, this, session);
    session.deliver = _.bind(this.deliverFn, this, session);
    try {
        state.filterFn(session);
        state.mq.channel.ack(msg);
    } catch (error) {
        log.error('%s - Error in filter for queue %s: %s', session.id, state.queue, error);
        log.debug(error, '%s - queue=%s', session.id, state.queue);
        state.mq.channel.nack(msg);
    }
};

Baleen.prototype.rejectFn = function (session, reason) {
};

Baleen.prototype.deferFn = function (session, reason) {

};

Baleen.prototype.discardFn = function (session, reason) {

};

Baleen.prototype.deliverFn = function (session, nextQueue) {

};
