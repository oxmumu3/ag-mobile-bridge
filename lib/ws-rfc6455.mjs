import crypto from 'node:crypto';
import EventEmitter from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/**
 * Lightweight zero-dependency RFC 6455 WebSocket server upgrade & framing connection.
 */
export class WebSocketPeer extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0)) {
    super();
    this.socket = socket;
    this.buffer = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
    this.closed = false;
    this.fragOpcode = null;
    this.fragChunks = [];

    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.#onData(chunk));
    socket.on('close', () => this.#markClosed(1006, 'Socket closed'));
    socket.on('error', (err) => {
      if (!this.closed && this.listenerCount('error') > 0) this.emit('error', err);
      this.#markClosed(1006, 'Socket error');
    });

    if (this.buffer.length > 0) {
      queueMicrotask(() => this.#drainFrames());
    }
  }

  sendText(text) {
    if (this.closed) return false;
    const payload = Buffer.from(String(text), 'utf8');
    return this.#sendFrame(0x1, payload);
  }

  sendPong(payload = Buffer.alloc(0)) {
    if (this.closed) return false;
    return this.#sendFrame(0xA, payload);
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuf = Buffer.from(reason, 'utf8');
    const body = Buffer.allocUnsafe(2 + reasonBuf.length);
    body.writeUInt16BE(code, 0);
    reasonBuf.copy(body, 2);
    try {
      this.#sendFrame(0x8, body);
    } catch {}
    this.#markClosed(code, reason);
    try { this.socket.end(); } catch {}
  }

  #sendFrame(opcode, payload) {
    if (this.closed || this.socket.destroyed || !this.socket.writable) {
      return false;
    }
    const len = payload.length;
    let header;
    if (len <= 125) {
      header = Buffer.allocUnsafe(2);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = len;
    } else if (len <= 65535) {
      header = Buffer.allocUnsafe(4);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.allocUnsafe(10);
      header[0] = 0x80 | (opcode & 0x0f);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      const frame = Buffer.concat([header, payload]);
      this.socket.write(frame, (err) => {
        if (err) this.#markClosed(1006, 'Socket write error');
      });
      return true;
    } catch {
      this.#markClosed(1006, 'Socket write error');
      return false;
    }
  }

  #onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.#drainFrames();
  }

  #drainFrames() {
    while (!this.closed) {
      const frame = this.#parseNextFrame();
      if (!frame) break;
      this.#handleFrame(frame);
    }
  }

  #parseNextFrame() {
    if (this.buffer.length < 2) return null;
    const b0 = this.buffer[0];
    const b1 = this.buffer[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;

    let offset = 2;
    let len = b1 & 0x7f;
    if (len === 126) {
      if (this.buffer.length < offset + 2) return null;
      len = this.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (this.buffer.length < offset + 8) return null;
      const bigLen = this.buffer.readBigUInt64BE(offset);
      if (bigLen > BigInt(16 * 1024 * 1024)) {
        this.close(1009, 'Frame too large');
        return null;
      }
      len = Number(bigLen);
      offset += 8;
    }

    let maskKey = null;
    if (masked) {
      if (this.buffer.length < offset + 4) return null;
      maskKey = this.buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (this.buffer.length < offset + len) return null;
    const rawPayload = Buffer.from(this.buffer.subarray(offset, offset + len));
    this.buffer = this.buffer.subarray(offset + len);

    if (masked && maskKey) {
      for (let i = 0; i < rawPayload.length; i += 1) {
        rawPayload[i] ^= maskKey[i % 4];
      }
    }
    return { fin, opcode, payload: rawPayload };
  }

  #handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
      this.close(code, reason);
      return;
    }
    if (opcode === 0x9) {
      this.sendPong(payload);
      return;
    }
    if (opcode === 0xA) {
      this.emit('pong', payload);
      return;
    }

    if (opcode === 0x0) {
      if (this.fragOpcode === null) return;
      this.fragChunks.push(payload);
      if (fin) {
        const merged = Buffer.concat(this.fragChunks);
        const origOpcode = this.fragOpcode;
        this.fragOpcode = null;
        this.fragChunks = [];
        if (origOpcode === 0x1) this.emit('text', merged.toString('utf8'));
        else this.emit('binary', merged);
      }
      return;
    }

    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) {
        if (opcode === 0x1) this.emit('text', payload.toString('utf8'));
        else this.emit('binary', payload);
      } else {
        this.fragOpcode = opcode;
        this.fragChunks = [payload];
      }
    }
  }

  #markClosed(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', { code, reason });
  }
}

export function acceptWebSocketUpgrade(req, socket, head) {
  const swallowEarlyErr = () => {};
  socket.on('error', swallowEarlyErr);

  const key = req.headers['sec-websocket-key'];
  if (!key || typeof key !== 'string') {
    try {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    } catch {}
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(key.trim() + WS_GUID).digest('base64');
  const headers = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n');
  try {
    socket.write(headers);
  } catch {
    socket.destroy();
    return null;
  }
  const peer = new WebSocketPeer(socket, head);
  socket.removeListener('error', swallowEarlyErr);
  return peer;
}
