var amqplib = require('amqplib');

module.exports.connect = function(log) {
    return new Promise(function (resolve, reject) {
        if (!process.env.BALEEN_RABBITMQ_URI) {
            throw new Error("Environment variable BALEEN_RABBITMQ_URI is empty. Please set the URI of your RabbitMQ instance.");
        }
        var realUri = process.env.BALEEN_RABBITMQ_URI;
        if (!/^amqp:\/\//.test(realUri)) {
            throw new Error("Environment variable BALEEN_RABBITMQ_URI does not contain a valid RabbitMQ URI.");
        }
        var state = {};
        state.mq = {};
        state.mq.uri = realUri.replace(/^(amqps?:\/\/.+:).+(@.+)/, "$1******$2");
        try {
            log.debug('Connecting to message queue at %s.', state.mq.uri);
            realUri += "?heartbeat=15";
            return amqplib.connect(realUri)
                .then(function (conn) {
                    /* Connect to the MQ and create a channel. */
                    state.mq.conn = conn;
                    log.debug('Creating mq channel to setup RabbitMQ enviroment.');
                    resolve(conn);
                }).catch(function(error) {
                    log.error('Unable to connect to RabbitMQ at %s: %s', state.mq.uri, error);
                    reject(error);
                });
        } catch (error) {
            log.error('Unable to connect to RabbitMQ at %s: %s', state.mq.uri, error);
            reject(error);
        }
    });
};
