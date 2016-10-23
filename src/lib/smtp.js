var Buffer = require('buffer').Buffer;
var bunyan = require('bunyan');
var crypto = require('crypto');
var SMTPConnection = require('smtp-connection');
var SMTPServer = require('smtp-server').SMTPServer;
var strfmt = require('util').format;
var URI = require('urijs');
var _ = require('underscore');

module.exports.Server = Server;
module.exports.smtpError = smtpError;

var log = bunyan.createLogger({name: 'baleen.smtp'});
log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');

Server.prototype.constructor = Server;

function Server(master) {
	this.sessions = {};
	this.master = master;
	return this;
}

Server.prototype.init = function () {
	var state = this;
	delete state.smtpd;
	return new Promise(function (resolve) {
		state.address = process.env.BALEEN_SMTPD_LISTEN || '0.0.0.0:10028';
		log.debug('Initializing smtp server at %s.', state.address);
		var matches = /(.+)?:(\d+)/.exec(state.address);
		if (!matches) {
			throw new Error(strfmt('Invalid value ("%s") for BALEEN_SMTPD_LISTEN. The value must at least specify a port number in the format ":PORT".', state.address));
		}
		state.host = matches.length == 2 ? '0.0.0.0' : matches[1];
		state.port = matches.length == 2 ? matches[1] : matches[2];
		resolve(state);
	});
};

Server.prototype.start = function () {
	var state = this;
	var options = {
		disabledCommands: 'AUTH',
		useXForward: true,
		onConnect: _.bind(state.onConnect, state),
		onMailFrom: _.bind(state.onMailFrom, state),
		onRcptTo: _.bind(state.onRcptTo, state),
		onData: _.bind(state.onData, state),
		onClose: _.bind(state.onClose, state)
	};
	return new Promise(function (resolve, reject) {
		state.smtpd = {};
		state.smtpd.server = new SMTPServer(options);
		var errBack = function (error) {
			log.debug('Unable to start smtp server at %s: %s', state.address, error);
			reject(error);
		};
		state.smtpd.onClose = _.bind(state.onClose, state);
		state.smtpd.server.on('close', state.smtpd.onClose);
		state.smtpd.onError = _.bind(state.onError, state);
		state.smtpd.server.on('error', _.bind(errBack, state));

		try {
			state.smtpd.server.listen(state.port, state.host, function () {
				log.debug('Smtp server listening at %s', state.address);
				state.smtpd.server.removeListener('on', errBack);
				state.smtpd.server.on('error', state.smtpd.onError);
				resolve(state);
			});
		} catch (error) {
			log.debug('Unable to start smtp server at %s: %s', this.address, error);
			state.smtpd.server.removeListener('on', errBack);
			state.smtpd.server = undefined;
			reject(error);
		}

	});
};

Server.prototype.onError = function (error) {
	log.debug('Closing smtp server on error: %s', error);
	this.master.shutdown();
};

Server.prototype.onClose = function () {
	log.debug('Smtp server at %s closed.', state.address);
	this.smtpd.server.removeListener('close', this.smtpd.onClose);
	this.smtpd.server.removeListener('error', this.smtpd.onError);
	delete this.smtpd.server;
	delete this.smtpd;
	this.master.shutdown();
};

/**
 *
 * @param smtpinfo
 * @param smtpinfo.id
 * @param smtpinfo.remoteAddress
 * @param smtpinfo.xforward
 * @param ready
 */
Server.prototype.onConnect = function (smtpinfo, ready) {
	var state = this;
	var client = {
		address: smtpinfo.remoteAddress,
		info: smtpinfo.remoteAddress
	};
	if (smtpinfo.xforward && smtpinfo.xforward.client) {
		client = {
			address: smtpinfo.xforward.client,
			proxy: smtpinfo.remoteAddress,
			info: strfmt('%s (via %s)', smtpinfo.xforward.client, smtpinfo.remoteAddress)
		}
	}
	var session = state.master.createSession();
	state.sessions[smtpinfo.id] = session.id;
	session.client = client;
	session.smtpInfo = smtpinfo;
	session.smtpCallback = ready;
	log.info('[%s] Connect from client %s.', session.id, client.info);
	try {
		state.master.checkClient(session.id, ready);
	} catch (error) {
		log.debug('[%s] Error checking client of message: %s', session.id, error);
		log.debug(error);
		state.master.destroySession(session.id);
		ready(smtpError());
	}
};

Server.prototype.onMailFrom = function (address, smtpinfo, ready) {
	var state = this;
	var sessionId = state.sessions[smtpinfo.id];
	if (!sessionId) {
		log.debug('Skipping unknown smtp session id: %s', smtpinfo.id);
		ready(smtpError().log());
		return;
	}
	var session = state.master.getSession(sessionId);
	if (!session) {
		log.debug('Skipping unknown session: %s', sessionId);
		ready(smtpError().log());
		return;
	}
	session.sender = address.address;
	session.smtpInfo = smtpinfo;
	session.smtpCallback = ready;
	log.info('[%s] from=%s args=%j', session.id, session.sender, address.args);
	try {
		state.master.checkSender(session.id, ready);
	} catch (error) {
		log.debug('[%s] Error checking sender of message: %s', session.id, error);
		log.debug(error);
		state.master.destroySession(session.id);
		ready(smtpError());
	}
};

Server.prototype.onRcptTo = function (address, smtpinfo, ready) {
	var state = this;
	var sessionId = state.sessions[smtpinfo.id];
	if (!sessionId) {
		log.debug('Skipping unknown smtp session id: %s', smtpinfo.id);
		ready(smtpError().log());
		return;
	}
	var session = state.master.getSession(sessionId);
	if (!session) {
		log.debug('Skipping unknown session: %s', sessionId);
		ready(smtpError().log());
		return;
	}
	session.recipient = address.address;
	session.recipients = session.recipients || [];
	session.recipients.push(address.address);
	session.smtpInfo = smtpinfo;
	session.smtpCallback = ready;
	log.info('[%s] to=%s args=%j', session.id, session.recipient, address.args);
	try {
		state.master.checkRecipient(session.id, ready);
	} catch (error) {
		log.debug('[%s] Error checking recipient of message: %s', session.id, error);
		log.debug(error);
		state.master.destroySession(session.id);
		ready(smtpError());
	}
};

Server.prototype.onData = function (stream, smtpinfo, ready) {
	var state = this;
	var sessionId = state.sessions[smtpinfo.id];
	if (!sessionId) {
		log.debug('Skipping unknown smtp session id: %s', smtpinfo.id);
		ready(smtpError().log());
		return;
	}
	var session = state.master.getSession(sessionId);
	if (!session) {
		log.debug('Skipping unknown session: %s', sessionId);
		ready(smtpError().log());
		return;
	}
	var buffers = [];
	var bufferTotal = 0;
	stream.on('close', function () {
		log.debug('[%s] Content stream was closed unexpectedly.', session.id);
		stream.removeAllListeners();
		ready(smtpError().log());
	});
	stream.on('error', function (error) {
		log.debug('[%s] Error in content stream: %s', session.id, error);
		stream.removeAllListeners();
		ready(smtpError().log());
	});
	stream.on('end', function () {
		log.info('[%s] Received %d bytes of message data.', session.id, bufferTotal);
		var content = Buffer.alloc(bufferTotal);
		var pos = 0;
		_.each(buffers, function (buffer) {
			buffer.copy(content, pos);
			pos += buffer.length;
		});
		session.content = content.toString('utf8');
		state.master.checkMessage(session.id, ready);
	});
	stream.on('data', function (buffer) {
		buffers.push(buffer);
		bufferTotal += buffer.length;
	});
	delete session.recipient;
	session.smtpInfo = smtpinfo;
	session.smtpCallback = ready;
};

Server.prototype.onClose = function (smtpinfo) {
	var state = this;
	var sessionId = state.sessions[smtpinfo.id];
	if (!sessionId) {
		log.debug('Unable to close unknown smtp session id: %s', smtpinfo.id);
		ready(smtpError().log());
		return;
	}
	var session = state.master.getSession(sessionId);
	if (!session) {
		log.debug('Unable to close unknown session: %s', sessionId);
		return;
	}
	state.master.destroySession(session.id);
	log.info('[%s] Client connection closed.', session.id);
};

Server.prototype.relay = function (id) {
	var state = this;
	var session = state.master.getSession(id);
	return new Promise(function (resolve, reject) {
		if (!session) {
			log.debug('Unable to relay message for unknown session: %s', id);
			reject("Relaying failed due to local errors.");
			return;
		}
		var uri = process.env.BALEEN_SMTPOUT_URI || "localhost:10029";
		try {
			uri = new URI(uri);
		} catch (error) {
			log.error('[%s] Unable to relay message, unparseable URI for outgoing STMP server: %s', id, error);
			log.debug(error);
			reject("Relaying failed due to local errors.");
			return;
		}
		var scheme = uri.scheme() || "smtp";
		if ( scheme != 'smtp' && scheme !='smtps' ) {
			log.error('[%s] Unable to relay message, invalid URI for outgoing SMTP server: Scheme part must be either "smtp:" or "smpts:".');
			reject("Relaying failed due to local errors.");
			return;
		}
		var server = uri.hostname();
		var port = uri.port() || ( scheme == 'smtp' ? 25 : 465);
		var secure = scheme == 'smtps';
		var username = uri.username();
		var password = uri.password();
		var connection = new SMTPConnection({
			host: server,
			port: port,
			secure: secure,
			opportunisticTls: true,
			authMethod: 'PLAIN',
			tls : { rejectUnauthorized: false }
		});
		connection.on('error', function(error) {
			log.error('[%s] Unable to relay message. Error during SMTP connection: %s', id, error);
			log.debug(error);
			reject("Relaying failed due to SMTP error: " + error);
			connection.quit();
		});
		connection.connect(function() {
			var transmitMessage = function() {
				var envelope = {};
				envelope.from = session.from;
				envelope.to = session.recipients;
				envelope.size = session.content.length;
				connection.send(envelope, session.content, function(err, info) {
					if ( err ) {
						log.error('[%s] Unable to relay message. Remote server said: %s', id, err.response);
						log.debug(err.response);
						var matches = /^((\d{3})\s+)/.exec(err.response);
						if ( matches ) {
							var responseCode = new Number(matches[1]);
							var responseMessage = err.response.substr(matches[2].length);
							reject(smtpError(responseCode, responseMessage));
						} else {
							reject();
						}
					} else {
						if ( info.rejected ) {
							_.each(info.rejected, function(addr, idx) {
								var msg = strfmt('[%s] Relaying failed for rcpt=%s, reason=%s', id, addr, info.rejectedErrors[idx]);
								log.warn(msg);
							});
						}
						log.info('[%s] Relayed to [%s:%d]: %s', id, server, port, info.response);
						resolve();
					}
					connection.quit();
				});
			};
			if ( username ) {
				connection.login({ user: username, pass: password}, function(err) {
					if ( err ) {
						log.error('[%s] Unable to relay message. Authentication with remote server failed: %s', id, err);
						reject(err);
						connection.close();
						return;
					}
					transmitMessage();
				});
			} else {
				transmitMessage();
			}
		});
	});
};

function smtpError() {
	var message = 'Transient internal server error. Please try again later.';
	var code = 421;
	_.each(arguments, function (arg) {
		if (_.isString(arg)) {
			message = arg;
		}
		if (_.isNumber(arg) && arg > 0) {
			code = arg;
		}
	});
	var smtpError = new Error(message);
	smtpError.responseCode = code;
	smtpError.log = function (id) {
		log.info('[%s] Disconnecting with reply: %d %s', id, this.responseCode, this.message);
		return this;
	};
	return smtpError;
}
