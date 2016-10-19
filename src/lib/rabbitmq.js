var _ = require('underscore');
var amqplib = require('amqplib');
var bunyan = require('bunyan');
var URI = require('urijs');
var strfmt = require('util').format;

var log = bunyan.createLogger({name: 'baleen.rabbitmq'});
log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');

module.exports.Connection = Connection;
module.exports.Channel = Channel;
module.exports.ConfirmChannel = ConfirmChannel;

Connection.prototype.constructor = Connection;

/**
 * Create a new Connection object.
 * @param uri The Connection URI to connect to.
 * @param options Options for the Connection connection.
 * @param log An optional (bunyan-style) logger instance.
 * @constructor
 */
function Connection() {
	if (!process.env.BALEEN_RABBITMQ_URI) {
		throw new Error("Environment variable BALEEN_RABBITMQ_URI is empty. Please set the URI of your Connection instance.");
	}
	try {
		var uri = new URI(process.env.BALEEN_RABBITMQ_URI);
	} catch (error) {
		throw new Error('Environment variable BALEEN_RABBITMQ_URI ("%s") cannot be parsed as RabbitMQ URI. Please set the URI of your RabbitMQ instance.');
	}
	var state = this;
	if (!uri.scheme() == "amqp" || uri.scheme() == "amqps") {
		throw new Error('Environment variable BALEEN_RABBITMQ_URI is not a valid Connection URI. URI must start with "amqp(s)://".');
	}

	this.uri = uri;
	this.uri.query({heartbeat: 15});
	this.displayUri = uri.clone();
	this.displayUri.query({});
	if (this.displayUri.password()) {
		this.displayUri.password('xxx');
	}
	this.conn = undefined;
}

Connection.prototype.connect = function () {
	var state = this;
	if (state.conn) {
		return Promise.resolve(state.conn);
	}
	return new Promise(function (resolve, reject) {
		try {
			log.debug('Connecting to message queue at %s.', state.displayUri);
			return amqplib.connect(state.uri.toString()).then(function (conn) {
				/* Connect to the MQ */
				state.conn = conn;
				state.conn.on('close', _.bind(state.onClose, state));
				state.conn.on('error', _.bind(state.onError, state));
				log.debug('Connected to message queue at %s.', state.displayUri);
				resolve(state.conn);
			}).catch(function (error) {
				log.error('Unable to connect to message queue at %s: %s', state.displayUri, error);
				reject(error);
			});
		} catch (error) {
			log.error('Unable to connect to message queue at %s: %s', this.toString(), error);
			reject(error);
		}
	});
};

Connection.prototype.onClose = function (error) {
	this.conn = undefined;
	if (error) {
		log.debug('Connection broker at %s has closed connection. Reason: %s', this.displayUri, error);
	} else {
		log.debug('Connection to %s closed.', this.displayUri);
	}
};

Connection.prototype.onError = function (error) {
	this.conn = undefined;
	log.debug('Connection broker at %s has closed connection with error: %s', this.displayUri, error);
};


Channel.prototype.constructor = Channel;

function Channel() {
	this.mq = new Connection();
	this.uri = this.mq.displayUri.toString();
	this.channel = undefined;
	this.confirm = false;
}

Channel.prototype.create = function () {
	var state = this;
	if (state.channel) {
		return Promise.resolve(state.channel);
	}
	return new Promise(function (resolve, reject) {
		state.mq.connect().then(function () {
			var thenFn = function (channel) {
				state.channel = channel;
				state.channel.on('close', _.bind(state.onClose, state));
				state.channel.on('error', _.bind(state.onError, state));
				resolve(channel);
			};
			if (state.confirm) {
				state.mq.conn.createConfirmChannel().then(thenFn).catch(function(error) {
					log.error(error, 'Unable to create new channel for broker %s: %s', state.mq.displayUri, error);
					reject(error);
				});
			} else {
				state.mq.conn.createChannel().then(thenFn).catch(function(error) {
					log.error(error, 'Unable to create new channel for broker %s: %s', state.mq.displayUri, error);
					reject(error);
				});
			}
		})
		.catch(function (error) {
			log.error(error, 'Unable to create new channel for broker %s: %s', state.mq.displayUri, error);
			reject(error);
		});
	});
};

Channel.prototype.onError = function (error) {
	this.channel = undefined;
	log.debug('Channel for broker %s has been closed with error: %s', this.mq.displayUri, error);
};

Channel.prototype.onClose = function () {
	this.channel = undefined;
	log.debug('Channel for broker %s has been closed.', this.mq.displayUri);
};

Channel.prototype.close = function () {
	this.channel.close();
	this.channel = undefined;
	log.debug('Closing channel for broker %s.', this.mq.displayUri);
};

Channel.prototype.toString = function() {
	return this.mq.displayUri;
};

ConfirmChannel.prototype = Object.create(Channel.prototype);
ConfirmChannel.prototype.constructor = ConfirmChannel;

function ConfirmChannel() {
	Channel.apply(this);
	this.confirm = true;
	return this;
}