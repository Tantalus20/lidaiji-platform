import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, checksum]);
}

function makePng(width, height, palette) {
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    row[0] = 0;
    for (let x = 0; x < width; x += 1) {
      const band = Math.min(palette.length - 1, Math.floor((x / width + y / height) * palette.length / 2));
      const [r, g, b] = palette[band];
      row[1 + x * 3] = r;
      row[2 + x * 3] = g;
      row[3 + x * 3] = b;
    }
    rows.push(row);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const articleImage = path.join(root, "content/works/demo-collection/chapter-one/demo-cover.png");
const collectionImage = path.join(root, "content/works/demo-collection/cover.png");
const longImage = path.join(root, "content/works/demo-collection/long-reading-test/demo-long.png");
for (const file of [articleImage, collectionImage, longImage]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}
fs.writeFileSync(articleImage, makePng(1200, 720, [[236, 226, 209], [181, 151, 118], [127, 67, 54], [48, 43, 37]]));
fs.writeFileSync(collectionImage, makePng(900, 1200, [[244, 239, 229], [204, 189, 164], [139, 89, 67], [45, 40, 35]]));
fs.writeFileSync(longImage, makePng(1200, 675, [[242, 235, 219], [192, 170, 137], [112, 79, 63], [43, 42, 38]]));
console.log("演示图片已生成。");
