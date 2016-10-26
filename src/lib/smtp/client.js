var _ = require('underscore');
var events = require('events');
var net = require('net');
var os = require('os');
var strfmt = require('util').format;
var URI = require('urijs');

module.exports = SMTPClient;

SMTPClient.prototype = Object.create(events.EventEmitter.prototype);
SMTPClient.prototype.constructor = SMTPClient;

var LAST_ID = 1;

var SEND = 1;
var RECV = 2;

function SMTPClient() {
	var options = {
		name: os.hostname(),
		logger: false,
		debug: false,
		connectTimeout: 15000,
		socketTimeout: 5000,
		startTls: true
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
	this.startTls = options.startTls;
}

SMTPClient.prototype.connect = function () {
	var state = this;
	state.phase = "CONNECTING";
	return new Promise(function (resolve, reject) {
		if (!state.phase) {
			reject(Error('Client has already tried to connect. Use a new client instead.'));
			return;
		}
		var onConnectTimeout = setTimeout(function () {
			var error = new Error(strfmt('Connection timeout.', this));
			error.smtpClient = state;
			reject(error);
		}, state.connectTimeout);

		var onConnectError = function (error) {
			state.phase = 'ERROR';
			reject(error);
		};

		state.socket = net.createConnection({
			host: state.host,
			port: state.port,
			timeout: state.socketTimeout
		}, function () {
			state.phase = 'GREETING';
			state.direction = RECV;
			clearTimeout(onConnectTimeout);
			state.socket.removeListener('error', onConnectError);
			state.socket.on('error', _.bind(state.onError, state));
			state.socket.on('connect', _.bind(state.onConnect, state));
			state.socket.on('timeout', _.bind(state.onTimeout, state));
			state.socket.on('close', _.bind(state.onClose, state));
			state.socket.on('end', _.bind(state.onEnd, state));
			state.socket.on('data', _.bind(state.onData, state));
			resolve(state);
		});
		state.socket.on('error', onConnectError);
		state.socket.on('connect', _.bind(state.onConnect, state));
	});
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
	var state = this;
	var error;
	process.nextTick(function () {
		if (reply.code == 500) {
			error = new Error(strfmt('Server indicates that our %s command exceeded size limit: %d %s', state.phase, reply.code, reply.message));
			error.reply = reply;
			this.close(error);
			return;
		}
		if (reply.code == 501) {
			error = new Error(strfmt('Server indicates a syntax error in our %s command: %d %s', state.phase, reply.code, reply.message));
			error.reply = reply;
			this.close(error);
			return;
		}
		if (reply.code == 421) {
			error = new Error(strfmt('Server indicates a temporary failure on their side: %d %s', reply.code, reply.message));
			error.reply = reply;
			this.close(error);
			return;
		}
		switch (state.phase) {
			case 'GREETING':
				if (state.processGreeting(reply)) return;
			case 'EHLO':
				if (state.processEhloReply(reply)) return;
			default:
				error = new Error(strfmt('Unexpected STMP conversation phase: %s', state.phase));
				error.reply = reply;
				this.quit(error);
				return;
		}
		error = new Error(strfmt('Received unexpected reply from server after %s: %d %s', state.phase, reply.code, reply.message));
		error.reply = reply;
		this.quit(error);
	});
};

SMTPClient.prototype.processGreeting = function (reply) {
	var state = this;
	switch (reply.code) {
		case 220:
			var remoteName = _.first(reply.message.split(" "));
			state.session.greeting = {
				domain: remoteName,
				reply: reply
			};
			state.emit('greeting', remoteName, reply);
			process.nextTick(function () {
				state.ehlo();
			});
			return true;
		case 554:
			this.close(state.createSmtpError(reply));
			return true;
	}
	return false;
};

SMTPClient.prototype.processEhloReply = function (reply) {
	var state = this;
	var error;
	switch (reply.code) {
		case 250:
			var matches = /(\S+) (.+)/.exec(reply.lines[0]);
			if (!matches) {
				this.close(new Error(strfmt('[%s] Received ill formatted response from server: %d %s', reply.replyCode, reply.lines[0])));
				return true;
			}
			state.session.ehlo = {
				domain: matches[1],
				greet: matches[2],
				reply: reply
			};
			state.session.ehlo.capabilities = {};
			_.chain(reply.lines).rest(1).each(function (line) {
				var matches = /(\w+)(?: (.+))?/.exec(line);
				if (matches)
					state.session.ehlo.capabilities[matches[1]] = matches[2] || true;
			});
			var ehlo = state.session.ehlo;
			state.emit('ehlo', ehlo.domain, ehlo.greet, ehlo.capabilities, reply);
			process.nextTick(function () {
				if ( state.scheme == 'smtp' && state.session.ehlo.capabilities['STARTTLS'] && state.startTls ) {
					state.startTls();
					return;
				}
				if ( state.scheme == 'smtp' && !state.session.ehlo.capabilities['STARTTLS'] && state.startTls === 'required' ) {
					state.close(new Error('STARTTLS required but not supported by server.'));
					return;
				}
			});
			return true;
		case 504:
		case 550:
		case 502:
			this.close(state.createSmtpError(reply));
			return true;
	}
	return false;
};

SMTPClient.prototype.quit = function (reason) {
	this.phase = 'QUIT';
	this.command('QUIT');
	this.close(reason);
};

SMTPClient.prototype.helo = function (name) {
	this.phase = 'HELO';
	return this.command(strfmt('HELO %s', name || this.name));
};

SMTPClient.prototype.ehlo = function (name) {
	this.phase = 'EHLO';
	return this.command(strfmt('EHLO %s', name || this.name));
};

SMTPClient.prototype.startTls = function() {
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
	if (this.listenerCount('command') > 0) {
		process.nextTick(_bind(function () {
			this.emit('command', command, callback);
		}, this));
	} else {
		callback(command);
	}
};

SMTPClient.prototype.onClose = function () {
	this.debug('[%s] Connection closed.', this);
	this.emit('close');
	this.phase = 'CLOSED';
	this.socket.removeAllListeners();
};

SMTPClient.prototype.onConnect = function () {
	this.debug('[%s] Connection established.', this);
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

SMTPClient.prototype.debug = function () {
	if (!this.logger || !this.debug) {
		return;
	}
	this.logger.debug.apply(this.logger, arguments);
	return this;
};

SMTPClient.prototype.createSmtpError = function(reply) {
	var error = new Error(strfmt('%d %s', reply.code, reply.message));
	error.reply = reply;
	return error;
};

SMTPClient.prototype.toString = function () {
	return this.uri;
};

