var _ = require('underscore');
var events = require('events');
var strfmt = require('util').format;

module.exports = SMTPCmdLineParser;

SMTPCmdLineParser.prototype = Object.create(events.EventEmitter.prototype);
SMTPCmdLineParser.prototype.constructor = SMTPCmdLineParser;

/**
 *
 * @constructor
 */
function SMTPCmdLineParser() {

	/**
	 * The collected chunks of data by the source stream. Data is collected from the stream
	 * until there is a CRLF.
	 * @type {Array}
	 */
	this.chunks = [];
	/**
	 * The total size of all collected chunks so far.
	 * @type {number}
	 */
	this.totalSize = 0;

	/**
	 * The last character collected from the source stream to find CRLF occurences split between
	 * two chunks.
 	 * @type {number}
	 */
	this.lastChar = 0x00;
	/**
	 * The source stream from "parse()".
	 */
	this.source = false;

	/**
	 * The maximum line length for a currentCommand line in octets. By default 512 octets.
	 * @type {number}
	 */
	this.maxLineLength = 512;

	this._streamListeners = {};

	/**
	 * The last error from the stream or "false" if no such error occurred.
	 * @type {boolean}
	 */
	this.error = false;
}

/**
 * Parses currentCommand lines from the input stream and emits 'currentCommand' events whenever
 * an SMTP currentCommand is detected.
 *
 * @param inputStream
 */
SMTPCmdLineParser.prototype.parse = function (inputStream) {
	if (this.source) {
		throw new Error('Already parsing another input stream.');
	}
	this._streamListeners.onData = _.bind(this.onData, this);
	this._streamListeners.onError = _.bind(this.onError, this);
	this._streamListeners.onEnd = _.bind(this.onError, this);

	inputStream.on('data', this._streamListeners.onData);
	inputStream.on('end', this._streamListeners.onEnd);
	inputStream.on('error', this._streamListeners.onError);
	this.source = inputStream;
};

/**
 * Puts the parser in error state which prevents any further chunks of
 * data to be read from the stream and emits an 'error' event.
 *
 * @param error
 */
SMTPCmdLineParser.prototype.enterErrorState = function (error) {
	this.error = error;
	this._cleanup();
	this.emit('error', error);
};

/**
 * Event handler for errors from the underlying input stream. Puts the parser into error mode when
 * called.
 *
 * @param error
 */
SMTPCmdLineParser.prototype.onError = function (error) {
	this.error = error;
	this.emit('error', error);
	this._cleanup();
};

/**
 * Event handler for the 'end' event of the underlying stream.
 */
SMTPCmdLineParser.prototype.onEnd = function () {
	this._cleanup();
	this.emit('end');
};

/**
 * Event handler for 'data' events of the underlying stream. Parses SMTP commands from the stream.
 *
 * @param chunk
 */
SMTPCmdLineParser.prototype.onData = function (chunk) {
	var pos = 0;
	if (this.error) return;
	var previousChar = this.lastChar;
	while (pos < chunk.length) {
		if (this.totalSize + pos > this.maxLineLength) {
			return this.enterErrorState(new Error(strfmt('Command line length exceeds maximum of %d octets violating RFC 5321 section 4.5.3.1.4.', this.maxLineLength)));
		}
		var currentChar = chunk.readUInt8(pos);
		if (previousChar == 0x0d && currentChar != 0x0a) {
			return this.enterErrorState(new Error('Command line contains a CR without LF violating RFC5321, section 2.3.8.'));
		} else if (previousChar != 0x0d && currentChar == 0x0a) {
			return this.enterErrorState(new Error('Command line contains a LF without preceding CR violating RFC5321 section 2.3.8.'));
		} else if (previousChar != 0x0d && currentChar != 0x0a) {
			pos++;
			if (pos == chunk.length) {
				this.totalSize += chunk.length;
				this.lastChar = chunk.readUInt8(chunk.length-1);
				this.chunks.push(chunk);
				return;
			}
			previousChar = currentChar;
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
		previousChar = 0;
		try {
			this.emit('currentCommand', this.parseCommandLine(line.toString('utf8')));
		} catch (error) {
			return this.enterErrorState(error);
		}
	}
};

/**
 * Parses a string into an SMTP currentCommand structure. The structure has properties 'verb' and 'params' where 'verb' is
 * the SMTP currentCommand itself and params is an array of key-value pairs (objects) for all passed currentCommand parameters.
 * Command parameters have the form of KEYWORD=VALUE which are represented in Javascript as an object { KEY: 'VALUE' }.
 * There is one object for each parameter.
 *
 * The commands EHLO, MAIL, RCPT have exactly one special argument each which is in the case of 'EHLO' the domain name of the client,
 * the return path for 'MAIL' in the form of 'FROM:<...@...>' and the forward path in the form of "TO:<...@...>" for 'RCPT'.
 *
 * These arguments are stored in the properties 'domain', 'returnPath', 'forwardPath' for each of these commands respectively.
 *
 * @param line the currentCommand line as a string.
 * @returns {{verb: *}} the currentCommand structure as described above.
 */
SMTPCmdLineParser.prototype.parseCommandLine = function (line) {
	var verb, params;
	if (!line) {
		throw new Error('Unable to parse empty currentCommand line.');
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
				throw new Error('EHLO currentCommand without domain or address literal.');
			}
			command.domain = _.first(parts);
			parts = _.rest(parts);
			break;
			break;
		case 'MAIL':
			if (!parts.length) {
				throw new Error('MAIL currentCommand without return path (FROM:<...>).');
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
				throw new Error('RCPT currentCommand without forward path (TO:<...>).');
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

/**
 * Static method to create a currentCommand line string terminated by the mandatory CRLF from the currentCommand line
 * structure returned by parseCommandLine().
 * @param command
 * @returns {*}
 */
SMTPCmdLineParser.cmdToString = function (command) {
	if (!command) {
		return "NOOP\r\n";
	}
	if (!command.verb) {
		throw new Error('Need an object with at least a property "verb" to construct a currentCommand line. { verb: ...}.');
	}
	var commandLine = "";
	commandLine += command.verb;
	switch (command.verb) {
		case 'EHLO':
			if (!command.domain) {
				throw new Error('EHLO currentCommand needs a "domain" property with the domain or an address literal of the client. { verb: "EHLO", domain: "..."}');
			}
			commandLine += " " + command.domain;
			break;
		case 'MAIL':
			commandLine += " FROM:<" + (command.returnPath || "") + ">";
			break;
		case 'RCPT':
			if (!command.forwardPath) {
				throw new Error('RCPT currentCommand needs a "forwardPath" property with the address of the recipient. { verb: "EHLO", forwardPath: "...@..."}');
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
	this.source.removeListener('data', this._streamListeners.onData);
	this.source.removeListener('end', this._streamListeners.onEnd);
	this.source.removeListener('error', this._streamListeners.onError);
};