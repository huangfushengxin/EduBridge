// 本地测试夹具：生成纯色 PNG 与拒绝用例文件（仅开发用，不进入发布产物）
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = dirname(fileURLToPath(import.meta.url));
mkdirSync(dir, { recursive: true });

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function makePng(w, h, base, varyRow = 0) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const rows = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    const drift = varyRow ? Math.round((y / h) * varyRow) : 0;
    for (let x = 0; x < w; x++) {
      row[1 + x * 3] = Math.min(255, base[0] + drift);
      row[1 + x * 3 + 1] = Math.min(255, base[1] + drift);
      row[1 + x * 3 + 2] = Math.min(255, base[2] + drift);
    }
    rows.push(row);
  }
  const idat = deflateSync(Buffer.concat(rows));
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// 原卷两页（浅暖色）、答题卡一页（浅冷色），尺寸 600x800，页面大小的合法 PNG
writeFileSync(join(dir, "paper-1.png"), makePng(600, 800, [250, 246, 238], 6));
writeFileSync(join(dir, "paper-2.png"), makePng(600, 800, [244, 240, 232], 10));
writeFileSync(join(dir, "sheet-1.png"), makePng(600, 800, [236, 242, 246], 8));

// 拒绝用例：错误类型（txt 内容）、超限大小（>10MB）
writeFileSync(join(dir, "not-an-image.txt"), "这不是图片文件，用于类型拒绝测试。\n");
writeFileSync(join(dir, "big.png"), Buffer.alloc(11 * 1024 * 1024, 7));

console.log("test fixtures written to", dir);
