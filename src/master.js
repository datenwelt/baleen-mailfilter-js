var amqplib = require('amqplib');
var bunyan = require('bunyan');
var crypto = require('crypto');
var Promise = require('cargo-js/dist/promise.js');
var SMTPServer = require('smtp-server').SMTPServer;
var strfmt = require('util').format;
var _ = require('underscore');

var BaleenReject = require('./master/reject.js');
var RabbitMQ = require('./lib/rabbitmq.js');

var DEFAULT_EXCHANGES = ['CHECK_CLIENT', 'CHECK_SENDER', 'CHECK_RECIPIENT', 'CHECK_MESSAGE', 'DEAD_LETTERS'];
var DEFAULT_QUEUES = ['DEFER', 'DELIVER', 'DISCARD', 'INCOMING', 'REJECT'];
var DEFAULT_DEAD_LETTER_EXCHANGE = 'DEAD_LETTERS';
var DEFAULT_DEAD_LETTER_QUEUE = 'HOLD';

Master.prototype.constructor = Master;

function Master(options) {
    options = options || {};
    options.mq = options.mq || {};

    this.log = bunyan.createLogger({name: 'baleen-master'});
    this.log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');

    if (!options.mq.uri && !process.env.BALEEN_RABBITMQ_URI) {
        throw new Error("Environment variable BALEEN_RABBITMQ_URI is empty. Please set the URI of your RabbitMQ instance.");
    }

    this.mq = new RabbitMQ(options.mq.uri || process.env.BALEEN_RABBITMQ_URI, {heartbeat: 15});
    this.mq.exchanges = options.mq.exchanges || DEFAULT_EXCHANGES;
    this.mq.queue = options.mq.queue || DEFAULT_QUEUES;
    this.mq.deadLetterExchange = options.mq.deadLetterExchange || DEFAULT_DEAD_LETTER_EXCHANGE;
    this.mq.deadLetterQueue = options.mq.deadLetterQueue || DEFAULT_DEAD_LETTER_QUEUE;

    return this;
}

Master.prototype.start = function () {
    var state = this;
    return new Promise(function (resolve, reject) {
        state.mq.connect().then(function(conn) {
            state.mq.newChannel().then(function(channel) {
                state.mq.channel = channel;
            }).catch(function(error) {
                log.error('Unable to start master process: %s', error);
            });
        })
    });


};
/*
Master.prototype.initMq = function () {
    var mq = this.mq = {};
    return new Promise(function (resolve, reject) {
        mq.realUri =;
        if (!/^amqp:\/\//.test(mq.realUri)) {
            throw new Error("Environment variable BALEEN_RABBITMQ_URI does not contain a valid RabbitMQ URI.");
        }
        mq.uri = mq.realUri.replace(/^(amqps?:\/\/.+:).+(@.+)/, "$1******$2");
        try {
            log.debug('Connecting to message queue at %s.', mq.uri);
            mq.realUri += "?heartbeat=15";
            return amqplib.connect(mq.realUri)
                .then(function (conn) {
                    conn.on('error', function (error) {
                        reject(error);
                    });
                    mq.conn = conn;
                    log.debug('Creating mq channel to setup RabbitMQ enviroment.');
                    return conn.createChannel();
                }).then(function (channel) {
                    mq.channel = channel;
                    channel.on('error', function (error) {
                        reject(error);
                    });
                    var asserts = _.map(EXCHANGES, function (exchange) {
                        log.debug('Asserting existence of exchange %s.', exchange);
                        return channel.assertExchange(exchange, exchange == DEAD_LETTER_EXCHANGE ? 'fanout' : 'direct', {
                            durable: true
                        });
                    });
                    return Promise.when(asserts);
                }).then(function (exchanges) {
                    var channel = state.mq.channel;
                    var queues = QUEUES;
                    var asserts = [];
                    _.each(exchanges, function (exchange) {
                        exchange = exchange.exchange;
                        if (exchange == DEAD_LETTER_EXCHANGE) {
                            queues = [DEAD_LETTER_QUEUE];
                        }
                        _.each(queues, function (queue) {
                            var queueName = strfmt('%s.%s', exchange, queue);
                            log.debug('Asserting existence of queue %s.', queueName);
                            asserts.push(channel.assertQueue(queueName, {
                                'durable': true,
                                'arguments': {
                                    'messageTtl': 15000,
                                    'deadLetterExchange': DEAD_LETTER_EXCHANGE
                                }
                            }));
                        });
                    });
                    return Promise.when(asserts);
                }).then(function (queues) {
                    var channel = state.mq.channel;
                    var bindings = _.map(queues, function (queue) {
                        queue = queue.queue;
                        var matches = /(.+)\.(.+)/.exec(queue);
                        if (!matches) {
                            log.error('Skipping binding of queue %s. Queue name does not follow expected convention <EXCHANGE>.<QUEUE_NAME>.', queue);
                            return;
                        }
                        var exchange = matches[1];
                        var routingKey = matches[2];
                        log.debug('Binding queue %s to exchange %s with routing key %s.', queue, exchange, routingKey);
                        return channel.bindQueue(queue, exchange, routingKey);
                    });
                    return Promise.when(bindings);
                }).then(function () {
                    var filters = [];
                    _.each(EXCHANGES, function (exchange) {
                        if (exchange == DEAD_LETTER_EXCHANGE) return;
                        var filter = new BaleenReject(SESSIONS, exchange, 'REJECT');
                        filters.push(filter.start());
                    });
                    return Promise.when(filters);
                }).then(function () {
                    resolve(state);
                }).catch(function (error) {
                    log.error('Unable to setup RabbitMQ at %s: %s', state.mq.uri, error);
                    reject(error);
                }).finally(function () {
                    if (state.mq.channel) {
                        var chan = state.mq.channel;
                        state.mq.channel = undefined;
                        chan.close();
                    }
                });
        } catch (error) {
            log.error('Unable to connect to RabbitMQ at %s: %s', state.mq.uri, error);
            reject(error);
        }
    });
};

setupMq()
    .then(function (state) {
        return startSMTPServer(state);
    })
    .catch(function (error) {
        log.debug(error);
        log.error('Exiting on critical errors.');
        process.exit(1);
    });

function setupMq() {

}

function startSMTPServer(state) {
    var options = {
        name: 'baleen mail filter',
        banner: 'baleen mail filter ready',
        disabledCommands: 'AUTH',
        useXForward: true,
        onConnect: _.bind(onConnect, state),
        onData: _.bind(onData, state)
    };
    return new Promise(function (resolve) {
        state.smtpd = {};
        var server = new SMTPServer(options);
        server.on('error', onError);
        server.listen(10028, function () {
            log.info('Baleen Whale mail filter started.');
            state.smtpd.server = server;
            resolve(state);
        });
    });
}

function onError(error) {
    log.error(error);
}

function onConnect(session, callback) {
    var state = this;
    var session = {};

}

function onData(stream, serverSession, callback) {
    var state = this;
    var session = {};
    session.smtpdSession = serverSession;
    session.smtpdCallback = callback;
    do {
        var hash = crypto.createHash('sha256');
        hash.update(serverSession.id);
        hash.update("" + Math.random());
        hash.update("" + Date.now());
        session.id = hash.digest('hex').substr(0, 16).toUpperCase();
    } while (SESSIONS[session.id]);
    if (!state.mq || !state.mq.conn) {
        var smtpReply = new Error("Requested action aborted: local error in processing");
        smtpReply.responseCode = 451;
        callback(smtpReply);
    }
    state.mq.conn.createConfirmChannel().then(function (channel) {
        var msg = Bufffer.from(JSON.stringify(session));
        channel.publish()
    });
}
*/

var master = new Master();
master.start();
