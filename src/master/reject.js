var Baleen = require('../baleen.js');

module.exports = Reject;

Reject.prototype = Object.create(Baleen.prototype);
Reject.prototype.constructor = Reject;

function Reject(sessions, exchange, queue) {

    var filterFn = function() {

    };

    Baleen.call(this, exchange, queue, filterFn);
    this.sessions = sessions;
}

