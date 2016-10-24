var _ = require('underscore');
var strfmt = require('util').format;
var Bunyan = require('bunyan');
var EventEmitter = require('events').EventEmitter;
var SmtpProtocol = require('smtp-protocol');
var URI = require('urijs');

var log = Bunyan.createLogger({name: 'baleen.smtp-client'});
log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');

module.exports = Client;

Client.prototype = Object.create(EventEmitter.prototype);
Client.prototype.constructor = Client;

function Client(uri) {
	EventEmitter.call(this);
	try {
		uri = new URI(uri || "smtp://localhost");
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
	this.username = uri.username();
	this.password = uri.password();
	this.phase = false;
	this.smtp = false;
	this.uri = uri;
	this.uri.password('xxx');
	this.uri = this.uri.toString();
	this.onError = _.bind(Client.prototype.onError, this);
	this.stream = false;
}

Client.prototype.connect = function () {
	var state = this;
	return new Promise(function (resolve, reject) {
		if (state.phase) {
			throw new Error('Client has already tried a connection. Use a new client to connect again.');
		}
		state.phase = "CONNECT";
		var options = {
			tls: this.scheme == 'smtps'
		};
		var onError = function(err) {
			reject(new Error(strfmt('Unable to connect to %s: %s', state, err)));
		};
		state.stream = SmtpProtocol.connect(state.host, state.port, options, function(err, code, line) {
			state.stream.removeListener('error', onError);
		});

		state.stream.on('error', onError);
		state.stream.on('error', state.onError);
		state.stream.on('tls', function(ack) {

		});
		state.stream.on('greeting', function() {

		});
	});
};

Client.prototype.onError = function (err) {
	err.phase = this.phase;
	this.phase = 'ERROR';
	this.emit('error', err);
	this._cleanUp();
};

Client.prototype._cleanUp = function () {

};

Client.prototype.toString = function() {
	return this.uri;
};