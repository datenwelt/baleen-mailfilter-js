var _ = require('underscore');
var amqplib = require('amqplib');
var bunyan = require('bunyan');
var URI = require('urijs');


module.exports.Connection = Connection;
module.exports.Channel = Channel;

Connection.prototype.constructor = Connection;

/**
 * Create a new Connection object.
 * @param uri The Connection URI to connect to.
 * @param options Options for the Connection connection.
 * @param log An optional (bunyan-style) logger instance.
 * @constructor
 */
function Connection(uri, options, log) {
    var state = this;
    options = options || {};
    if (!uri) {
        throw new Error("Parameter #1 (uri) missing or empty.");
    }
    try {
        uri = new URI(uri);
    } catch (error) {
        throw new Error("Parameter #1 (uri='%s') cannot be parsed: %s", uri, error);
    }
    if (!uri.scheme() == "amqp" || uri.scheme() == "amqps") {
        throw new Error("Parameter #1 (uri='%s') is not a valid Connection URI. URI must start with 'amqp(s)://'.");
    }
    if (!log) {
        log = bunyan.createLogger({name: 'baleen.rabbitmq'});
        log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');
    }
    state.log = log;

    state.uri = uri;
    state.uri.query(options);
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
            state.log.debug('Connecting to message queue at %s.', state.displayUri);
            return amqplib.connect(state.uri.toString())
                .then(function (conn) {
                    /* Connect to the MQ */
                    state.conn = conn;
                    state.conn.on('close', _.bind(state.onClose, state));
                    state.conn.on('error', _.bind(state.onError, state));
                    state.log.error('Connected to Connection at %s.', state.displayUri);
                    resolve(state.conn);
                }).catch(function (error) {
                    state.log.error('Unable to connect to Connection at %s: %s', state.displayUri, error);
                    reject(error);
                });
        } catch (error) {
            state.log.error('Unable to connect to Connection at %s: %s', this.toString(), error);
            reject(error);
        }
    });
};

Connection.prototype.newChannel = function () {
    var state = this;
    return new Promise(function(resolve, reject) {
        state.connect().then(function () {
            var channel = new Channel(state, false);
            channel.create().then(function() {
                resolve(channel);
            }).catch(function(error) {
                reject(error);
            });
        });
    });
};

Connection.prototype.newConfirmChannel = function () {
    var state = this;
    return new Promise(function(resolve, reject) {
        state.connect().then(function () {
            var channel = new Channel(state, true);
            channel.create().then(function() {
                resolve(channel);
            }).catch(function(error) {
                reject(error);
            });
        });
    });
};

Connection.prototype.onClose = function (error) {
    this.conn = undefined;
    if (error) {
        this.log.debug('Connection broker at %s has closed connection. Reason: %s', this.displayUri, error);
    } else {
        this.log.debug('Connection to %s closed.', this.displayUri);
    }
};

Connection.prototype.onError = function (error) {
    this.conn = undefined;
    this.log.debug('Connection broker at %s has closed connection with error: %s', this.displayUri, error);
};

Connection.prototype.toString = function () {
    return this.displayUri;
};

Channel.prototype.constructor = Channel;

function Channel(mq, confirm) {
    this.mq = mq;
    this.channel = undefined;
    this.confirm = confirm;
}

Channel.prototype.create = function () {
    var state = this;
    if (state.channel) {
        return Promise.resolve(state.channel);
    }
    return new Promise(function (resolve, reject) {
        state.mq.connect()
            .then(function () {
                if (state.confirm) {
                    state.mq.conn.createConfirmChannel().then(function (channel) {
                        state.channel = channel;
                        resolve(channel);
                    });
                } else {
                    state.mq.conn.createChannel().then(function (channel) {
                        state.channel = channel;
                        state.channel.on('close', _.bind(state.onClose, state));
                        state.channel.on('error', _.bind(state.onError, state));
                        resolve(channel);
                    });
                }
            })
            .catch(function (error) {
                state.mq.log.error(error, 'Unable to create new channel for broker %s: %s', state.mq.displayUri, error);
                reject(error);
            });
    });
};

Channel.prototype.onError = function (error) {
    this.channel = undefined;
    this.mq.log.debug('Channel for broker %s has been closed with error: %s', this.mq.displayUri, error);
};

Channel.prototype.onClose = function () {
    this.channel = undefined;
    this.mq.log.debug('Channel for broker %s has been closed.', this.mq.displayUri);
};

Channel.prototype.close = function () {
    this.channel.close();
    this.channel = undefined;
    this.mq.log.debug('Closing channel for broker %s.', this.mq.displayUri);
};


