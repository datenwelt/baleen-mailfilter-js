var SMTPServer = require('smtp-server').SMTPServer;
var Client = require('../../../src/lib/smtp/client');
var expect = require("chai").expect;
var os = require('os');
var strfmt = require('util').format;
var _ = require('underscore');

describe("SMTP Client", function () {
	describe("constructor", function () {
		it("returns an instance connecting to localhost:25 when called with no arguments.", function () {
			var client = new Client();
			expect(client).to.be.instanceOf(Client);
			expect(client.scheme).to.equal('smtp');
			expect(client.host).to.equal('localhost');
			expect(client.port).to.equal(25);
		});
		it("returns an instance with the correct defaults when called with no arguments.", function () {
			var client = new Client();
			expect(client).to.be.instanceOf(Client);
			expect(client.connectTimeout).to.equal(15000);
			expect(client.socketTimeout).to.equal(5000);
		});
		it("returns an instance with the correct options when called with options arguments.", function () {
			var client = new Client({
				name: 0,
				connectTimeout: 1,
				socketTimeout: 2
			});
			expect(client).to.be.instanceOf(Client);
			expect(client.name).to.equal(0);
			expect(client.connectTimeout).to.equal(1);
			expect(client.socketTimeout).to.equal(2);
		});
		it("returns an instance connecting to mx01.testdomain.test:25 when called with URI 'smtp://mx01.testdomain.test'.", function () {
			var client = new Client('smtp://mx01.testdomain.test');
			expect(client).to.be.instanceOf(Client);
			expect(client.scheme).to.equal('smtp');
			expect(client.host).to.equal('mx01.testdomain.test');
			expect(client.port).to.equal(25);
		});
		it("returns an instance connecting to mx01.testdomain.test:465 when called with URI 'smtps://mx01.testdomain.test'.", function () {
			var client = new Client('smtps://mx01.testdomain.test');
			expect(client).to.be.instanceOf(Client);
			expect(client.scheme).to.equal('smtps');
			expect(client.host).to.equal('mx01.testdomain.test');
			expect(client.port).to.equal(465);
		});
		it("returns an instance connecting to mx01.testdomain.test:465 when called with URI 'smtps://testuser%40testdomain.test:1234567890@mx01.testdomain.test'.", function () {
			var client = new Client('smtps://testuser%40testdomain.test:1234567890@mx01.testdomain.test');
			expect(client).to.be.instanceOf(Client);
			expect(client.scheme).to.equal('smtps');
			expect(client.host).to.equal('mx01.testdomain.test');
			expect(client.port).to.equal(465);
			expect(client.username).to.equal('testuser@testdomain.test');
			expect(client.password).to.equal('1234567890');
		});
		it("obfuscates the password in stringificaion of URI.", function () {
			var client = new Client('smtps://testuser%40testdomain.test:1234567890@mx01.testdomain.test');
			expect(client.uri.indexOf('1234567890')).to.equal(-1);
			expect(client.toString().indexOf('1234567890')).to.equal(-1);
		});
		it("clears the SMTP protocol phase.", function () {
			var client = new Client('smtps://testuser%40testdomain.test:1234567890@mx01.testdomain.test');
			expect(client.phase).to.not.be.ok;
		});
	});

	describe("connect()", function () {
		it("returns a rejected promise when connect() fails.", function (done) {
			var client = new Client('smtp://localhost:61441');
			client.connect().then(function () {
				done(new Error("connect()'s promise should not resolve."));
			}).catch(function (err) {
				try {
					expect(err).to.be.instanceOf(Error);
					done();
				} catch (error) {
					done(error);
				}
			});
		});

		it("resolves a promise when connection succeeds.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({});
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtp://localhost:%d', serverPort);
				var client = new Client(uri);
				client.connect().then(function () {
					expect(client.phase).to.be.equal('GREETING');
					expect(client.session).to.exist;
					expect(client.session.connect).to.exist;
					server.close();
					done();
				}).catch(function (error) {
					done(error);
					server.close();
				});
			});
		});
		it("client reaches EHLO/HELO phase after connecting.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({secure: true});
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtps://localhost:%d', serverPort);
				var client = new Client(uri, {tls: {rejectUnauthorized: false}});
				client.on('ehlo', function (reply, callback) {
					callback(_.bind(client.close, client));
				});
				client.on('close', function () {
					server.close();
					done();
				});
				client.on('error', function (error) {
					done(error);
					server.close();
				});
				client.connect().catch(function (error) {
					done();
					server.close();
				});
			});
		});

	});


	describe("Server greeting", function () {
		var serverPort;
		var server;

		beforeEach("Starting the test SMTP server.", function (done) {
			serverPort = Math.floor(Math.random() * 20000) + 20000;
			server = new SMTPServer({
				useXForward: true
			});
			server.listen(serverPort, "localhost", function (args) {
				done();
			});
		});

		afterEach("Stopping the test SMTP server.", function (done) {
			if (server) {
				server.close(function () {
					done();
				});
				server = undefined;
			}
		});

		it("event is triggered after successful connection.", function (done) {
			var uri = strfmt('smtp://localhost:%d', serverPort);
			var client = new Client(uri);
			client.on('error', function (error) {
				done(error);
			});
			client.on('greeting', function (reply, callback) {
				try {
					expect(reply).to.exist;
					expect(reply.code).to.be.equal(220);
					expect(client.session.greeting).to.exist;
					expect(client.session.greeting.domain).to.be.equal(os.hostname());
					callback(_.bind(client.close, client));
					done();
				} catch (err) {
					done(err);
				}
				client.close();
			});
			client.connect().catch(function (error) {
				done(error);
			});
		});

	});

	describe('Command EHLO', function () {
		var serverPort;
		var server;

		beforeEach("Starting the test SMTP server.", function (done) {
			serverPort = Math.floor(Math.random() * 20000) + 20000;
			server = new SMTPServer({
				useXForward: true
			});
			server.listen(serverPort, "localhost", function (args) {
				done();
			});
		});

		afterEach("Stopping the test SMTP server.", function (done) {
			if (server) {
				server.close(function () {
					done();
				});
				server = undefined;
			}
		});

		it("EHLO is sent by default and event is triggered.", function(done) {
			var uri = strfmt('smtp://localhost:%d', serverPort);
			var client = new Client(uri);
			client.on('ehlo', function (reply, callback) {
				expect(client.session.ehlo).to.exist;
				expect(client.session.ehlo.domain).to.be.equal(os.hostname());

				callback('QUIT');
				done();
			});
			client.on('error', function (error) {
				done(error);
			});
			client.connect().catch(function(error) {
				done(error);
			});
		});

		it("EHLO collects available SMTP extensions.", function(done) {
			var uri = strfmt('smtp://localhost:%d', serverPort);
			var client = new Client(uri);
			client.on('ehlo', function (reply, callback) {
				try {
					expect(client.session.ehlo).to.exist;
					expect(client.session.ehlo.capabilities).to.exist;
					expect(client.session.ehlo.capabilities.XFORWARD).to.exist;
					expect(client.session.ehlo.capabilities.STARTTLS).to.exist;
					expect(client.session.ehlo.capabilities.AUTH).to.exist;
					done();
				} catch (error) {
					done(error);
				} finally {
					callback('QUIT');
				}
			});
			client.on('error', function (error) {
				done(error);
			});
			client.connect().catch(function(error) {
				done(error);
			});
		});
	});
	describe("SMTPS / SMTP over TLS", function () {
		it("connect() resolves a promise when connecting.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({secure: true});
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtps://localhost:%d', serverPort);
				var client = new Client(uri, {tls: {rejectUnauthorized: false}});
				client.connect().then(function () {
					expect(client.phase).to.be.equal('GREETING');
					expect(client.session).to.exist;
					expect(client.session.connect).to.exist;
					expect(client.security.type).to.equal('SMTPS');
					expect(client.security.protocol).to.equal('TLSv1.2');
					client.close();
					server.close();
					done();
				}).catch(function (error) {
					done(error);
					client.close();
					server.close();
				});
			});
		});

		it("connect() rejects by default if server has self signed certificate.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({secure: true});
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtps://localhost:%d', serverPort);
				var client = new Client(uri, {tls: {rejectUnauthorized: true}});
				client.connect().then(function () {
					server.close();
					done(new Error("Promise should not resolve."));
				}).catch(function (error) {
					done();
					server.close();
				});
			});
		});

		it("client closes connection with error if server does not offer neither SMTPS nor STARTTLS and STARTTLS is required.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({secure: false, hideSTARTTLS: true});
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtp://localhost:%d', serverPort);
				var client = new Client(uri, {tls: {rejectUnauthorized: false}, startTls: 'required'});
				client.on('error', function (error) {
					expect(error).to.exist;
					expect(error.message).to.be.equal('STARTTLS is mandatory but server does not support STARTTLS.');
					client.close();
					server.close();
					done();
				});
				client.connect().then(function () {
				}).catch(function (error) {
					client.close();
					server.close();
					done(error);
				});
			});
		});


	});

});
