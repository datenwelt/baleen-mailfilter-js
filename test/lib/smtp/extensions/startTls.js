var _ = require('underscore');
var expect = require("chai").expect;
var strfmt = require("util").format;

var SMTPServer = require('smtp-server').SMTPServer;
var SMTPClient = require('../../../../src/lib/smtp/client');
var SMTPStartTls = require('../../../../src/lib/smtp/extensions/startTls');
var SMTPExtension = require('../../../../src/lib/smtp/extension');

describe('ESMTP Plugin - STARTTLS', function () {

	describe('constructor', function () {

		it("returns an SMTPExtension instance.", function () {
			var startTls = new SMTPStartTls();
			expect(startTls).to.be.an.instanceOf(SMTPStartTls);
			expect(startTls).to.be.an.instanceOf(SMTPExtension);
		});

	});

	describe("operations within SMTP Client", function () {

		it("registers within an SMTP Client instance", function () {
			var client = new SMTPClient();
			var startTls = new SMTPStartTls();
			client.enable(startTls);
			expect(client.extensions).to.include.keys('STARTTLS');
		});

		it("STARTTLS skips when client connects via SMTPS.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({secure: true});
			var startTls = new SMTPStartTls();
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtps://localhost:%d', serverPort);
				var client = new SMTPClient(uri, {tls: {rejectUnauthorized: false}});
				client.enable(startTls);
				client.on('close', function () {
					server.close();
				});
				client.on('error', function (error) {
					done(error);
					server.close();
				});
				client.connect().catch(function (error) {
					done(error);
					server.close();
				});
				client.on('ESMTP', function (reply, ready) {
					expect(client.security).to.exist;
					expect(client.security).to.contain.keys('type');
					expect(client.security.type).not.to.be.equal('STARTTLS');
					done();
					ready('QUIT');
				});

			});
		});

		it.only('activates TLS on insecure connections', function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var server = new SMTPServer({secure: false});
			var startTls = new SMTPStartTls();
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtp://localhost:%d', serverPort);
				var client = new SMTPClient(uri, {tls: {rejectUnauthorized: false}});
				client.enable(startTls);
				client.on('close', function () {
					server.close();
				});
				client.on('error', function (error) {
					done(error);
					server.close();
				});
				client.connect().catch(function (error) {
					done(error);
					server.close();
				});
				client.on('ESMTP', function (reply, ready) {
					expect(client.security).to.exist;
					expect(client.security).to.contain.keys('type');
					expect(client.security.type).to.be.equal('STARTTLS');
					done();
					ready('QUIT');
				});
			});

		});

	});


});