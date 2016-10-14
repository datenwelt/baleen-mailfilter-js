var Baleen = require('../baleen.js');

module.exports = Reject;

Reject.prototype = Object.create(Baleen.prototype);
Reject.prototype.constructor = Reject;

function Reject(smtpSessions, exchange, queue) {

    var filterFn = function(session) {
        var state = this;
        if ( !session || !session.id ) {
            throw new Error('Skipping message with empty session.');
        }
        if ( smtpSessions && smtpSessions[session.id] ) {

        }
    };

    Baleen.call(this, exchange, queue, filterFn);
    this.smtpSessions = smtpSessions;

}
