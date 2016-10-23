var Buffer = require('buffer');
var bunyan = require('bunyan');
var crypto = require('crypto');
var SMTPServer = require('smtp-server').SMTPServer;
var strfmt = require('util').format;
var _ = require('underscore');

module.exports.Server = Server;
module.exports.smtpError = smtpError;

var log = bunyan.createLogger({name: 'baleen.smtp'});
log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');

Server.prototype.constructor = Server;

function Server(master) {
	this.sessions = {};
	this.master = master;
	this.suspended = false;
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

Server.prototype.stop = function () {
	this._cleanup();
};

Server.prototype.suspend = function (message, code) {
	var state = this;
	if (!this.smtpd || !this.smtpd.server) {
		return Promise.resolve(this);
	}
	message = message || 'Server is currently undergoing an unscheduled maintenance. Please try again later.';
	code = code || 421;
	return new Promise(function (resolve) {
		log.info('Smtp server suspended with message: %d %s', code, message);
		state.suspended = {
			message: message,
			code: code
		};
		resolve(state);
	});

};

Server.prototype.resume = function () {
	if (this.suspended) {
		log.info('Smtp server resumed after suspension.');
		delete this.suspended;
	}
	return Promise.resolve(this);
};

Server.prototype._cleanup = function () {
	var state = this;
	if (state.smtpd) {
		if (state.smtpd.server) {
			state.smtpd.server.close(function (server) {
				server.removeListener('close', state.smtpd.onClose);
				server.removeListener('error', state.smtpd.onError);
			});
			delete state.smtpd.server;
		}
		delete state.smtpd;
	}
};

Server.prototype.onError = function (error) {
	log.debug('Closing smtp server on error: %s', error);
	this._cleanup();
};

Server.prototype.onClose = function () {
	log.debug('Smtp server at %s closed.', state.address);
	this.smtpd.server.removeListener('close', this.smtpd.onClose);
	this.smtpd.server.removeListener('error', this.smtpd.onError);
	delete this.smtpd.server;
	delete this.smtpd;
	this._cleanup();
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

	if (state.suspended) {
		var message = state.suspend.message;
		var code = state.suspend.code;
		log.info('[%s] Rejecting incoming connection from %s. Server suspended with message: "%d %s"',
			session.id, session.client.info, code, message);
		var reply = new Error(state.suspend.message);
		reply.responseCode = this.suspend.code;
		state.master.destroySession();
		delete state.sessions[smtpinfo.id];
		ready(reply);
	}
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
	stream.on('close', function() {
		log.debug('[%s] Content stream was closed unexpectedly.', session.id);
		stream.removeAllListeners();
		ready(smtpError().log());
	});
	stream.on('error', function(error) {
		log.debug('[%s] Error in content stream: %s', session.id, error);
		stream.removeAllListeners();
		ready(smtpError().log());
	});
	stream.on('end', function() {
		log.info('[%s] Received %d bytes of message data.', session.id, bufferTotal);
		var content = Buffer.alloc(bufferTotal);
		var pos = 0;
		_.each(buffers, function(buffer) {
			buffer.copy(content, pos);
			pos += buffer.length;
		});
		session.content = content.toString('utf8');
		state.master.checkMessage(session.id, ready);
	});
	stream.on('data', function(buffer) {
		buffers.push(buffer);
		bufferTotal += buffer.length;
	});
	delete session.recipient;
	session.smtpInfo = smtpinfo;
	session.smtpCallback = ready;
};

Server.prototype.onClose = function(smtpinfo) {
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
	state.master.destroySession(session.id);
	log.info('[%s] Client connection closed.', session.id);
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
