class Queue {
  constructor() { this._data = Buffer.alloc(0); }
  add(buffer) { this._data = Buffer.concat([this._data, buffer]); }
  get() { return this._data; }
  size() { return this._data.length; }
  release(size) { this._data = this._data.slice(size); }
  reset() { this._data = Buffer.alloc(0); }
}
module.exports = Queue;
