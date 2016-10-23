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
var INCOMING_QUEUE = process.env.BALEEN_INCOMING_QUEUE || 'INCOMING';
var MASTER_EXCHANGE = 'MASTER';
var MASTER_QUEUES = ['DEFER', 'DELIVER', 'DISCARD', 'REJECT'];
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
	process.on('SIGTERM', function() {
		state.shutdown('Received SIGTERM.');
	});
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

Master.prototype.initSmtpServer = function () {
	this.smtpd = new SMTPServer(this);
	return this.smtpd.init();
};

Master.prototype.initMQ = function () {
	var state = this;
	state.mq = {};
	return new Promise(function (resolve, reject) {
		log.debug('Initializing message queue.');
		var channel = new ConfirmChannel();
		state.mq.channel = channel;
		return channel.create().then(function (chan) {
			var asserts = _.map(EXCHANGES, function (exchange) {
				log.debug('Using %s as initial routing key for new messages in exchange %s.', INCOMING_QUEUE, exchange);
				log.debug('Asserting existence of exchange %s at %s', exchange, channel.uri);
				return chan.assertExchange(exchange, 'direct', {durable: true});
			});
			log.debug('Asserting existence of master exchange %s at %s', MASTER_EXCHANGE, channel.uri);
			asserts.push(chan.assertExchange(MASTER_EXCHANGE, 'direct', {durable: true}));
			log.debug('Asserting existence of dead letter exchange %s at %s', DEAD_LETTER_EXCHANGE, channel.uri);
			asserts.push(chan.assertExchange(DEAD_LETTER_EXCHANGE, 'fanout', {durable: true}));
			return Promise.when(asserts);
		}).then(function () {
			return channel.create().then(function (chan) {
				var asserts = [];
				_.each(MASTER_QUEUES, function (queue) {
					queue = strfmt('%s.%s', MASTER_EXCHANGE, queue);
					log.debug('Asserting existence of queue %s in exchange %s at %s.', queue, MASTER_EXCHANGE, channel.uri);
					asserts.push(chan.assertQueue(queue, {durable: true}));
				});
				asserts.push(chan.assertQueue(strfmt('%s.%s', DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE), {durable: true}));
				return Promise.when(asserts);
			});
		}).then(function () {
			return channel.create().then(function (chan) {
				var bindings = [];
				_.each(MASTER_QUEUES, function (queue) {
					var routingKey = queue;
					queue = strfmt('%s.%s', MASTER_EXCHANGE, queue);
					log.debug('Binding routing key %s to queue %s.', routingKey, queue);
					bindings.push(chan.bindQueue(queue, MASTER_EXCHANGE, routingKey));
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

Master.prototype.shutdown = function (reason) {
	var state = this;
	var exitCode = 0;
	if (reason instanceof Error) {
		log.info('Shutting down master process. Error: %s', reason);
		log.debug(reason);
	} else {
		log.info('Shutting down master process. Reason: %s', reason);
		exitCode = 1;
	}
	var shutdowns = {};
	var shutdownCallback = function(name) {
		delete shutdowns[name];
		if ( _.size(shutdowns) == 0 ) {
			log.info("Shutdown of master process complete.");
			process.exit(exitCode);
		}
	};
	_.chain(state.consumers).keys().each(function(name) {
		var consumer = state.consumers[name];
		name = "consumer-"+name;
		if ( consumer && consumer.channel && consumer.consumerTag ) {
			shutdowns[name] = 1;
			consumer.channel.cancel(consumer.consumerTag).then(function() {
				shutdownCallback(name);
			}).catch(function() {
				shutdownCallback(name);
			})
		}
	});
	if ( state.mq.channel.channel ) {
		shutdowns['master'] = 1;
		state.mq.channel.channel.close().then(function() {
			shutdownCallback('master');
		}).catch(function() {
			shutdownCallback('master');
		});
	}
	if ( state.smtpd.server ) {
		shutdowns['smtpd'] = 1;
		state.mq.channel.channel.close(function() {
			shutdownCallback('smtpd');
		});
	}
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

Master.prototype._injectSessionForCheck = function (id, exchange, smtpCallback) {
	var state = this;
	state.mq.channel.create().then(function (channel) {
		var session = state.sessions[id];
		if (!session) {
			log.debug("Session %s is unknown to master.", id);
			smtpCallback(smtpError().log(id));
			return;
		}
		var queue = strfmt('%s.%s', exchange, INCOMING_QUEUE);
		channel.checkQueue(queue).then(function () {
			session.lastQueue = queue;
			var content = JSON.stringify(session);
			channel.publish(exchange, INCOMING_QUEUE, Buffer.from(content, "utf-8"), {
				persistent: true
			});
		}).catch(function (error) {
			log.debug('[%s] Queue %s not available, skipping the corresponding check: %s', id, queue, error);
			session.lastQueue = queue;
			var content = JSON.stringify(session);
			state.mq.channel.create().then(function(channel) {
				channel.publish("MASTER", "DELIVER", Buffer.from(content, "utf-8"), {
					persistent: true
				});
			});
		});
	}).catch(function (error) {
		log.debug('[%s] Error injecting message to queue %s.%s: %s', exchange, INCOMING_QUEUE, id, error);
		log.debug(error);
		smtpCallback(smtpError().log(id));
	});
};

Master.prototype.checkClient = function (id, smtpCallback) {
	this._injectSessionForCheck(id, "CHECK_CLIENT", smtpCallback);
};

Master.prototype.checkSender = function (id, smtpCallback) {
	this._injectSessionForCheck(id, "CHECK_SENDER", smtpCallback);
};

Master.prototype.checkRecipient = function (id, smtpCallback) {
	this._injectSessionForCheck(id, "CHECK_RECIPIENT", smtpCallback);
};

Master.prototype.checkMessage = function(id, smtpCallback) {
	this._injectSessionForCheck(id, "CHECK_MESSAGE", smtpCallback);
};

Master.prototype.startConsumer = function (queue, processFn) {
	var state = this;
	return new Promise(function (resolve, reject) {
		var consumerChannel = new ConfirmChannel();
		consumerChannel.create().then(function (channel) {
			log.debug('Starting consumer for queue %s at %s.', queue, consumerChannel.mq.displayUri);
			processFn = _.bind(processFn, state, channel);
			channel.consume(queue, processFn).then(function (consumer) {
				channel.on('close', function () {
					log.debug('Consumer for queue %s has been closed.', queue);
					state.shutdown(strfmt('Consumer for queue %s has been closed.', queue));
				});
				channel.on('error', function (error) {
					log.debug('Error in consumer for queue %s: %s', error);
					log.debug(error);
				});
				state.consumers[queue] = {
					consumerTag: consumer.consumerTag,
					consumerChannel: channel
				};
				resolve();
			}).catch(function (error) {
				log.error('Unable to setup consumer for dead letter queue %s: %s', queue, error);
				log.debug(error);
				reject(error);
			});
		}).catch(function (error) {
			log.error('Unable to setup consumer for dead letter queue %s: %s', queue, error);
			reject(error);
		});
	});
};

Master.prototype._processConsumerMessage = function (channel, queueName, msg) {
	var state = this;
	try {
		channel.ack(msg);
	} catch (error) {
		log.debug('Unable to acknowledge message in queue %s: %s', queueName, error);
		log.debug(error);
		return undefined;
	}
	var session;
	try {
		session = JSON.parse(msg.content.toString());
	} catch (error) {
		log.debug('Skipping unparseable message in queue %s: %s', queueName, error);
		return undefined;
	}
	if (!session || !session.id) {
		log.debug('Skipping empty session or session without an id in queue %s.');
		return undefined;
	}
	if (!state.sessions[session.id]) {
		log.debug('[%s] Skipping unknown session id in queue %s.', session.id, queueName);
		return undefined;
	}
	session.smtpCallback = state.sessions[session.id].smtpCallback;
	if (!session.smtpCallback) {
		log.debug('[%s] No smtp server callback function stored with this session.');
		return undefined;
	}
	state.sessions[session.id] = session;
	return session;
};

Master.prototype.processReject = function (channel, msg) {
	var state = this;
	var queueName = strfmt('%s.%s', MASTER_EXCHANGE, 'REJECT');
	var session = state._processConsumerMessage(channel, queueName, msg);
	if (!session) {
		return;
	}
	var responseCode = session.responseCode || 554;
	var responseMessage = session.responseMessage || 'Transaction failed';
	var rejectReason = session.status;
	log.debug('[%s] Message rejected by queue %s: %s', session.id, queueName, rejectReason);
	try {
		var reply = smtpError(responseCode, responseMessage).log();
		session.smtpCallback(reply);
	} catch (error) {
		log.debug('[%s] Error in smtp callback: %s', error);
		log.debug(error);
	}
	state.destroySession(session.id);
};

Master.prototype.processDiscard = function (channel, msg) {
	var state = this;
	var queueName = strfmt('%s.%s', MASTER_EXCHANGE, 'DISCARD');
	var session = state._processConsumerMessage(channel, queueName, msg);
	if (!session) {
		return;
	}
	var discardReason = session.status;
	log.debug('[%s] Message discarded by queue %s: %s', session.id, queueName, discardReason);
	try {
		session.smtpCallback();
	} catch (error) {
		log.debug('[%s] Error in smtp callback: %s', error);
		log.debug(error);
	}
	state.destroySession(session.id);
};

Master.prototype.processDefer = function (channel, msg) {
	var state = this;
	var queueName = strfmt('%s.%s', MASTER_EXCHANGE, 'DEFER');
	var session = state._processConsumerMessage(channel, queueName, msg);
	if (!session) {
		return;
	}
	var responseCode = session.responseCode || 421;
	var responseMessage = session.responseMessage || 'Message temporarily deferred.';
	var deferReason = session.status;
	log.debug('[%s] Message deferred by queue %s: %s', session.id, queueName, deferReason);
	try {
		var reply = smtpError(responseCode, responseMessage).log();
		session.smtpCallback(reply);
	} catch (error) {
		log.debug('[%s] Error in smtp callback: %s', error);
		log.debug(error);
	}
	state.destroySession(session.id);
};

Master.prototype.processDeliver = function(channel, msg) {
	var state = this;
	var queueName = strfmt('%s.%s', MASTER_EXCHANGE, 'DELIVER');
	var session = state._processConsumerMessage(channel, queueName, msg);
	if (!session) {
		return;
	}
	var lastQueue = session.lastQueue;
	var matches = /([^\.]+)\..+/.exec(lastQueue);
	if ( !matches ) {
		log.debug('[%s] Invalid format for { session.lastQueue }: %s', session.id, lastQueue);
		session.smtpCallback(smtpError().log());
		return;
	}
	var exchange = matches[1];
	var index = _.indexOf(EXCHANGES, exchange);
	if ( index == -1 ) {
		log.debug('[%s] Unknown exchange %s in session.lastQueue when processing delivery of message.', session.id, session.lastQueue);
		session.smtpCallback(smtpError().log());
		return;
	}
	if ( _.last(EXCHANGES) == exchange ) {
		state.smtpd.relay(session.id).then(function() {
			log.info("[%s] Successfully delivered message.", session.id);
			session.smtpCallback();
		}).catch(function(error) {
			log.info("[%s] Delivery of message failed.", session.id);
			session.smtpCallback(smtpError().log());
		});
	} else {
		log.debug('[%s] Delivering message to next processing stage from %s.', session.id, queueName);
		session.smtpCallback();
	}
};

Master.prototype.processDeadLetter = function (channel, msg) {
	var state = this;
	var queueName = strfmt('%s.%s', DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE);
	var session = state._processConsumerMessage(channel, queueName, msg);
	if (!session) {
		return;
	}
	log.error('[%s] Entered dead letter queue from last queue %s.', session.id, session.lastQueue);
	log.debug('Removing stale queue %s.', session.lastQueue);
	try {
		channel.deleteQueue(session.lastQueue);
	} catch (error) {
		log.debug('Unable to acknowledge message in queue %s: %s', queueName, error);
		log.debug(error);
	}
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


Master.prototype.run = function () {
	var processes = [];
	processes.push(this.smtpd.start());
	var queue = strfmt('%s.%s', DEAD_LETTER_EXCHANGE, DEAD_LETTER_QUEUE);
	processes.push(this.startConsumer(queue, this.processDeadLetter));
	queue = strfmt('%s.%s', MASTER_EXCHANGE, 'REJECT');
	processes.push(this.startConsumer(queue, this.processReject));
	queue = strfmt('%s.%s', MASTER_EXCHANGE, 'DEFER');
	processes.push(this.startConsumer(queue, this.processDefer));
	queue = strfmt('%s.%s', MASTER_EXCHANGE, 'DISCARD');
	processes.push(this.startConsumer(queue, this.processDiscard));
	queue = strfmt('%s.%s', MASTER_EXCHANGE, 'DELIVER');
	processes.push(this.startConsumer(queue, this.processDeliver));
	return Promise.when(processes);
};

new Master().start();
