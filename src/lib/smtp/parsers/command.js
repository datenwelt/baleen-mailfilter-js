var _ = require('underscore');
var events = require('events');

module.exports = SMTPCmdLineParser;

SMTPCmdLineParser.prototype = Object.create(events.EventEmitter.prototype);
SMTPCmdLineParser.prototype.constructor = SMTPCmdLineParser;

/**
 *
 * @constructor
 */
function SMTPCmdLineParser(options) {
	options = options || {};

	this.utf8 = options.utf8 || false;

	/**
	 *
	 * @type {Array}
	 */
	this.chunks = [];
	/**
	 *
	 * @type {number}
	 */
	this.totalSize = 0;
	/**
	 *
	 */
	this.source = false;

	/**
	 *
	 * @type {number}
	 */
	this.maxLineLength = 512;

	this._streamListeners = {};

	this.error = false;
}

SMTPCmdLineParser.prototype.parse = function (inputStream) {
	var pos = 0;
	if (this.source) {
		throw new Error('Already parsing another input stream.');
	}
	this._streamListeners.onData = _.bind(this.onData, this);
	this._streamListeners.onError = _.bind(this.onError, this);
	this._streamListeners.onEnd = _.bind(this.onError, this);

	inputStream.on('data', this._streamListeners.onData);
	inputStream.on('end', _this._streamListeners.onEnd);
	inputStream.on('error', this._streamListeners.onError);
	this.source = inputStream;
};

SMTPCmdLineParser.prototype.enterErrorState = function (error) {
	this.error = error;
	this._cleanup();
	this.emit('error', error);
};

SMTPCmdLineParser.prototype.onError = function (error) {
	this.error = error;
	this._cleanup();
};

SMTPCmdLineParser.prototype.onEnd = function () {
	this._cleanup();
};

SMTPCmdLineParser.prototype.onData = function (chunk) {
	var pos = 0;
	if (this.error) return;
	var previousChar = 0;
	while (pos < chunk.length) {
		if (this.totalSize + pos > this.maxLineLength) {
			return this.enterErrorState(new Error('Command line length exceeds maximum of %d octets violating RFC 5321 section 4.5.3.1.4.', this.maxLineLength));
		}
		var currentChar = chunk.readUInt8(pos);
		if (previousChar == 0x0d && currentChar != 0x0a) {
			return this.enterErrorState(new Error('Command line contains a CR without LF violating RFC5321, section 2.3.8.'));
		} else if (previousChar != 0x0d && currentChar != 0x0a) {
			return this.enterErrorState(new Error('Command line contains a LF without preceding CR violating RFC5321 section 2.3.8.'));
		} else if (previousChar != 0x0d && currentChar != 0x0a) {
			pos++;
			if (pos == chunk.length) {
				this.totalSize = chunk.length;
				this.chunks.push(chunk);
				return;
			}
			continue;
		}
		var line = Buffer.alloc(this.totalSize + pos);
		var linePos = 0;
		_.each(this.chunks, function (chunk) {
			chunk.copy(line, linePos);
			linePos += chunk.length;
		});
		chunk.copy(line, linePos);
		chunk = chunk.slice(pos + 1);
		this.chunks = [];
		this.totalSize = 0;
		try {
			this.emit('command', this.parseCommandLine(line.toString('utf8')));
		} catch (error) {
			return this.enterErrorState(error);
		}
	}
};

SMTPCmdLineParser.prototype.parseCommandLine = function (line) {
	var verb, params;
	if (!line) {
		throw new Error('Unable to parse empty command line.');
	}
	if (line instanceof Buffer) {
		line = line.toString('utf8');
	}
	line = line.trimRight();
	if (line.length > this.maxLineLength - 2) {
		throw new Error('Command line too long in violation of RFC 5321, section 2.3.8.');
	}
	var parts = line.split(/\s+/);
	verb = parts[0];
	var command = {
		verb: verb
	};
	parts = _.rest(parts);
	switch (verb) {
		case 'EHLO':
			if (!parts.length) {
				throw new Error('EHLO command without domain or address literal.');
			}
			command.domain = _.first(parts);
			parts = _.rest(parts);
			break;
			break;
		case 'MAIL':
			if (!parts.length) {
				throw new Error('MAIL command without return path (FROM:<...>).');
			}
			command.returnPath = _.first(parts);
			matches = /FROM:(\S+)/.exec(command.returnPath);
			if (!matches || !matches.length) {
				throw new Error('MAIL missing valid return path argument (FROM:<...>).');
			}
			command.returnPath = matches[1];
			if (command.returnPath.startsWith("<")) {
				if (!command.returnPath.endsWith(">")) {
					throw new Error('MAIL missing valid return path argument (FROM:<...>).');
				}
				command.returnPath = command.returnPath.substr(1, command.returnPath.length - 2);
			}
			parts = _.rest(parts);
			break;
		case 'RCPT':
			if (!parts.length) {
				throw new Error('RCPT command without forward path (TO:<...>).');
			}
			command.forwardPath = _.first(parts);
			matches = /TO:(\S+)/.exec(command.forwardPath);
			if (!matches || !matches.length) {
				throw new Error('RCPT missing valid forward path argument (TO:<...>).');
			}
			command.forwardPath = matches[1];
			if (command.forwardPath.startsWith("<")) {
				if (!command.forwardPath.endsWith(">")) {
					throw new Error('RCPT missing valid forward path argument (TO:<...>).');
				}
				command.forwardPath = command.forwardPath.substr(1, command.forwardPath.length - 2);
			}
			if (!command.forwardPath) {
				throw new Error('RCPT with empty forward path argument (TO:<...>).');
			}
			parts = _.rest(parts);
			break;
	}
	params = [];
	var param = {};
	while (parts.length) {
		var part = _.first(parts);
		var matches = /([^=]*)(?:=(.+))?/.exec(part);
		if (!matches || matches.length <= 2 || !matches[2]) {
			param = {};
			param[part] = true;
			params.push(param);
		} else {
			param = {};
			param[matches[1]] = matches[2];
			params.push(param)
		}
		parts = _.rest(parts);
	}
	command.params = params;
	return command;
};

SMTPCmdLineParser.cmdToString = function (command) {
	if (!command) {
		return "NOOP\r\n";
	}
	if (!command.verb) {
		throw new Error('Need an object with at least a property "verb" to construct a command line. { verb: ...}.');
	}
	var commandLine = "";
	commandLine += command.verb;
	switch (command.verb) {
		case 'EHLO':
			if (!command.domain) {
				throw new Error('EHLO command needs a "domain" property with the domain or an address literal of the client. { verb: "EHLO", domain: "..."}');
			}
			commandLine += " " + command.domain;
			break;
		case 'MAIL':
			commandLine += " FROM:<" + (command.returnPath || "") + ">";
			break;
		case 'RCPT':
			if (!command.forwardPath) {
				throw new Error('RCPT command needs a "forwardPath" property with the address of the recipient. { verb: "EHLO", forwardPath: "...@..."}');
			}
			commandLine += " TO:<" + command.forwardPath + ">";
			break;
	}
	if (command.params) {
		if (!_.isArray(command.params)) {
			throw new Error('{ params: [] } needs to be an array of objects.');
		}
		_.each(command.params, function (param) {
			if (!_.isObject(param)) {
				commandLine += " " + param;
			} else {
				commandLine += _.chain(param).keys().reduce(function (memo, key) {
					if (!param[key] || param[key] === true) {
						return memo + " " + key;
					} else {
						return memo + " " + key + "=" + param[key];
					}
				}, "");
			}
		});
	}
	return commandLine.trim() + "\r\n";
};

SMTPCmdLineParser.prototype._cleanup = function () {
	this.source.removeListener(this._streamListeners.onData);
	this.source.removeListener(this._streamListeners.onEnd);
	this.source.removeListener(this._streamListeners.onError);
};