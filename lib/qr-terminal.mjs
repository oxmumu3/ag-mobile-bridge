import fs from 'node:fs';
import zlib from 'node:zlib';
import qrcodeFactory from './vendor/qrcode.mjs';

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC32_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function writeQrPngFile(rows, outPath, { scale = 10, quietZone = 4 } = {}) {
  const h = rows.length;
  const w = h > 0 ? rows[0].length : 0;
  const totalW = (w + quietZone * 2) * scale;
  const totalH = (h + quietZone * 2) * scale;
  const stride = totalW + 1; // filter byte + 8-bit grayscale pixels
  const raw = Buffer.alloc(stride * totalH, 255);

  for (let py = 0; py < totalH; py += 1) {
    raw[py * stride] = 0; // PNG filter type 0 (None)
  }

  for (let y = 0; y < h; y += 1) {
    const row = rows[y];
    for (let x = 0; x < w; x += 1) {
      if (row[x] !== '1') continue;
      const startY = (y + quietZone) * scale;
      const startX = (x + quietZone) * scale;
      for (let dy = 0; dy < scale; dy += 1) {
        const base = (startY + dy) * stride + 1 + startX;
        raw.fill(0, base, base + scale);
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(totalW, 0);
  ihdr.writeUInt32BE(totalH, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const png = Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(outPath, png);
}

/**
 * Generate an exact QR bit matrix (and optional PNG file) in pure cross-platform JS (macOS + Linux).
 */
export function generateQrMatrix(text, { pngOutputPath = '' } = {}) {
  const qr = qrcodeFactory(0, 'M');
  qr.addData(String(text));
  qr.make();
  const size = qr.getModuleCount();
  const rows = [];
  for (let y = 0; y < size; y += 1) {
    let row = '';
    for (let x = 0; x < size; x += 1) {
      row += qr.isDark(y, x) ? '1' : '0';
    }
    rows.push(row);
  }
  if (pngOutputPath) {
    writeQrPngFile(rows, String(pngOutputPath));
  }
  return { width: size, height: size, rows };
}

/**
 * Render a QR matrix as compact ANSI half-block characters for dark or light terminals.
 */
export function renderQrHalfBlocks(matrix, { quietZone = 2 } = {}) {
  const w = matrix.width;
  const h = matrix.height;
  const white = (s) => `\x1b[47;30m${s}\x1b[0m`;
  const totalW = w + quietZone * 2;
  const grid = [];

  for (let y = -quietZone; y < h + quietZone; y += 1) {
    let row = '';
    for (let x = -quietZone; x < w + quietZone; x += 1) {
      if (y < 0 || y >= h || x < 0 || x >= w) row += '0';
      else row += matrix.rows[y][x];
    }
    grid.push(row);
  }

  const lines = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y];
    const bot = y + 1 < grid.length ? grid[y + 1] : '0'.repeat(totalW);
    let line = '';
    for (let x = 0; x < totalW; x += 1) {
      const t = top[x] === '1';
      const b = bot[x] === '1';
      if (t && b) line += '█';
      else if (t && !b) line += '▀';
      else if (!t && b) line += '▄';
      else line += ' ';
    }
    lines.push(white(line));
  }
  return lines.join('\n');
}
