var _ = require('underscore');

module.exports = SMTPExtension;

SMTPExtension.prototype.constructor = SMTPExtension;

function SMTPExtension(keyword, options) {

	options = options || {};
	options = Object.assign({
		verb: keyword,
		prio: 100,
	}, options);
	this.options = options;
	this.keyword = keyword;
	this.name = options.name || keyword;
	this.verb = options.verb;
	this.prio = options.prio;

}

SMTPExtension.prototype.newInstance = function (client) {
	return this;
};

SMTPExtension.prototype.enable = function(client, ready) {
	return ready();
};

SMTPExtension.prototype.cleanup = function(client) {

};

