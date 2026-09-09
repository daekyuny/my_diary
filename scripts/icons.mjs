import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, bytes) {
  const body = Buffer.concat([Buffer.from(type), bytes]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
export async function makeIcons() {
  await mkdir('assets', { recursive: true });
  for (const size of [192, 512]) {
    const rows = Buffer.alloc((size * 3 + 1) * size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const u = (x / size) * 192;
        const v = (y / size) * 192;
        const book = u >= 53 && u <= 138 && v >= 53 && v <= 137;
        const spine = u >= 68 && u <= 72;
        const line = u >= 82 && u <= 123 && ((v >= 78 && v <= 83) || (v >= 96 && v <= 101));
        const dot = (u - 145) ** 2 + (v - 141) ** 2 < 9 ** 2;
        const color = dot
          ? [197, 213, 146]
          : book && !spine && !line
            ? [255, 254, 250]
            : [66, 104, 75];
        rows.set(color, y * (size * 3 + 1) + 1 + x * 3);
      }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    await writeFile(
      `assets/icon-${size}.png`,
      Buffer.concat([
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(rows)),
        chunk('IEND', Buffer.alloc(0)),
      ]),
    );
  }
}
