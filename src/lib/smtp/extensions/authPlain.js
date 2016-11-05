var _ = require('underscore');
var sasl = require('saslmechanisms');
var strfmt = require('util').format;

var SMTPExtension = require('../extension');


module.exports = SMTPAuthPlain;

SMTPAuthPlain.prototype = Object.create(SMTPExtension.prototype);
SMTPAuthPlain.prototype.constructor = SMTPAuthPlain;

var saslFactory = new sasl.Factory();
saslFactory.use(require('sasl-plain'));

function SMTPAuthPlain(options) {
	SMTPExtension.call(this, 'AUTH PLAIN', {
		keyword: 'AUTH PLAIN',
		verb: 'AUTH',
		name: 'Authentication - Plain',
		prio: 10
	});
	options = options || {};
	this.client = options.client;
}

SMTPAuthPlain.prototype.newInstance = function (client) {
	return new SMTPAuthPlain({client: client});
};

SMTPAuthPlain.prototype.enable = function (client, ready) {
	if (!client.username) {
		return ready();
	}
	if (client.session.AUTH) {
		return ready();
	}
	if (!_.has(client.session, 'EHLO') || !_.has(client.session.EHLO, 'capabilities') || !_.has(client.session.EHLO, 'capabilities')) {
		return ready();
	}
	if (!_.has(client.session.EHLO.capabilities, 'AUTH') || !_.isString(client.session.EHLO.capabilities.AUTH)) {
		return ready();
	}
	if (!_.contains(client.session.EHLO.capabilities.AUTH.split(/\s+/), 'PLAIN')) {
		return ready();
	}
		this.readyFn = ready;
	var mech = saslFactory.create(['PLAIN']);
	var resp = mech.response({username: client.username, password: client.password});
	resp = Buffer.from(resp).toString('BASE64');
	client.command('AUTH PLAIN ' + resp);
	client.once('AUTH', _.bind(function(reply) {
		if ( reply.code != 235 ) {
			this.readyFn(new Error(strfmt('Unable to authenticate to server: %d %s', reply.code, reply.message)));
		}
		this.client.session.AUTH = {
			mechanism: 'PLAIN',
			reply: reply
		};
		this.readyFn();
	}, this));
};
