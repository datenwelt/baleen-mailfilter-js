var amqplib = require('amqplib');
var bunyan = require('bunyan');
var crypto = require('crypto');
var Promise = require('cargo-js/dist/promise.js');
var strfmt = require('util').format;
var _ = require('underscore');

var BaleenReject = require('./master/reject.js');
var ConfirmChannel = require('./lib/rabbitmq.js').ConfirmChannel;
var SMTPServer = require('./lib/smtp.js').Server;
var smtpError = require('./lib/smtp.js').smtpError;

var EXCHANGES = ['CHECK_CLIENT', 'CHECK_SENDER', 'CHECK_RECIPIENT', 'CHECK_MESSAGE'];
var QUEUES = ['DEFER', 'DELIVER', 'DISCARD', 'INCOMING', 'REJECT'];
var DEAD_LETTER_EXCHANGE = 'DEAD_LETTERS';
var DEAD_LETTER_QUEUE = 'HOLD';

var log = bunyan.createLogger({name: 'baleen.master'});
log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');

function Master() {
	this.mq = false;
	this.smtpd = false;
	this.sessions = {};
	this.queues = false;
	this.consumers = {};
	return this;
}

Master.prototype.start = function () {
	var state = this;
	log.info('Starting baleen mail filter master process.');
	return state.init()
	.then(function () {
		return state.run();
	})
	.catch(function (error) {
		log.error("Aborting master startup due to previous errors: %s", error);
		log.debug(error);
		process.exit(1);
	});
};

Master.prototype.init = function () {
	return Promise.when([this.initMQ(), this.initSmtpServer()]);
};

Master.prototype.initMQ = function () {
	var state = this;
	state.mq = {};
	return new Promise(function (resolve, reject) {
		log.debug('Initializing message queue at %s.', process.env.BALEEN_RABBITMQ_URI);
		var channel = new ConfirmChannel();
		state.mq.channel = channel;
		return channel.create().then(function (chan) {
			var asserts = _.map(EXCHANGES, function (exchange) {
				log.debug('Asserting existence of exchange %s at %s', exchange, channel.uri);
				return chan.assertExchange(exchange, 'direct', {durable: true});
			});
			log.debug('Asserting existence of dead letter exchange %s at %s', DEAD_LETTER_EXCHANGE, channel.uri);
			asserts.push(chan.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {durable: true}));
			return Promise.when(asserts);
		}).then(function () {
			return channel.create().then(function (chan) {
				var asserts = [];
				_.each(EXCHANGES, function (exchange) {
					_.each(QUEUES, function (queue) {
						queue = strfmt('%s.%s', exchange, queue);
						log.debug('Asserting existence of queue %s in exchange %s at %s.', queue, exchange, channel.uri);
						asserts.push(chan.assertQueue(queue, {
							'durable': true,
							arguments: {
								'x-message-ttl': 15000,
								'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE
							}
						}));
					});
				});
				asserts.push(chan.assertQueue(strfmt('%s.%s', DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE), {durable: true}));
				return Promise.when(asserts);
			});
		}).then(function () {
			return channel.create().then(function (chan) {
				var bindings = [];
				_.each(EXCHANGES, function (exchange) {
					_.each(QUEUES, function (queue) {
						var routingKey = queue;
						queue = strfmt('%s.%s', exchange, queue);
						log.debug('Binding routing key %s to queue %s.', routingKey, queue);
						bindings.push(chan.bindQueue(queue, exchange, routingKey));
					});
				});
				var deadLetterQueueName = strfmt('%s.%s', DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE);
				log.debug('Binding routing key %s to queue %s.', DEAD_LETTER_QUEUE, deadLetterQueueName);
				bindings.push(chan.bindQueue(deadLetterQueueName, DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE));
				return Promise.when(bindings);
			});
		}).then(function () {
			resolve(state);
		}).catch(function (error) {
			log.error('Unable to initialize message queue at %s: %s', channel.uri, error);
			reject(error);
		});

	});
};

Master.prototype.createSession = function () {
	var state = this;
	var session = {};
	do {
		var hash = crypto.createHash('sha256');
		hash.update("" + Math.random());
		hash.update("" + Date.now());
		session.id = hash.digest('hex').substr(0, 16).toUpperCase();
	} while (state.sessions[session.id]);
	state.sessions[session.id] = session;
	return session;
};

Master.prototype.getSession = function (id) {
	return this.sessions[id];
};

Master.prototype.destroySession = function (id) {
	var state = this;
	return new Promise(function (resolve) {
		delete state.sessions[id];
		resolve();
	});
};

Master.prototype.checkClient = function (id) {
	var state = this;
	state.mq.channel.create().then(function (channel) {
		var session = state.sessions[id];
		if (!session) {
			log.debug("Session %s is unknown to master.", id);
			return;
		}
		session.lastQueue = "CHECK_CLIENT.INCOMING";
		var content = JSON.stringify(session);
		channel.publish("CHECK_CLIENT", "INCOMING", Buffer.from(content, "utf-8"), {
			persistent: true
		});
	}).catch(function(error) {
		log.debug('[%s] Error injecting message to queue CHECK_CLIENT.INCOMING: %s', id, error);
		log.debug(error);
	});
};

Master.prototype.processDeadLetters = function (id) {
	var state = this;
	var queueName = strfmt('%s.%s', DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE);
	var processMessage = function (msg) {
		state.mq.channel.create().then(function (chan) {
			chan.ack(msg);
		});
		var session;
		try {
			session = JSON.parse(msg.content.toString());
		} catch (error) {
			log.debug('Skipping unparseable dead letter in queue %s: %s', queueName, error);
			return;
		}
		if (!session || !session.id) {
			log.debug('Skipping empty session or session without an id in queue %s.');
			return;
		}
		if (!state.sessions[session.id]) {
			log.debug('[%s] Skipping unknown session id in queue %s.', session.id, queueName);
			return;
		}
		session.smtpCallback = state.sessions[session.id].smtpCallback;
		state.sessions[session.id] = session;
		log.error('[%s] Entered dead letter queue from last queue %s.', session.id, session.lastQueue);
		if (session.smtpCallback) {
			try {
				var reply = smtpError();
				log.info('[%s] Disconnecting with reply: %d %s', session.id, reply.responseCode, reply.message);
				session.smtpCallback(reply);
			} catch (error) {
				log.debug('[%s] Error in smtp callback: %s', error);
				log.debug(error);
			}
		}
		state.destroySession(session.id);
	};
	return new Promise(function (resolve, reject) {
		state.mq.channel.create().then(function (chan) {
			var consumer = chan.consume(queueName, processMessage).then(function(consumer) {
				state.consumers[queueName] = consumer.consumerTag;
			}).catch(function (error) {
				log.error('Unable to setup consumer for dead letter queue %s: %s', queueName, error);
				log.debug(error);
			});
		});
	});
};


Master.prototype.initSmtpServer = function () {
	this.smtpd = new SMTPServer(this);
	return this.smtpd.init();
};

Master.prototype.run = function () {
	return Promise.when([this.smtpd.start(),
		this.processDeadLetters()]);
};

new Master().start();
