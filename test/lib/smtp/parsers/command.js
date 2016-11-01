var expect = require("chai").expect;
var events = require('events');
var os = require('os');
var stream = require('stream');
var strfmt = require('util').format;
var _ = require('underscore');

var SMTPCommandLineParser = require('../../../../src/lib/smtp/parsers/command');

describe("SMTP Command Line Parser", function () {

	describe('Constructor', function () {
		it('Constructor returns a SMTPCommandLineParser instance.', function () {
			var parser = new SMTPCommandLineParser({utf8: true});
			expect(parser).to.be.instanceOf(SMTPCommandLineParser);
			expect(parser.chunks).to.be.an('array');
			expect(parser.totalSize).to.be.equal(0);
			expect(parser.error).to.be.equal(false);
		});
		it('SMTPCommandLineParser inherits from EventEmitter.', function () {
			var parser = new SMTPCommandLineParser({utf8: true});
			expect(parser).to.be.instanceOf(events.EventEmitter);
		});
	});

	describe('parses currentCommand lines to SMTP commands', function () {

		it('throws error on empty currentCommand lines.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('');
			}).to.throw;
		});

		it('throws error on currentCommand lines that exceed allowed line length.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				var longline = Buffer.alloc(512, 97).toString('utf8');
				parser.parseCommandLine(longline);
			}).to.throw;
		});

		it('skips trailing whitespace', function () {
			var parser = new SMTPCommandLineParser();
			var cmd = parser.parseCommandLine('HELO     ');
			expect(cmd.verb).to.exist;
			expect(cmd.verb).to.be.equal('HELO');
		});

		it('skips trailing whitespace including CRLF', function () {
			var parser = new SMTPCommandLineParser();
			var cmd = parser.parseCommandLine("HELO     \r\n");
			expect(cmd.verb).to.exist;
			expect(cmd.verb).to.be.equal('HELO');
		});

		it('standard EHLO currentCommand', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('EHLO baleen.io');
			expect(command.verb).to.be.equal('EHLO');
			expect(command.domain).to.be.equal('baleen.io');
		});

		it('standard MAIL currentCommand', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:<test@baleen.io>');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.be.equal('test@baleen.io');
		});
		it('standard MAIL currentCommand with parameters', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:<test@baleen.io> SIZE=1000000 TESTPARAM');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.be.equal('test@baleen.io');
			expect(command.params).to.be.an('array');
			expect(command.params[0]).to.be.eql({SIZE: '1000000'});
			expect(command.params[1]).to.be.eql({TESTPARAM: true});
		});
		it('MAIL currentCommand where return path argument has missing brackets still ok.', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:test@baleen.io');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.be.equal('test@baleen.io');
		});
		it('MAIL currentCommand with empty return path argument ok.', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:<>');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.exist;
			expect(command.returnPath).to.be.equal('');
		});
		it('MAIL currentCommand throws an error when return path argument is omitted.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('MAIL');
			}).to.throw(Error);
		});
		it('MAIL currentCommand throws an error when return path argument is invalid.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('MAIL SIZE=100000');
			}).to.throw(Error);
		});
		it('standard RCPT currentCommand', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('RCPT TO:<test@baleen.io>');
			expect(command.verb).to.be.equal('RCPT');
			expect(command.forwardPath).to.be.equal('test@baleen.io');
		});
		it('RCPT currentCommand where forward path argument has missing brackets still ok.', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('RCPT TO:test@baleen.io');
			expect(command.verb).to.be.equal('RCPT');
			expect(command.forwardPath).to.be.equal('test@baleen.io');
		});
		it('RCPT currentCommand with empty forward path argument throws an error.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('RCPT TO:<>');
			}).to.throw(Error);
		});
		it('RCPT currentCommand throws an error when forward path argument is omitted.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('RCPT');
			}).to.throw(Error);
		});
		it('RCPT currentCommand throws an error when forward path argument is invalid.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('RCPT SIZE=100000');
			}).to.throw(Error);
		});
		it('standard RCPT currentCommand with parameters', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('RCPT TO:<test@baleen.io> SIZE=1000000 TESTPARAM');
			expect(command.verb).to.be.equal('RCPT');
			expect(command.forwardPath).to.be.equal('test@baleen.io');
			expect(command.params).to.be.an('array');
			expect(command.params[0]).to.be.eql({SIZE: '1000000'});
			expect(command.params[1]).to.be.eql({TESTPARAM: true});
		});
	});

	describe('constructs valid SMTP commands from parsing results.', function () {
		it('empty input results in NOOP.', function () {
			var cmdLine = SMTPCommandLineParser.cmdToString();
			expect(cmdLine).to.be.equal("NOOP\r\n");
		});
		it('empty verb throws an error.', function () {
			expect(function () {
				SMTPCommandLineParser.cmdToString({});
			}).to.throw(Error);
		});
		it('verb only commands', function () {
			expect(SMTPCommandLineParser.cmdToString({verb: 'NOOP'})).to.be.equal("NOOP\r\n");
			expect(SMTPCommandLineParser.cmdToString({verb: 'QUIT'})).to.be.equal("QUIT\r\n");
			expect(SMTPCommandLineParser.cmdToString({verb: 'RSET'})).to.be.equal("RSET\r\n");
		});
		it('EHLO currentCommand with domain.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'EHLO',
				domain: 'baleen.io'
			})).to.be.equal("EHLO baleen.io\r\n");
		});
		it('EHLO currentCommand without domain throws an error.', function () {
			expect(function () {
				SMTPCommandLineParser.cmdToString({verb: 'EHLO'});
			}).to.throw(Error);
		});
		it('MAIL currentCommand accepted without a return path.', function () {
			expect(SMTPCommandLineParser.cmdToString({verb: 'MAIL'})).to.be.equal("MAIL FROM:<>\r\n");
		});
		it('MAIL currentCommand with return path.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'MAIL',
				returnPath: 'test@baleen.io'
			})).to.be.equal("MAIL FROM:<test@baleen.io>\r\n");
		});
		it('MAIL currentCommand with return path and params.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'MAIL',
				returnPath: 'test@baleen.io',
				params: [
					{SIZE: 100000}
				]
			})).to.be.equal("MAIL FROM:<test@baleen.io> SIZE=100000\r\n");
		});
		it('RCPT currentCommand throws an error without a forward path.', function () {
			expect(function () {
				SMTPCommandLineParser.cmdToString({verb: 'RCPT'})
			}).to.throw(Error);
		});
		it('RCPT currentCommand with forward path.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'RCPT',
				forwardPath: 'test@baleen.io'
			})).to.be.equal("RCPT TO:<test@baleen.io>\r\n");
		});
		it('RCPT currentCommand with forward path and params.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'RCPT',
				forwardPath: 'test@baleen.io',
				params: [{
					SIZE: 10000
				}]
			})).to.be.equal("RCPT TO:<test@baleen.io> SIZE=10000\r\n");
		});
		it('Command preserves the order of input params.', function () {
			expect(SMTPCommandLineParser.cmdToString(
				{
					verb: 'RCPT',
					forwardPath: 'test@baleen.io',
					params: [
						{A: 1},
						{B: 2},
						{C: 3}
					]
				}
			)).to.be.equal("RCPT TO:<test@baleen.io> A=1 B=2 C=3\r\n");
		});
	});

	describe('Stream API', function() {

		it("parses simple SMTP currentCommand from streams.", function(done) {
			var parser = new SMTPCommandLineParser();
			parser.on('error', function(error) {
				done(error);
			});
			parser.on('currentCommand', function(command) {
				expect(command.verb).to.be.equal('QUIT');
				done();
			});
			var inputStream = new stream.Readable();
			inputStream._read = function noop() {};
			parser.parse(inputStream);
			inputStream.push("QUIT\r\n");
		});

		it("emits an error if the CRLF are in wrong order.", function(done) {
			var parser = new SMTPCommandLineParser();
			parser.on('error', function(error) {
				done();
			});
			parser.on('currentCommand', function(command) {
				done('Unexpected success.');
			});
			var inputStream = new stream.Readable();
			inputStream._read = function noop() {};
			parser.parse(inputStream);
			inputStream.push("QUIT\n\r");
		});

		it("emits an error if the LF is missing.", function(done) {
			var parser = new SMTPCommandLineParser();
			parser.on('error', function(error) {
				done();
			});
			parser.on('currentCommand', function(command) {
				done('Unexpected success.');
			});
			var inputStream = new stream.Readable();
			inputStream._read = function noop() {};
			parser.parse(inputStream);
			inputStream.push("QUIT\n");
		});

		it("emits an error if the CR is missing.", function(done) {
			var parser = new SMTPCommandLineParser();
			parser.on('error', function(error) {
				done();
			});
			parser.on('currentCommand', function(command) {
				done('Unexpected success.');
			});
			var inputStream = new stream.Readable();
			inputStream._read = function noop() {};
			parser.parse(inputStream);
			inputStream.push("REST\r");
			inputStream.push("RSET");
		});

		it("emits two separate currentCommand events when reading two consecutive commands.", function(done) {
			var parser = new SMTPCommandLineParser();
			var commands = [];
			parser.on('error', function(error) {
				done(error);
			});
			parser.on('currentCommand', function(command) {
				commands.push(command);
				if ( commands.length == 2 ) {
					expect(commands[0].verb).to.equal("RSET");
					expect(commands[1].verb).to.equal("QUIT");
					done();
				}
			});
			var inputStream = new stream.Readable();
			inputStream._read = function noop() {};
			parser.parse(inputStream);
			inputStream.push("RSET\r\n");
			inputStream.push("QUIT\r\n");
		});


		it("emits an error if the currentCommand line gets too long.", function(done) {
			var parser = new SMTPCommandLineParser();
			parser.on('error', function(error) {
				expect(error.message).to.be.equal('Command line length exceeds maximum of 512 octets violating RFC 5321 section 4.5.3.1.4.');
				done();
			});
			parser.on('currentCommand', function(command) {
				done("Unexpected 'currentCommand' event.");
			});
			var inputStream = new stream.Readable();
			inputStream._read = function noop() {};
			parser.parse(inputStream);
			for ( var idx = 0; idx < 105; idx++ ) {
				inputStream.push("XXXX ");
			}
		});
	});
});