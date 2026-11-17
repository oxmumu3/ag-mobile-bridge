import { execFileSync } from 'node:child_process';

/**
 * Generate an exact QR bit matrix (and optional PNG file) via macOS CoreImage CIQRCodeGenerator.
 */
export function generateQrMatrix(text, { pngOutputPath = '' } = {}) {
  const jxa = `
ObjC.import("CoreImage");
ObjC.import("AppKit");
const payload = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("AG_QR_TEXT"));
const outPng = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey("AG_QR_PNG") || "");
const data = $.NSString.alloc.initWithUTF8String(payload).dataUsingEncoding($.NSUTF8StringEncoding);
const filter = $.CIFilter.filterWithName("CIQRCodeGenerator");
filter.setValueForKey(data, "inputMessage");
filter.setValueForKey($("M"), "inputCorrectionLevel");
const img = filter.outputImage;
const rep = $.NSBitmapImageRep.alloc.initWithCIImage(img);
const w = Number(rep.pixelsWide);
const h = Number(rep.pixelsHigh);
const rows = [];
for (let y = 0; y < h; y++) {
  let row = "";
  for (let x = 0; x < w; x++) {
    const c = rep.colorAtXY(x, y);
    row += (c.redComponent < 0.5 ? "1" : "0");
  }
  rows.push(row);
}
if (outPng) {
  const scale = 10;
  const pad = 4;
  const totalW = (w + pad * 2) * scale;
  const totalH = (h + pad * 2) * scale;
  const ctxImg = $.NSImage.alloc.initWithSize($.NSMakeSize(totalW, totalH));
  ctxImg.lockFocus;
  $.NSColor.whiteColor.setFill;
  $.NSRectFill($.NSMakeRect(0, 0, totalW, totalH));
  $.NSColor.blackColor.setFill;
  for (let y = 0; y < h; y++) {
    const row = rows[y];
    const drawY = (h - 1 - y + pad) * scale;
    for (let x = 0; x < w; x++) {
      if (row[x] === "1") {
        $.NSRectFill($.NSMakeRect((x + pad) * scale, drawY, scale, scale));
      }
    }
  }
  ctxImg.unlockFocus;
  const tiff = ctxImg.TIFFRepresentation;
  const scaledRep = $.NSBitmapImageRep.imageRepWithData(tiff);
  const pngData = scaledRep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  pngData.writeToFileAtomically(outPng, true);
}
JSON.stringify({ width: w, height: h, rows });
`;
  const raw = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', jxa], {
    env: {
      ...process.env,
      AG_QR_TEXT: String(text),
      AG_QR_PNG: pngOutputPath ? String(pngOutputPath) : '',
    },
    encoding: 'utf8',
    timeout: 5000,
  }).trim();
  return JSON.parse(raw);
}

/**
 * Render a CoreImage QR matrix as compact ANSI half-block characters for dark or light terminals.
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
