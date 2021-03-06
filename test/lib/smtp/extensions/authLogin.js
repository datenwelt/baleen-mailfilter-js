var _ = require('underscore');
var expect = require("chai").expect;
var strfmt = require("util").format;

var SMTPServer = require('smtp-server').SMTPServer;
var SMTPClient = require('../../../../src/lib/smtp/client');
var SMTPAuthLogin = require('../../../../src/lib/smtp/extensions/authLogin');
var SMTPExtension = require('../../../../src/lib/smtp/extension');


describe('ESMTP Plugin - AUTH LOGIN', function() {

	describe('constructor', function () {

		it("returns an SMTPAuthLogin instance.", function () {
			var size = new SMTPAuthLogin();
			expect(size).to.be.an.instanceOf(SMTPAuthLogin);
			expect(size).to.be.an.instanceOf(SMTPExtension);
		});

	});

	describe("operations within SMTP Client", function () {
		it("plugin registers within an SMTP Client instance.", function () {
			var client = new SMTPClient();
			var plg = new SMTPAuthLogin();
			client.enable(plg);
			expect(client.extensions).to.include.keys('AUTH LOGIN');
		});

		it("skips login when no username is provided.", function(done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({
				hideSTARTTLS: true,
				authMethods: ['PLAIN']
			});
			server.listen(serverPort, "localhost", function () {
				var uri = strfmt('smtp://localhost:%d', serverPort);
				var client = new SMTPClient(uri);
				var plg = new SMTPAuthLogin();
				client.extensions = _.omit(client.extensions, function (value, key) {
					return key.startsWith('AUTH');
				});
				client.enable(plg);
				client.on('close', function () {
					server.close();
				});
				client.on('error', function (error) {
					done(error);
					server.close();
				});
				client.on('ESMTP', function (reply, ready) {
					expect(client.session.AUTH).to.not.exist;
					done();
					ready('QUIT');
				});
				client.connect().catch(function (error) {
					done(error);
					server.close();
				});
			});
		});

		it("skips login when username is provided but AUTH PLAIN not supported by server.", function(done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({
				hideSTARTTLS: true,
				authMethods: ['PLAIN']
			});
			server.listen(serverPort, "localhost", function () {
				var uri = strfmt('smtp://test:test@localhost:%d', serverPort);
				var client = new SMTPClient(uri);
				var plg = new SMTPAuthLogin();
				client.extensions = _.omit(client.extensions, function (value, key) {
					return key.startsWith('AUTH');
				});
				client.enable(plg);
				client.on('close', function () {
					server.close();
				});
				client.on('error', function (error) {
					done(error);
					server.close();
				});
				client.on('ESMTP', function (reply, ready) {
					expect(client.session.AUTH).to.not.exist;
					done();
					ready('QUIT');
				});
				client.connect().catch(function (error) {
					done(error);
					server.close();
				});
			});
		});

		it("performs login when username is provided and AUTH PLAIN supported by server.", function(done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({
				hideSTARTTLS: true,
				authMethods: ['LOGIN', 'PLAIN'],
				onAuth: function(creds, session, callback) {
					if ( creds.method != 'LOGIN' || creds.username != 'test' || creds.password != 'testpass' )
						callback(new Error('Invalid username or password.'));
					callback(null, {user: creds.username});
				}
			});
			server.listen(serverPort, "localhost", function () {
				var uri = strfmt('smtp://test:testpass@localhost:%d', serverPort);
				var client = new SMTPClient(uri);
				var plg = new SMTPAuthLogin();
				client.extensions = _.omit(client.extensions, function (value, key) {
					return key.startsWith('AUTH');
				});
				client.enable(plg);
				client.on('close', function () {
					server.close();
				});
				client.on('error', function (error) {
					done(error);
					server.close();
				});
				client.on('ESMTP', function (reply, ready) {
					expect(client.session.AUTH).to.exist;
					expect(client.session.AUTH.mechanism).to.exist;
					expect(client.session.AUTH.mechanism).to.be.equal('LOGIN');
					done();
					ready('QUIT');
				});
				client.connect().catch(function (error) {
					done(error);
					server.close();
				});
			});
		});

		it("emits an error if login fails.", function(done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({
				hideSTARTTLS: true,
				authMethods: ['LOGIN', 'PLAIN'],
				onAuth: function(creds, session, callback) {
					if ( creds.method != 'LOGIN' || creds.username != 'test' || creds.password != 'testpass' )
						callback(new Error('Invalid username or password.'));
					callback(null, {user: creds.username});
				}
			});
			server.listen(serverPort, "localhost", function () {
				var uri = strfmt('smtp://test:testpass1@localhost:%d', serverPort);
				var client = new SMTPClient(uri);
				var plg = new SMTPAuthLogin();
				client.extensions = _.omit(client.extensions, function (value, key) {
					return key.startsWith('AUTH');
				});
				client.enable(plg);
				client.on('close', function () {
					server.close();
				});
				client.on('error', function (error) {
					expect(error).to.be.an.instanceOf(Error);
					expect(error.message).to.be.equal('Unable to authenticate to server: 535 Invalid username or password.');
					done();
					server.close();
				});
				client.on('ESMTP', function (reply, ready) {
					done('No error was emitted despite wrong login credentials.');
					client.close();
					server.close();
				});
				client.connect().catch(function (error) {
					done(error);
					server.close();
				});
			});
		});
	});
});