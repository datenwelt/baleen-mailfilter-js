var _ = require('underscore');
var crypto = require('crypto');
var sasl = require('saslmechanisms');
var strfmt = require('util').format;

var SMTPExtension = require('../extension');


module.exports = SMTPAuthCramMd5;

SMTPAuthCramMd5.prototype = Object.create(SMTPExtension.prototype);
SMTPAuthCramMd5.prototype.constructor = SMTPAuthCramMd5;

var saslFactory = new sasl.Factory();
saslFactory.use(require('sasl-plain'));

function SMTPAuthCramMd5(options) {
	SMTPExtension.call(this, 'AUTH CRAM-MD5', {
		keyword: 'AUTH CRAM-MD5',
		verb: 'AUTH',
		name: 'Authentication - CRAM MD5',
		prio: 10
	});
	options = options || {};
	this.client = options.client;
}

SMTPAuthCramMd5.prototype.newInstance = function (client) {
	return new SMTPAuthCramMd5({client: client});
};

SMTPAuthCramMd5.prototype.enable = function (client, ready) {
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
	if (!_.contains(client.session.EHLO.capabilities.AUTH.split(/\s+/), 'CRAM-MD5')) {
		return ready();
	}
	this.readyFn = ready;
	client.command('AUTH CRAM-MD5');
	client.once('AUTH', _.bind(function (reply) {
		if (reply.code != 334)
			return this.readyFn(new Error(strfmt('Unable to initialize AUTH CRAM-MD5: %d %s', reply.code, reply.messae)));
		var challenge = Buffer.from(reply.message, 'BASE64').toString();
		var hmac = crypto.createHmac('MD5', client.password);
		hmac.update(challenge);
		var response = hmac.digest().toString('hex').toLowerCase();
		response = client.username + " " + response;
		response = Buffer.from(response).toString('BASE64');
		client.command(response);
		client.once(response, _.bind(function (reply) {
			if (reply.code != 235)
				return this.readyFn(new Error(strfmt('Unable to authenticate to server via CRAM-MD5: %d %s', reply.code, reply.message)));
			this.client.session.AUTH = {
				mechanism: 'CRAM-MD5',
				reply: reply
			};

			this.readyFn();
		}, this));

	}, this));
};
