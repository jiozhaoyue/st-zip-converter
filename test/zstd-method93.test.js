import { describe, it, expect } from 'vitest';
import { zipIo } from '../src/core/zip-io.js';
import * as zip from '../src/vendor/zip.js';
import cp from 'node:child_process';

function makeCrcTable() {
  const table = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
}

const crcTable = makeCrcTable();
function calculateCrc32(buf) {
  let c = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    c = (c >>> 8) ^ crcTable[(c ^ buf[i]) & 0xFF];
  }
  return (c ^ (-1)) >>> 0;
}

/**
 * 构造包含 Method 93 (Zstandard) 条目的标准 Zip 包
 */
function createMethod93ZipBuffer(filename, contentStr) {
  const rawBuf = Buffer.from(contentStr, 'utf-8');
  const compBuf = cp.execSync('zstd', { input: rawBuf });
  const crcVal = calculateCrc32(rawBuf);
  const fnBuf = Buffer.from(filename, 'utf-8');

  // Local File Header
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(63, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(93, 8); // Method 93 (Zstandard)
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(crcVal, 14);
  lfh.writeUInt32LE(compBuf.length, 18);
  lfh.writeUInt32LE(rawBuf.length, 22);
  lfh.writeUInt16LE(fnBuf.length, 26);
  lfh.writeUInt16LE(0, 28);

  // Central Directory Header
  const cdh = Buffer.alloc(46);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(63, 4);
  cdh.writeUInt16LE(63, 6);
  cdh.writeUInt16LE(0, 8);
  cdh.writeUInt16LE(93, 10); // Method 93
  cdh.writeUInt16LE(0, 12);
  cdh.writeUInt16LE(0, 14);
  cdh.writeUInt32LE(crcVal, 16);
  cdh.writeUInt32LE(compBuf.length, 20);
  cdh.writeUInt32LE(rawBuf.length, 24);
  cdh.writeUInt16LE(fnBuf.length, 28);
  cdh.writeUInt16LE(0, 30);
  cdh.writeUInt16LE(0, 32);
  cdh.writeUInt16LE(0, 34);
  cdh.writeUInt16LE(0, 36);
  cdh.writeUInt32LE(0, 38);
  cdh.writeUInt32LE(0, 42); // Offset: 0

  const cdOffset = lfh.length + fnBuf.length + compBuf.length;
  const cdSize = cdh.length + fnBuf.length;

  // EOCD
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([lfh, fnBuf, compBuf, cdh, fnBuf, eocd]);
}

describe('Method 93 (7-Zip ZS / TauriTavern Zstandard in Zip) Ingestion', () => {
  it('reads and decompresses Method 93 entries transparently via zipIo', async () => {
    const payload = 'This is TauriTavern character data compressed via 7-Zip-zstd Method 93!';
    const zipBuf = createMethod93ZipBuffer('characters/test-char.json', payload);

    const reader = await zipIo.openReader(new Blob([zipBuf]));
    expect(reader.totalEntries).toBe(1);

    let readCount = 0;
    for await (const entry of reader.entries()) {
      expect(entry.fileName).toBe('characters/test-char.json');
      expect(entry.compressionMethod).toBe(93);

      const contentBytes = await entry.read();
      const contentStr = new TextDecoder().decode(contentBytes);
      expect(contentStr).toBe(payload);
      readCount++;
    }

    expect(readCount).toBe(1);
    await reader.close();
  });
});
