var _ = require('underscore');
var tls = require('tls');
var strfmt = require('util').format;

var SMTPExtension = require('../extension');

module.exports = SMTPStartTls;

SMTPStartTls.prototype = Object.create(SMTPExtension.prototype);
SMTPStartTls.prototype.constructor = SMTPStartTls;

function SMTPStartTls(options) {
	options = options || {};
	options = Object.assign({
		mandatory: false
	}, options);
	SMTPExtension.call(this, 'STARTTLS', {prio: 0});
	this.mandatory = options.mandatory;
	this.client = options.client;
}

SMTPStartTls.prototype.newInstance = function (client) {
	return new SMTPStartTls({mandatory: this.mandatory, client: client});
};

SMTPStartTls.prototype.enable = function (client, ready) {
	if (client.security) {
		return ready();
	}
	if (!client.session.EHLO.capabilities['STARTTLS']) {
		if (this.mandatory) {
			return ready(new Error('STARTTLS is mandatory but server does not support STARTTLS.'));
		} else {
			return ready();
		}
	}
	this.readyFn = ready;
	this._replyListener = _.bind(this.startTls, this);
	client.once('STARTTLS', this._replyListener);
	client.command('STARTTLS');
};

SMTPStartTls.prototype.startTls = function (reply) {
	var client = this.client;
	if (reply.code != 220) {
		return this.client.close(new Error(strfmt('Unable to finish STARTTLS setup: %s', reply.message)));
	}
	var options = Object.assign({}, client.tls);
	options.socket = client.socket;
	client.socket.removeAllListeners();
	var underlyingSocket = client.socket;
	client.socket = tls.connect(options, _.bind(function () {
		this.security = {
			type: "STARTTLS",
			cipher: this.socket.getCipher(),
			protocol: this.socket.getProtocol()
		};
		this.direction = client.SEND;
		this.socket.removeAllListeners('error');
		this.socket.on('error', _.bind(this.onError, this));
		this.socket.on('timeout', _.bind(this.onTimeout, this));
		this.socket.on('close', _.bind(this.onClose, this));
		this.socket.on('end', _.bind(this.onEnd, this));
		this.socket.on('data', _.bind(this.onData, this));
		this.session.STARTTLS = {
			underlyingSocket: underlyingSocket,
			tls: this.security
		};
		// After STARTTLS the client needs to forget all session information and has to
		// start over at the EHLO command. We choose to leave the
		// connection info, the server greeting, the STARTTLS info in the session.
		this.session = _.pick(this.session, ['CONNECT', 'GREETING', 'STARTTLS']);
		this.ehlo();
	}, client));
	client.socket.on('error', _.bind(function (error) {
		this.readyFn(new Error(strfmt('Unable to upgrade connection with STARTTLS: %s', error.message)));
	}, this));

};

SMTPStartTls.prototype.cleanup = function (client) {
	if (this._replyListener) {
		client.removeListener('STARTTLS', this._replyListener);
		delete this._replyListener;
	}
};