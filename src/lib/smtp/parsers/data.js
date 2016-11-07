var _ = require('underscore');
var stream = require('stream');

module.exports.DotEncoder = DotEncoder;
//module.exports.DotDecoder = DotDecoder;

DotEncoder.prototype = Object.create(stream.Transform.prototype);
DotEncoder.prototype.constructor = DotEncoder;

var CR = 0x0d;
var LF = 0x0a;
var DOT = 0x2e;

function DotEncoder(options) {
	stream.Transform.call(this, options);
	this.isLineStart = true;
	this.buffer = Buffer.alloc(1024, 0x00);
	this.bufferSize = 0;
	this.lastChar = 0x00;
}

DotEncoder.prototype._transform = function (chunk, encoding, callback) {
	if (encoding !== 'buffer') {
		chunk = Buffer.from(chunk, encoding);
	}
	var chunkPos = 0;
	var currentChar;
	var write2Buffer = _.bind(function(c) {
		this.buffer.writeUInt8(c, this.bufferSize++);
		this.lastChar = c;
		if ( this.bufferSize == this.buffer.length ) {
			this.push(this.buffer);
			this.bufferSize = 0;
		}
	}, this);
	while (chunkPos < chunk.length) {
		currentChar = chunk.readUInt8(chunkPos);
		// Convert "dot" characters to double "dots" at line beginning.
		if ( this.lastChar == 0x00 || this.lastChar == LF ) {
			if ( currentChar == DOT ) {
				write2Buffer(DOT);
			}
		}
		// Convert bare CR and LF into CRLF.
		if ( currentChar != LF && this.lastChar == CR ) {
			write2Buffer(LF);
			continue;
		}
		if ( currentChar == LF && this.lastChar != CR ) {
			write2Buffer(CR);
		}
		write2Buffer(currentChar);
		chunkPos++;
	}
	callback();
};

DotEncoder.prototype._flush = function (callback) {
	this.push(this.buffer.slice(0, this.bufferSize));
	if ( this.lastChar == CR ) {
		// Append an LF if there is a bare CR at the end of the input.
		this.push(Buffer.from([LF]));
		this.lastChar = LF;
	} else if ( this.lastChar != LF ) {
		// Append a CRLF if the input does not end with a newline.
		this.push(Buffer.from([ CR, LF ]));
		this.lastChar = LF;
	}
	// Append final DOT + newline to finish the input.
	this.push(Buffer.from([ DOT, CR, LF]));
	callback();
};