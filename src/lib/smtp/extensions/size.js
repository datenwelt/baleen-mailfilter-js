var _ = require('underscore');
var SMTPExtension = require('../extension.js');

SMTPSize.prototype = Object.create(SMTPExtension.prototype);
SMTPSize.prototype.constructor = SMTPSize;

module.exports = SMTPSize;

function SMTPSize(options) {
	options = options || {};
	SMTPExtension.call(this, 'SIZE', {
		verb: 'SIZE',
		name: 'Message Size Declaration'
	});
	this.client = options.client;
	this.size = 0;
}

SMTPSize.prototype.newInstance = function (client) {
	return new SMTPSize({client: client});
};

SMTPSize.prototype.enable = function (client, ready) {
	if (!this.client.session.EHLO.capabilities['SIZE']) {
		return ready();
	}
	var size = Number.parseInt(client.session.EHLO.capabilities['SIZE']);
	if ( Number.isNaN(size) || !Number.isSafeInteger(size) || size < 0 ) {
		size = 0;
	}
	this.size = size;
	this.readyFn = ready;
	this._commandListener = _.bind(this.processSMTPCommand, this);
	if ( this.client.session ) {
		client.session.SIZE = {};
		client.session.SIZE.size = size
	}
	client.on('COMMAND', this._commandListener);
	ready();
};

SMTPSize.prototype.processSMTPCommand = function (command) {
	if ( !command.verb || command.verb != 'MAIL' )
		return;
};

SMTPSize.prototype.cleanup = function () {
	if (this.client && this._commandListener)
		this.client.removeListener('COMMAND', this._commandListener);
};


