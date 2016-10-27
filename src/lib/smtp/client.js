var _ = require('underscore');
var events = require('events');
var net = require('net');
var os = require('os');
var strfmt = require('util').format;
var tls = require('tls');
var URI = require('urijs');

module.exports = SMTPClient;

SMTPClient.prototype = Object.create(events.EventEmitter.prototype);
SMTPClient.prototype.constructor = SMTPClient;

var SEND = 1;
var RECV = 2;

function SMTPClient() {
	var options = {
		name: os.hostname(),
		logger: false,
		debug: false,
		connectTimeout: 15000,
		socketTimeout: 5000,
		startTls: true,
		tls: {}
	};
	var uri = "smtp://localhost";
	_.each(arguments, function (arg) {
		if (_.isString(arg)) {
			uri = arg;
		} else {
			options = Object.assign(options, arg);
		}
	});
	try {
		uri = new URI(uri);
	} catch (error) {
		throw new Error(strfmt('Invalid SMTP URI: %s', error));
	}
	this.scheme = uri.scheme();
	if (this.scheme != 'smtp' && this.scheme != 'smtps') {
		throw new Error('Invalid SMTP URI: Must start with smtp: or smtps:');
	}
	this.host = uri.hostname();
	this.port = Number.parseInt(uri.port());
	if (!this.port) {
		this.port = this.scheme == 'smtp' ? 25 : 465;
	}
	this.name = options.name;
	this.connectTimeout = options.connectTimeout;
	this.socketTimeout = options.socketTimeout;
	this.username = uri.username();
	this.password = uri.password();
	this.phase = false;
	this.uri = uri;
	this.uri.password('xxx');
	this.uri = this.uri.toString();
	this.socket = false;
	this.logger = options.logger;
	this.session = {};
	this.direction = false;
	this.recvBuffers = [];
	this.recvBuffersLength = 0;
	this.recvLines = [];
	this.lastCommand = false;
	this.tls = options.tls;
	this.useStartTls = options.startTls;
}

SMTPClient.prototype.connect = function () {
	this.phase = "CONNECTING";
	return new Promise(_.bind(function (resolve, reject) {
		if (!this.phase) {
			reject(Error('Client has already tried to connect. Use a new client instead.'));
			return;
		}
		var onConnectTimeout = setTimeout(function () {
			reject(new Error(strfmt('Connection timeout.')));
		}, this.connectTimeout);

		var onConnectError = function (error) {
			clearTimeout(onConnectTimeout);
			this.phase = 'ERROR';
			reject(error);
		};

		this.socket = net.createConnection({
			host: this.host,
			port: this.port,
			timeout: this.socketTimeout
		}, _.bind(function () {
			if (this.scheme === 'smtps') {
				this._upgradeConnection().then(_.bind(function () {
					this.security.type = "SMTPS";
					this.processConnect();
					resolve();
				}, this)).catch(_.bind(function (error) {
					clearTimeout(onConnectTimeout);
					this.phase = 'ERROR';
					reject(error);
				}, this));
			} else {
				clearTimeout(onConnectTimeout);
				this.processConnect();
				resolve();
			}
		}, this));
		this.socket.on('error', onConnectError);
	}, this));
};

SMTPClient.prototype._upgradeConnection = function () {
	var _doUpgrade = function (resolve, reject) {
		if (this.security) {
			return resolve(this.socket);
		}
		this.security = {};
		var options = Object.assign({}, this.tls);
		options.socket = this.socket;
		this.socket = tls.connect(options, _.bind(function () {
			this.security.cipher = this.socket.getCipher();
			this.security.protocol = this.socket.getProtocol();
			resolve();
		}, this));
		this.socket.on('error', function (error) {
			reject(error);
		});
	};
	return new Promise(_.bind(_doUpgrade, this));
};

SMTPClient.prototype.close = function (reason) {
	if (reason && reason instanceof Error) {
		this.session.lastError = reason;
		this.phase = 'ERROR';
		this.emit('error', reason);
	} else {
		delete this.session.lastError;
		this.debug('[%s] Closing connection: %s', this, reason);
		this.phase = 'CLOSED';
		this.emit('close', reason);
	}
	this.socket.end();
};

SMTPClient.prototype.processReply = function (reply) {
	var error;
	if (reply.code == 500) {
		error = new Error(strfmt('Server indicates that our %s command exceeded size limit: %d %s', this.phase, reply.code, reply.message));
		error.reply = reply;
		return this.close(error);

	}
	if (reply.code == 501) {
		error = new Error(strfmt('Server indicates a syntax error in our %s command: %d %s', this.phase, reply.code, reply.message));
		error.reply = reply;
		return this.close(error);
	}
	if (reply.code == 421) {
		error = new Error(strfmt('Server indicates a temporary failure on their side: %d %s', reply.code, reply.message));
		error.reply = reply;
		return this.close(error);
	}
	try {
		switch (this.phase) {
			case 'GREETING':
				return this.processGreeting(reply);
			case 'EHLO':
				return this.processEhloReply(reply);
			case 'QUIT':
				return this.processQuitReply(reply);
			default:
				throw (new Error(strfmt('Unexpected STMP conversation phase: %s', this.phase)));
		}
	} catch (error) {
		error.reply = error.reply || reply;
		this.quit(error);
	}
};

SMTPClient.prototype.processGreeting = function (reply) {
	switch (reply.code) {
		case 220:
			var remoteName = _.first(reply.message.split(" "));
			this.session.greeting = {
				domain: remoteName,
				reply: reply
			};
			return this._emitReply('greeting', reply, _.bind(this.ehlo, this));
		case 554:
			return this.close(state.createSmtpError(reply));
	}
	throw new Error(strfmt('Received unexpected reply from server after %s: %d %s', this.phase, reply.code, reply.message));
};

SMTPClient.prototype.processEhloReply = function (reply) {
	var state = this;
	switch (reply.code) {
		case 250:
			var matches = /(\S+) (.+)/.exec(reply.lines[0]);
			if (!matches) {
				this.close(new Error(strfmt('Received ill formatted response from server: %d %s', this, reply.replyCode, reply.lines[0])));
				return true;
			}
			this.session.ehlo = {
				domain: matches[1],
				greet: matches[2],
				reply: reply
			};
			this.session.ehlo.capabilities = {};
			_.chain(reply.lines).rest(1).each(function (line) {
				var matches = /(\w+)(?: (.+))?/.exec(line);
				if (matches)
					this.session.ehlo.capabilities[matches[1]] = matches[2] || true;
			}, this);
			var nextAction = _.bind(this.quit, this, new Error('No further SMTP actions defined for this state.'));
			if (!this.security && this.session.ehlo.capabilities['STARTTLS'] && this.useStartTls) {
				nextAction = _.bind(this.startTls, this);
			}
			if (!this.security && !this.session.ehlo.capabilities['STARTTLS'] && this.useStartTls === 'required') {
				nextAction = _.bind(this.close, this, new Error('STARTTLS required but not supported by server.'));
			}
			return this._emitReply('ehlo', reply, nextAction);
		case 504:
		case 550:
		case 502:
			throw this.createSmtpError(reply);
	}
	throw new Error(strfmt('Received unexpected reply from server after %s: %d %s', this.phase, reply.code, reply.message));
};

SMTPClient.prototype.processQuitReply = function (reply) {
	var nextAction = _.bind(this.close, this);
	this.session.quit = {};
	if (reply.code == 221) {
		this.session.quit.lastWords = reply.message
	}
	return this._emitReply('quit', reply, nextAction);
};

SMTPClient.prototype.quit = function () {
	this.phase = 'QUIT';
	this.command('QUIT');
};

SMTPClient.prototype.helo = function (name) {
	this.phase = 'HELO';
	return this.command(strfmt('HELO %s', name || this.name));
};

SMTPClient.prototype.ehlo = function (name) {
	this.phase = 'EHLO';
	return this.command(strfmt('EHLO %s', name || this.name));
};

SMTPClient.prototype.startTls = function () {
	this.phase = 'STARTTLS';
	return this.command(strfmt('STARTTLS'));
};

SMTPClient.prototype.command = function (command) {
	if (this.direction != SEND) {
		this.close(new Error('Cannot send commands while not connected or waiting for server reply.'));
		return;
	}
	command = command.trim();
	var callback = _.bind(function (sendCommand) {
		if (this.direction != SEND) return;
		sendCommand = sendCommand.trim() + "\r\n";
		this.direction = RECV;
		this.lastCommand = sendCommand;
		if (!this.socket.write(sendCommand)) {
			this.socket.on('drain', _.bind(function () {
				this.socket.write(this.lastCommand);
				this.debug('[%s] C: %s', this, this.lastCommand.trim());
			}, this));
		} else {
			this.debug('[%s] C: %s', this, sendCommand.trim());
		}
	}, this);
	callback(command);
};

SMTPClient.prototype.onClose = function () {
	this.debug('[%s] Connection closed.', this);
	this.phase = 'CLOSED';
};

SMTPClient.prototype.processConnect = function () {
	this.debug('[%s] Connection established.', this);
	this.phase = 'GREETING';
	this.direction = RECV;
	this.socket.removeAllListeners('error');
	this.socket.on('error', _.bind(this.onError, this));
	this.socket.on('timeout', _.bind(this.onTimeout, this));
	this.socket.on('close', _.bind(this.onClose, this));
	this.socket.on('end', _.bind(this.onEnd, this));
	this.socket.on('data', _.bind(this.onData, this));
	this.session.connect = {
		server: {
			addr: this.socket.remoteAddress,
			port: this.socket.remotePort,
			family: this.socket.remoteFamily
		},
		client: this.socket.address()
	};
	this.emit('connect');
};

SMTPClient.prototype.onData = function (chunk) {
	var state = this;
	if (this.direction != RECV) {
		this.close(new Error("Out of band data from server received."));
		return;
	}
	var pos, currChar, lastChar = 0;
	var currentLine, lastBuffer;
	if (this.recvBuffers.length) {
		lastBuffer = _.last(this.recvBuffers);
		lastChar = lastBuffer.readUInt8(lastBuffer.length - 1);
	}
	for (pos = 0; pos < chunk.length; pos++) {
		currChar = this._assertReplyLineChar(chunk.readUInt8(pos));
		if (lastChar == 0x0d && currChar == 0x0a) {
			pos++;
			currentLine = Buffer.alloc(this.recvBuffersLength + pos);
			var offset = 0;
			_.each(this.recvBuffers, function (buffer) {
				buffer.copy(currentLine, offset);
				offset += buffer.length;
			});
			chunk.copy(currentLine, 0, 0, pos);
			chunk = chunk.slice(pos);
			pos = 0;
			this.recvBuffersLength = 0;
			this.recvBuffers = [];
			this.processReplyLine(currentLine.slice(0, currentLine.length - 2).toString('ascii'));
		} else {
			if (this.recvBuffersLength > 512) {
				this.close(new Error('Server reply exceeds line limit of 512 octets.'));
				return;
			}
			lastChar = currChar;
		}
	}
	if (chunk.length) {
		this.recvBuffers.push(chunk);
		this.recvBuffersLength += chunk.length;
	}
};

SMTPClient.prototype._assertReplyLineChar = function (char) {
	if (char == 0x09 || char == 0x0a || char == 0x0d || (char >= 0x20 && char <= 0x7e))
		return char;
	this.close(new Error('Server has sent an invalid character: %d', char));
};

SMTPClient.prototype.processReplyLine = function (line) {
	this.debug('[%s] S: %s', this, line);
	if (line.length < 3) {
		this.close(new Error(strfmt('Server has sent a reply line shorter than the minimum of 3 characters: %s', line)));
	}
	var matches = /^([2345]\d{2})([ \-])(.+)/.exec(line);
	if (!matches) {
		this.close(new Error(strfmt('Server has sent an invalid reply line: %s', line)));
	}
	var message = matches[3];
	var code = Number.parseInt(matches[1]);
	this.recvLines.push(message);
	if (matches[2] === '-') {
		return;
	}
	var reply = {
		code: code,
		lines: this.recvLines,
		message: this.recvLines[0]
	};
	this.direction = SEND;
	this.recvLines = [];
	process.nextTick(_.bind(function () {
		this.processReply(reply);
	}, this));
};

SMTPClient.prototype.onEnd = function () {
	this.debug('[%s] Connection closed by server.', this);
	this.emit('end');
};

SMTPClient.prototype.onError = function (error) {
	this.session.lastError = error;
	this.phase = 'ERROR';
	if (error && error instanceof Error) {
		error.client = this;
	}
	this.logger && this.debug && this.logger.debug('[%s]')
	this.emit('error', error);
};

SMTPClient.prototype.onTimeout = function () {
	this.phase = 'ERROR';
	this.debug('[%s] Timeout waiting on data from server.', this);
};

SMTPClient.prototype.createSmtpError = function (reply) {
	var error = new Error(strfmt('%d %s', reply.code, reply.message));
	error.reply = reply;
	return error;
};

SMTPClient.prototype.debug = function () {
	if (!this.logger || !this.debug) {
		return;
	}
	this.logger.debug.apply(this.logger, arguments);
	return this;
};

SMTPClient.prototype._emitReply = function (event, reply, defaultAction) {
	var callback = _.bind(function (next) {
			if (next instanceof Error) {
				callback.action = _.bind(function () {
					this.close(next);
				}, this);
			} else if (_.isString(next)) {
				switch (next) {
					case 'CLOSE':
						callback.action = _.bind(this.close, this);
						break;
					case 'QUIT':
						callback.action = _.bind(this.quit, this);
						break;
					default:
						callback.action = _.bind(function () {
							this.command(next);
						}, this);
				}
			} else if (_.isFunction(next)) {
				callback.action = next;
			}
			callback.countDown--;
			if (!callback.countDown && callback.action) {
				process.nextTick(callback.action)
			}
		}, this
		)
		;
	callback.countDown = this.listenerCount(event);
	callback.action = defaultAction;
	defaultAction.$default = 1;
	if (callback.countDown) {
		this.emit(event, reply, callback);
	} else {
		callback.countDown = 1;
		process.nextTick(callback);
	}

}
;


SMTPClient.prototype.toString = function () {
	return this.uri;
};

