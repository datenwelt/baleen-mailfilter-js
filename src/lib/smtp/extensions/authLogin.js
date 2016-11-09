var _ = require('underscore');
var sasl = require('saslmechanisms');
var strfmt = require('util').format;

var SMTPExtension = require('../extension');

module.exports = SMTPAuthLogin;

SMTPAuthLogin.prototype = Object.create(SMTPExtension.prototype);
SMTPAuthLogin.prototype.constructor = SMTPAuthLogin;

function SMTPAuthLogin(options) {
	SMTPExtension.call(this, 'AUTH LOGIN', {
		keyword: 'AUTH LOGIN',
		verb: 'AUTH',
		name: 'Authentication - LOGIN',
		prio: 15
	});
	options = options || {};
	this.client = options.client;
}

SMTPAuthLogin.prototype.newInstance = function (client) {
	return new SMTPAuthLogin({client: client});
};

SMTPAuthLogin.prototype.enable = function (client, ready) {
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
	if (!_.contains(client.session.EHLO.capabilities.AUTH.split(/\s+/), 'LOGIN')) {
		return ready();
	}
	this.readyFn = ready;
	client.command('AUTH LOGIN');
	client.once('AUTH', _.bind(function (reply) {
		if (reply.code != 334) {
			return this.readyFn(new Error(strfmt('Unable to authenticate to server: %d %s', reply.code, reply.message)));
		}
		var username = Buffer.from(client.username).toString('BASE64');
		this.client.command({ verb: username, phase:"authLoginPassword" });
		this.client.once("authLoginPassword", _.bind(function (reply) {
			if (reply.code != 334)
				return this.readyFn(new Error(strfmt('Unable to authenticate to server: %d %s', reply.code, reply.message)));
			var password = Buffer.from(client.password).toString('BASE64');
			this.client.command({verb: password, phase: "authLoginPassword"});
			this.client.once("authLoginPassword", _.bind(function (reply) {
				if (reply.code != 235)
					return this.readyFn(new Error(strfmt('Unable to authenticate to server: %d %s', reply.code, reply.message)));
				this.client.session.AUTH = {
					mechanism: 'LOGIN',
					reply: reply
				};
				this.readyFn();
			}, this));
		}, this));
	}, this));
};
