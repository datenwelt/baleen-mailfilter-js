var _ = require('underscore');

module.exports = SMTPExtension;

SMPTExtension.prototype.constructor = SMTPExtension;

function SMTPExtension(keyword, options) {

	options = options || {};
	options = Object.assign({
		verb: keyword,
		after: 'EHLO'
	}, options);
	this.keyword = keyword;
	this.name = options.name || keyword;
	this.verb = options.verb;
	this.after = options.after;

}

SMTPExtension.prototype.init = function (client) {

};

SMTPExtension.prototype.start = function (client) {

};

