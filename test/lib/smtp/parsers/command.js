var expect = require("chai").expect;
var os = require('os');
var strfmt = require('util').format;
var _ = require('underscore');

var SMTPCommandLineParser = require('../../../../src/lib/smtp/parsers/command');

describe.only("SMTP Command Line Parser", function () {

	it('Constructor returns a SMTPCommandLineParser instance.', function () {
		var parser = new SMTPCommandLineParser({utf8: true});
		expect(parser).to.be.instanceOf(SMTPCommandLineParser);
		//noinspection BadExpressionStatementJS,JSUnresolvedVariable
		expect(parser.utf8).to.be.true;
		expect(parser.chunks).to.be.an('array');
		expect(parser.totalSize).to.be.equal(0);
		expect(parser.error).to.be.equal(false);
	});

	describe('parses command lines to SMTP commands', function () {

		it('throws error on empty command lines.', function () {
			var parser = new SMTPCommandLineParser();
			//noinspection BadExpressionStatementJS
			expect(function () {
				parser.parseCommandLine('');
			}).to.throw;
		});

		it('throws error on command lines that exceed allowed line length.', function () {
			var parser = new SMTPCommandLineParser();
			//noinspection BadExpressionStatementJS
			expect(function () {
				var longline = Buffer.alloc(512, 97).toString('utf8');
				parser.parseCommandLine(longline);
			}).to.throw;
		});

		it('skips trailing whitespace', function () {
			var parser = new SMTPCommandLineParser();
			var cmd = parser.parseCommandLine('HELO     ');
			//noinspection BadExpressionStatementJS
			expect(cmd.verb).to.exist;
			expect(cmd.verb).to.be.equal('HELO');
		});

		it('skips trailing whitespace including CRLF', function () {
			var parser = new SMTPCommandLineParser();
			var cmd = parser.parseCommandLine("HELO     \r\n");
			//noinspection BadExpressionStatementJS
			expect(cmd.verb).to.exist;
			expect(cmd.verb).to.be.equal('HELO');
		});

		it('standard EHLO command', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('EHLO baleen.io');
			expect(command.verb).to.be.equal('EHLO');
			expect(command.domain).to.be.equal('baleen.io');
		});

		it('standard MAIL command', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:<test@baleen.io>');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.be.equal('test@baleen.io');
		});
		it('standard MAIL command with parameters', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:<test@baleen.io> SIZE=1000000 TESTPARAM');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.be.equal('test@baleen.io');
			expect(command.params).to.be.an('array');
			expect(command.params[0]).to.be.eql({SIZE: '1000000'});
			expect(command.params[1]).to.be.eql({TESTPARAM: true});
		});
		it('MAIL command where return path argument has missing brackets still ok.', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:test@baleen.io');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.be.equal('test@baleen.io');
		});
		it('MAIL command with empty return path argument ok.', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('MAIL FROM:<>');
			expect(command.verb).to.be.equal('MAIL');
			expect(command.returnPath).to.exist;
			expect(command.returnPath).to.be.equal('');
		});
		it('MAIL command throws an error when return path argument is omitted.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('MAIL');
			}).to.throw(Error);
		});
		it('MAIL command throws an error when return path argument is invalid.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('MAIL SIZE=100000');
			}).to.throw(Error);
		});
		it('standard RCPT command', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('RCPT TO:<test@baleen.io>');
			expect(command.verb).to.be.equal('RCPT');
			expect(command.forwardPath).to.be.equal('test@baleen.io');
		});
		it('RCPT command where forward path argument has missing brackets still ok.', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('RCPT TO:test@baleen.io');
			expect(command.verb).to.be.equal('RCPT');
			expect(command.forwardPath).to.be.equal('test@baleen.io');
		});
		it('RCPT command with empty forward path argument throws an error.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('RCPT TO:<>');
			}).to.throw(Error);
		});
		it('RCPT command throws an error when forward path argument is omitted.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('RCPT');
			}).to.throw(Error);
		});
		it('RCPT command throws an error when forward path argument is invalid.', function () {
			var parser = new SMTPCommandLineParser();
			expect(function () {
				parser.parseCommandLine('RCPT SIZE=100000');
			}).to.throw(Error);
		});
		it('standard RCPT command with parameters', function () {
			var parser = new SMTPCommandLineParser();
			var command = parser.parseCommandLine('RCPT TO:<test@baleen.io> SIZE=1000000 TESTPARAM');
			expect(command.verb).to.be.equal('RCPT');
			expect(command.forwardPath).to.be.equal('test@baleen.io');
			expect(command.params).to.be.an('array');
			expect(command.params[0]).to.be.eql({SIZE: '1000000'});
			expect(command.params[1]).to.be.eql({TESTPARAM: true});
		});
	});

	describe.only('constructs valid SMTP commands from parsing results.', function () {
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
		it('EHLO command with domain.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'EHLO',
				domain: 'baleen.io'
			})).to.be.equal("EHLO baleen.io\r\n");
		});
		it('EHLO command without domain throws an error.', function () {
			expect(function () {
				SMTPCommandLineParser.cmdToString({verb: 'EHLO'});
			}).to.throw(Error);
		});
		it('MAIL command accepted without a return path.', function () {
			expect(SMTPCommandLineParser.cmdToString({verb: 'MAIL'})).to.be.equal("MAIL FROM:<>\r\n");
		});
		it('MAIL command with return path.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'MAIL',
				returnPath: 'test@baleen.io'
			})).to.be.equal("MAIL FROM:<test@baleen.io>\r\n");
		});
		it('MAIL command with return path and params.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'MAIL',
				returnPath: 'test@baleen.io',
				params: [
					{SIZE: 100000}
				]
			})).to.be.equal("MAIL FROM:<test@baleen.io> SIZE=100000\r\n");
		});
		it('RCPT command throws an error without a forward path.', function () {
			expect(function () {
				SMTPCommandLineParser.cmdToString({verb: 'RCPT'})
			}).to.throw(Error);
		});
		it('RCPT command with forward path.', function () {
			expect(SMTPCommandLineParser.cmdToString({
				verb: 'RCPT',
				forwardPath: 'test@baleen.io'
			})).to.be.equal("RCPT TO:<test@baleen.io>\r\n");
		});
		it('RCPT command with forward path and params.', function () {
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
});