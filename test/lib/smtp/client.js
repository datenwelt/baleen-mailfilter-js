var SMTPServer = require('smtp-server').SMTPServer;
var Client = require('../../../src/lib/smtp/client');
var expect = require("chai").expect;
var strfmt = require('util').format;

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

		it("resolves a promise with an SMTPConnection instance when connection succeeds.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({});
			server.on('error', function (error) {
				done(strfmt("Unable to setup test SMTP server on port %d: %s", serverPort, error));
				server.close();
			});
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
	});

	describe("Server greeting", function () {
		it("event is triggered after successful connection.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({
				useXForward: true
			});
			server.on('error', function (error) {
				done(strfmt("Unable to setup test SMTP server on port %d: %s", serverPort, error));
				server.close();
			});
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtp://localhost:%d', serverPort);
				var client = new Client(uri);
				client.on('error', function(error) {
					done(error);
				});
				client.on('greeting', function (greeting) {
					done();
				});
				client.connect().catch(function (error) {
					done(error);
					server.close();
				});
			});
		});

	});

});
