var SMTPServer = require('smtp-server').SMTPServer;
var Client = require('../../../src/lib/smtp/client');
var expect = require("chai").expect;

describe("SMTP Client", function () {
	describe("constructor", function () {
		it("returns an instance connecting to localhost:25 when called with no arguments.", function () {
			var client = new Client();
			expect(client).to.be.instanceOf(Client);
			expect(client.scheme).to.equal('smtp');
			expect(client.host).to.equal('localhost');
			expect(client.port).to.equal(25);
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
			client.on('error', function () {
			});
			client.connect().then(function () {
				done("connect()'s promise should not resolve.");
			}).catch(function (err) {
				try {
					expect(err).to.be.instanceOf(Error);
					done();
				} catch (error) {
					done(error);
				}
			});
		});

		it("emits an error event with the current protocol phase when connect() fails.", function (done) {
			var client = new Client('smtp://localhost:61441');
			client.on('error', function (error) {
				expect(error.phase).to.be.equal('CONNECT');
				done();
			});
			client.connect().then(function () {
				done("connect()'s promise should not resolve.");
			}).catch(function () {
			});
		});

	});

});
