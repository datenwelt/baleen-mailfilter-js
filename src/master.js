var amqplib = require('amqplib');
var bunyan = require('bunyan');
var crypto = require('crypto');
var Promise = require('cargo-js/dist/promise.js');
var SMTPServer = require('smtp-server').SMTPServer;
var strfmt = require('util').format;
var _ = require('underscore');

var BaleenReject = require('./master/reject.js');
var Connection = require('./lib/rabbitmq.js').Connection;

var EXCHANGES = ['CHECK_CLIENT', 'CHECK_SENDER', 'CHECK_RECIPIENT', 'CHECK_MESSAGE'];
var QUEUES = ['DEFER', 'DELIVER', 'DISCARD', 'INCOMING', 'REJECT'];
var DEAD_LETTER_EXCHANGE = 'DEAD_LETTERS';
var DEAD_LETTER_QUEUE = 'HOLD';

var log = bunyan.createLogger({name: 'baleen-master'});
log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');

function Master() {
    this.mq = {};
    return this;
}

Master.prototype.start = function () {
    var state = this;
    return state.init()
        .run()
        .catch(function (error) {
            log.error("Exiting due to previous errors.");
            log.debug(error);
            process.exit(1);
        });
};

Master.prototype.init = function () {
    return Promise.when([this.initMQ()]);
};

Master.prototype.initMQ = function () {
    var state = this;
    log.debug('Initializing message queue at %s.', state.mq.uri);
    return new Promise(function (resolve, reject) {
        if (!process.env.BALEEN_RABBITMQ_URI) {
            throw new Error("Environment variable BALEEN_RABBITMQ_URI is empty. Please set the URI of your Connection instance.");
        }

        state.mq = new Connection(process.env.BALEEN_RABBITMQ_URI, {heartbeat: 15});
        state.mq.exchanges = EXCHANGES;
        state.mq.queue = QUEUES;
        state.mq.deadLetterExchange = DEAD_LETTER_EXCHANGE;
        state.mq.deadLetterQueue = DEAD_LETTER_QUEUE;
        state.mq.connect().then(function () {
            state.mq.newChannel().then(function (channel) {
                state.mq.channel = channel;
                return channel.create();
            }).then(function (chan) {
                var asserts = _.map(EXCHANGES, function (exchange) {
                    log.debug('Asserting existence of exchange %s at %s', exchange, state.mq.uri);
                    return chan.assertExchange(exchange, 'direct', {durable: true});
                });
                log.debug('Asserting existence of dead letter exchange %s at %s', DEAD_LETTER_EXCHANGE, state.mq.uri);
                asserts.push(chan.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {durable: true}));
                return Promise.when(asserts);
            }).then(function () {
                return state.mq.channel.create().then(function (chan) {
                    var asserts = [];
                    _.each(EXCHANGES, function (exchange) {
                        _.each(QUEUES, function (queue) {
                            queue = strfmt('%s.%s', exchange, queue);
                            log.debug('Asserting existence of queue %s in exchange %s at %s.', queue, exchange, state.mq.uri);
                            asserts.push(chan.assertQueue(queue, {
                                'durable': true,
                                'arguments': {
                                    'messageTtl': 15000,
                                    'deadLetterExchange': DEAD_LETTER_EXCHANGE
                                }
                            }));
                        });
                    });
                    asserts.push(chan.assertQueue(strfmt('%s.%s', DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE), {durable: true}));
                    return Promise.when(asserts);
                });
            }).then(function () {
                return state.mq.channel.create().then(function (chan) {
                    var bindings = [];
                    _.each(EXCHANGES, function (exchange) {
                        _.each(QUEUES, function (queue) {
                            var routingKey = queue;
                            queue = strfmt('%s.%s', exchange, queue);
                            log.debug('Binding routing key %s to queue %s.', routingKey, queue);
                            bindings.push(chan.bindQueue(queue, exchange, routingKey));
                        });
                    });
                    return Promise.when(bindings);
                });
            }).then(function () {
                resolve(state);
            }).catch(function (error) {
                log.error('Unable to initialize message queue: %s', error);
                reject(error);
            });
        });
    });
};

Master.prototype.run = function() {

};

/*
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

new Master().start();
