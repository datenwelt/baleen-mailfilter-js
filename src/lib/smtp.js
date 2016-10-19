var crypto = require('crypto');
var bunyan = require('bunyan');
var SMTPServer = require('smtp-server').SMTPServer;
var strfmt = require('util').format;
var _ = require('underscore');

module.exports.Server = Server;

Server.prototype.constructor = Server;

function Server(master) {
	this.sessions = {};
	this.smtpinfos = {};
	this.master = master;
	this.suspended = false;
	this.logger = bunyan.createLogger({name: 'baleen.rabbitmq'});
	this.logger.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');
	return this;
}

Server.prototype.init = function () {
	var state = this;
	delete state.smtpd;
	return new Promise(function (resolve) {
		state.address = process.env.BALEEN_SMTPD_LISTEN || '0.0.0.0:10028';
		state.logger.debug('Initializing smtp server at %s.', state.address);
		var pos = state.address.indexOf(':');
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
		onConnect: _.bind(state.onConnect, state)
		//onData: _.bind(onData, state)
	};
	return new Promise(function (resolve, reject) {
		state.smtpd = {};
		state.smtpd.server = new SMTPServer(options);
		var errBack = function (error) {
			state.logger.debug('Unable to start smtp server at %s: %s', state.address, error);
			reject(error);
		};
		state.smtpd.onClose = _.bind(state.onClose, state);
		state.smtpd.server.on('close', state.smtpd.onClose);
		state.smtpd.onError = _.bind(state.onError, state);
		state.smtpd.server.on('error', _.bind(errBack, state));

		try {
			state.smtpd.server.listen(state.port, state.host, function () {
				state.logger.debug('Smtp server listening at %s', state.address);
				state.smtpd.server.removeListener('on', errBack);
				state.smtpd.server.on('error', state.smtpd.onError);
				resolve(state);
			});
		} catch (error) {
			state.logger.debug('Unable to start smtp server at %s: %s', this.address, error);
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
		state.logger.info('Smtp server suspended with message: %d %s', code, message);
		state.suspended = {
			message: message,
			code: code
		};
		resolve(state);
	});

};

Server.prototype.resume = function () {
	if (this.suspended) {
		state.logger.info('Smtp server resumed after suspension.');
		this.onConnect = this.suspend.savedCallback;
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
	this.logger.debug('Closing smtp server on error: %s', error);
	this._cleanup();
};

Server.prototype.onClose = function () {
	this.logger.debug('Smtp server at %s closed.', state.address);
	this.smtpd.server.removeListener('close', smtpd.onClose);
	this.smtpd.server.removeListener('error', smtpd.onError);
	delete this.smtpd.server;
	delete this.smtpd;
	this._cleanup();
};

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
	state.master.createSession().then(function (session) {
		state.sessions[smtpinfo.id] = session.id;
		session.client = client;

		if (state.suspended) {
			var message = state.suspend.message;
			var code = state.suspend.code;
			state.logger.info('[%s] Rejecting incoming connection from %s. Server suspended with message: "%d %s"',
				session.id, session.client.info, code, message);
			var reply = new Error(state.suspend.message);
			reply.responseCode = this.suspend.code;
			state.master.destroySession().then(function () {
				delete state.sessions[smtpinfo.id];
				ready(reply);
			});
		}
		session.smtpInfo = smtpinfo;
		session.smtpCallback = ready;
		state.logger.info('[%s] Connect from client %s.', session.id, client.info);
		state.master.checkClient(session.id);
	}).catch(function (error) {
		state.logger.error('Error creating a new session for client %s: %s', client.info, error);
		state.logger.debug(error);
		var reply = new Error('Internal server error, please try later.');
		reply.responseCode = 421;
		ready(reply);
	});
};
