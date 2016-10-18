var crypto = require('crypto');
var bunyan = require('bunyan');
var SMTPServer = require('smtp-server').SMTPServer;
var strfmt = require('util').format;
var _ = require('underscore');

module.exports.Server = Server;

Server.prototype.constructor = Server;

function Server(log) {
    this.sessions = {};
    this.smtpinfos = {};

    if (!log) {
        log = bunyan.createLogger({name: 'baleen.rabbitmq'});
        log.level(process.env.BALEEN_DEBUG ? 'DEBUG' : 'INFO');
    }
    this.log = log;
    return this;
}

Server.prototype.init = function () {
    var state = this;
    state.smtpd = undefined;
    return new Promise(function (resolve, reject) {
        state.address = process.env.BALEEN_SMTPD_LISTEN || '0.0.0.0:10028';
        state.log.debug('Initializing smtp server at %s.', state.address);
        var pos = state.address.indexOf(':');
        var matches = /(.+)?:(\d+)/.exec(state.address);
        if (!matches) {
            throw new Error(strfmt('Invalid value ("%s") for BALEEN_SMTPD_LISTEN. The value must at least specify a port number in the format ":PORT".', state.address));
        }
        state.host = matches.length == 2 ? '0.0.0.0' : matches[1];
        state.port = matches.length == 2 ? matches[1] : matches[2];
        resolve(state);
    });
};

Server.prototype.start = function () {
    var state = this;
    var options = {
        disabledCommands: 'AUTH',
        useXForward: true,
        onConnect: _.bind(state.onConnect, state)
        //onData: _.bind(onData, state)
    };
    return new Promise(function (resolve, reject) {
        state.smtpd = {};
        state.smtpd.server = new SMTPServer(options);
        var errBack = function (error) {
            this.log.debug('Unable to start smtp server at %s: %s', this.address, error);
            reject(error);
        };
        state.smtpd.onClose = _.bind(state.onClose, state);
        state.smtpd.server.on('close', state.smtpd.onClose);
        state.smtpd.onError = _.bind(state.onError, state);
        state.smtpd.server.on('error', _.bind(errBack, state));

        try {
            state.smtpd.server.listen(state.port, state.host, function () {
                state.log.debug('Smtp server listening at %s', state.address);
                state.smtpd.server.removeListener('on', errBack);
                state.smtpd.server.on('error', state.smtpd.onError);
                resolve(state);
            });
        } catch (error) {
            state.log.debug('Unable to start smtp server at %s: %s', this.address, error);
            state.smtpd.server.removeListener('on', errBack);
            state.smtpd.server = undefined;
            reject(error);
        }

    });
};

Server.prototype.stop = function () {
    this._cleanup();
};

Server.prototype.suspend = function (message, code) {
    var state = this;
    if (!this.smtpd || !this.smtpd.server) {
        return Promise.resolve(this);
    }
    message = message || 'Server is currently undergoing an unscheduled maintenance. Please try again later.';
    code = code || 421;
    return new Promise(function (resolve) {
        state.log.info('Smtp server suspended with message: %d %s', code, message);
        state.suspend = {
            message: message,
            code: code
        };
        resolve(state);
    });

};

Server.prototype.resume = function () {
    if (this.suspend) {
        state.log.info('Smtp server resumed after suspension.');
        this.onConnect = this.suspend.savedCallback;
        delete this.suspend;
    }
    return Promise.resolve(this);
};

Server.prototype._cleanup = function () {
    var state = this;
    if (state.smtpd) {
        if (state.smtpd.server) {
            state.smtpd.server.close(function (server) {
                server.removeListener('close', smtpd.onClose);
                server.removeListener('error', smtpd.onError);
            });
            delete state.smtpd.server;
        }
        delete state.smtpd;
    }

};

Server.prototype.onError = function (error) {
    this.log.debug('Closing smtp server on error: %s', error);
    this._cleanup();
};

Server.prototype.onClose = function () {
    this.log.debug('Smtp server at %s closed.', state.address);
    this.smtpd.server.removeListener('close', smtpd.onClose);
    this.smtpd.server.removeListener('error', smtpd.onError);
    delete this.smtpd.server;
    delete this.smtpd;
    this._cleanup();
};

Server.prototype.onConnect = function (smtpinfo, ready) {
    var state = this;
    var session = {};
    session.client = {
        address: smtpinfo.remoteAddress,
        info: smtpinfo.remoteAddress
    };
    if (smtpinfo.xforward && smtpinfo.xforward.client) {
        session.client = {
            address: smtpinfo.xforward.client,
            proxy: smtpinfo.remoteAddress,
            info: strfmt('%s (via %s)', smtpinfo.xforward.client, smtpinfo.remoteAddress)
        }
    }

    if (state.suspend) {
        var message = state.suspend.message;
        var code = state.suspend.code;
        state.log.info('Rejecting incoming connection from %s. Server suspended with message: "%d %s"',
            session.client.info, code, message);
        var reply = new Error(state.suspend.message);
        reply.responseCode = this.suspend.code;
        return ready(reply);
    }
    do {
        var hash = crypto.createHash('sha256');
        hash.update(smtpinfo.id);
        hash.update("" + Math.random());
        hash.update("" + Date.now());
        session.id = hash.digest('hex').substr(0, 16).toUpperCase();
    } while (state.sessions[session.id]);
    session.smtpinfo = smtpinfo;
    session.client = smtpinfo.remoteAddress;
    session.smtpCallback = ready;
    state.sessions[session.id] = session;
    state.smtpinfos[smtpinfo.id] = session;
    var clientStr = session.client;
    if (smtpinfo.xforward && smtpinfo.xforward.client) {
        clientStr = strfmt('%s (via %s)', smtpinfo.xforward.client, session.client);
        session.client = smtpinfo.xforward.client;
    }
    state.log.info('[%s] Connect from client %s.', session.id, clientStr);
    return ready();
};
