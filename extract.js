var stream = require('stream');
var util = require('util');
var bl = require('bl');
var headers = require('./headers');

var Writable = stream.Writable || require('readable-stream').Writable;
var PassThrough = stream.PassThrough || require('readable-stream').PassThrough;

var noop = function() {};

var overflow = function(size) {
	size &= 511;
	return size && 512 - size;
};

var emptyStream = function() {
	var s = new PassThrough();
	s.end();
	return s;
};

var mixinPax = function(header, pax) {
	if (pax.path) header.name = pax.path;
	if (pax.linkpath) header.linkname = pax.linkpath;
	return header;
};

var Extract = function(opts) {
	if (!(this instanceof Extract)) return new Extract(opts);
	Writable.call(this, opts);

	this._buffer = bl();
	this._missing = 0;
	this._onparse = noop;
	this._header = null;
	this._stream = null;
	this._overflow = null;
	this._cb = null;
	this._locked = false;
	this._destroyed = false;
	this._pax = null;

	var self = this;
	var b = self._buffer;

	var oncontinue = function() {
		self._continue();
	};

	var onunlock = function(err) {
		self._locked = false;
		if (err) return self.destroy(err);
		if (!self._stream) oncontinue();
	};

	var onstreamend = function() {
		self._stream = null;
		var drain = overflow(self._header.size);
		if (drain) self._parse(drain, ondrain);
		else self._parse(512, onheader);
		if (!self._locked) oncontinue();
	};

	var ondrain = function() {
		self._buffer.consume(overflow(self._header.size));
		self._parse(512, onheader);
		oncontinue();
	};

	var onpaxheader = function() {
		var size = self._header.size;
		self._pax = headers.decodePax(b.slice(0, size));
		b.consume(size);
		onstreamend();
	};

	var onheader = function() {
		var header
		try {
			header = self._header = headers.decode(b.slice(0, 512));
		} catch (err) {
			self.emit('error', err)
		}
		b.consume(512);

		if (!header) {
			self._parse(512, onheader);
			oncontinue();
			return;
		}
		if (header.type === 'pax-header') {
			self._parse(header.size, onpaxheader);
			oncontinue();
			return;
		}

		if (self._pax) {
			self._header = header = mixinPax(header, self._pax);
			self._pax = null;
		}

		self._locked = true;

		if (!header.size) {
			self._parse(512, onheader);
			self.emit('entry', header, emptyStream(), onunlock);
			return;
		}

		self._stream = new PassThrough();

		self.emit('entry', header, self._stream, onunlock);
		self._parse(header.size, onstreamend);
		oncontinue();
	};

	this._parse(512, onheader);
};

util.inherits(Extract, Writable);

Extract.prototype.destroy = function(err) {
	if (this._destroyed) return;
	this._destroyed = true;

	if (err) this.emit('error', err);
	this.emit('close');
	if (this._stream) this._stream.emit('close');
};

Extract.prototype._parse = function(size, onparse) {
	if (this._destroyed) return;
	this._missing = size;
	this._onparse = onparse;
};

Extract.prototype._continue = function(err) {
	if (this._destroyed) return;
	var cb = this._cb;
	this._cb = noop;
	if (this._overflow) this._write(this._overflow, undefined, cb);
	else cb();
};

Extract.prototype._write = function(data, enc, cb) {
	if (this._destroyed) return;

	var s = this._stream;
	var b = this._buffer;
	var missing = this._missing;

	// we do not reach end-of-chunk now. just forward it

	if (data.length < missing) {
		this._missing -= data.length;
		this._overflow = null;
		if (s) return s.write(data, cb);
		b.append(data);
		return cb();
	}

	// end-of-chunk. the parser should call cb.

	this._cb = cb;
	this._missing = 0;

	var overflow = null;
	if (data.length > missing) {
		overflow = data.slice(missing);
		data = data.slice(0, missing);
	}

	if (s) s.end(data);
	else b.append(data);

	this._overflow = overflow;
	this._onparse();
};

module.exports = Extract;
