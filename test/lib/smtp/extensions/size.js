var _ = require('underscore');
var expect = require("chai").expect;
var strfmt = require("util").format;

var SMTPServer = require('smtp-server').SMTPServer;
var SMTPClient = require('../../../../src/lib/smtp/client');
var SMTPSize = require('../../../../src/lib/smtp/extensions/size');
var SMTPExtension = require('../../../../src/lib/smtp/extension');

describe.only('ESMTP Plugin - SIZE', function () {

	describe('constructor', function () {

		it("returns an SMTPExtension instance.", function () {
			var size = new SMTPSize();
			expect(size).to.be.an.instanceOf(SMTPSize);
			expect(size).to.be.an.instanceOf(SMTPExtension);
		});

	});

	describe("operations within SMTP Client", function () {

		it("plugin registers within an SMTP Client instance.", function () {
			var client = new SMTPClient();
			var size = new SMTPSize();
			client.enable(size);
			expect(client.extensions).to.include.keys('SIZE');
		});

		it("plugin recognizes the maximum message size if the server advertises it.", function (done) {
			var serverPort = Math.floor(Math.random() * 20000) + 20000;
			var maxSize = Math.floor(Math.random()*900000)+100000;
			var server = new SMTPServer({
				size: maxSize,
				hideSTARTTLS: true
			});
			var smtpSize = new SMTPSize();
			server.listen(serverPort, "localhost", function (args) {
				var uri = strfmt('smtp://localhost:%d', serverPort);
				var client = new SMTPClient(uri);
				client.enable(smtpSize);
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
					expect(client.session.SIZE).to.exist;
					expect(client.session.SIZE).to.contain.keys('size');
					expect(client.session.SIZE.size).to.be.equal(maxSize);
					done();
					ready('QUIT');
				});

			});
		});
	});

});