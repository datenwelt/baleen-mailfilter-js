var Bunyan = require('Bunyan');
var strfmt = require('util').format;

module.exports = SMTPError;

SMTPError.prototype.constructor = SMTPError;

var LOGGER = bunyan.createLogger({name: 'baleen.smtp'});
LOGGER.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');


function SMTPError() {
	this.logger = false;
}

SMTPError.prototype.log = function(logger) {
	this.logger = logger || LOGGER;
};

SMTPError.prototype._createError = function(code, response) {
	var error = new Error(strfmt('%d %s', code, response));
	error.responseCode = code;
	error.responseMessage = response;
	if ( this.logger ) {
		this.logger.debug(error.message);
	}
	return error;
};

SMTPError.prototype.connect421 = function(hostname) {
	if ( !hostname ) {
		hostname = OS.hostname();
	}
	return this._createError(421, strfmt('<%s> Service not available, closing transmission channel', hostname));
};
