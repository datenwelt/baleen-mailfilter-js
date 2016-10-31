var SMPTExtension = require('../extension.js');

SMTPSize.prototype = Object.create(SMTPExtension.prototype);
SMTPSize.prototype.constructor = SMTPSite;

function SMTPSize() {
	SMTPExtension.call(this, 'SIZE');
};