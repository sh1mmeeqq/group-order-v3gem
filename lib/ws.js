'use strict';
// Минимальный WebSocket-сервер (RFC 6455) поверх http 'upgrade'. Без зависимостей.
// Поддержано: рукопожатие, текстовые фреймы, фрагментация, ping/pong, close,
// лимит размера сообщения, проверка маскирования клиентских фреймов.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 16 * 1024;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

class Conn extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.closed = false;
    this.alive = true;
    this.frag = null; // { chunks, size }
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
  }

  send(text) {
    if (this.closed) return;
    this.socket.write(frame(0x1, Buffer.from(text, 'utf8')));
  }

  ping() {
    if (!this.closed) this.socket.write(frame(0x9, Buffer.alloc(0)));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    try {
      this.socket.write(frame(0x8, p));
      this.socket.end();
    } catch { /* сокет уже закрыт */ }
    this._finish();
  }

  terminate() {
    this.socket.destroy();
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      const buf = this.buf;
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (b0 & 0x70) return this.close(1002); // RSV-биты не согласованы
      if (!masked) return this.close(1002); // клиентские фреймы обязаны быть замаскированы
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_MESSAGE) return this.close(1009);
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = buf[off + 4 + i] ^ mask[i & 3];
      this.buf = buf.subarray(off + 4 + len);
      this._frame(fin, opcode, payload);
    }
  }

  _frame(fin, opcode, payload) {
    if (opcode >= 0x8) { // управляющие фреймы
      if (!fin || payload.length > 125) return this.close(1002);
      if (opcode === 0x8) return this.close(1000);
      if (opcode === 0x9) { this.socket.write(frame(0xa, payload)); return; }
      if (opcode === 0xa) { this.alive = true; return; }
      return this.close(1002);
    }
    if (opcode === 0x1 || opcode === 0x2) {
      if (this.frag) return this.close(1002);
      if (opcode === 0x2) return this.close(1003); // бинарные сообщения не используются
      if (fin) return this.emit('message', payload.toString('utf8'));
      this.frag = { chunks: [payload], size: payload.length };
      return;
    }
    if (opcode === 0x0) {
      if (!this.frag) return this.close(1002);
      this.frag.size += payload.length;
      if (this.frag.size > MAX_MESSAGE) return this.close(1009);
      this.frag.chunks.push(payload);
      if (fin) {
        const text = Buffer.concat(this.frag.chunks).toString('utf8');
        this.frag = null;
        this.emit('message', text);
      }
      return;
    }
    this.close(1002);
  }
}

// Подключает WebSocket к http.Server. verifyOrigin защищает от cross-site WebSocket hijacking.
function attach(server, { path, onConnection, verifyOrigin }) {
  const conns = new Set();

  server.on('upgrade', (req, socket, head) => {
    const reject = (status, text) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    let pathname;
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { return reject(400, 'Bad Request'); }
    const key = req.headers['sec-websocket-key'];
    if (pathname !== path) return reject(404, 'Not Found');
    if (String(req.headers.upgrade).toLowerCase() !== 'websocket' || !key) return reject(400, 'Bad Request');
    if (req.headers['sec-websocket-version'] !== '13') return reject(426, 'Upgrade Required');
    if (verifyOrigin && !verifyOrigin(req)) return reject(403, 'Forbidden');

    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    const conn = new Conn(socket);
    conn.ip = req.socket.remoteAddress;
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    onConnection(conn, req);
    if (head && head.length) conn._onData(head);
  });

  // Сердцебиение: два пропущенных pong подряд = обрыв.
  const timer = setInterval(() => {
    for (const c of conns) {
      if (!c.alive) { c.terminate(); continue; }
      c.alive = false;
      c.ping();
    }
  }, 20000);
  timer.unref();

  return {
    count: () => conns.size,
    closeAll: () => { clearInterval(timer); for (const c of conns) c.terminate(); },
  };
}

module.exports = { attach, Conn };
