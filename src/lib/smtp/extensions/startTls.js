var _ = require('underscore');

var SMTPExtension = require('../extension.js');

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
}

SMTPStartTls.prototype.newInstance = function (client) {
	return new SMTPStartTls({ mandatory: this.mandatory});
};

SMTPStartTls.prototype.enable = function (client, ready) {
	if (client.secure) {
		return ready();
	}
	if ( !client.session.ehlo.capabilities['STARTTLS'] ) {
		if ( this.mandatory ) {
			ready(new Error('STARTTLS is mandatory but server does not support STARTTLS.'));
			return;
		} else {
			ready();
		}
	}
	this._replyListener = _.bind(this.startTls, this);
	client.on('STARTTLS', this._replyListener);
	client.command('STARTTLS');
};

SMTPStartTls.prototype.startTls = function (reply, client) {

};

SMTPStartTls.prototype.cleanup = function (client) {
	if (this._replyListener)
		client.removeListener('STARTTLS', this._replyListener);
};