'use strict';
/**
 * Minimal ZIP reader (stored + deflate) used to inspect the data that
 * Playwright embeds in its HTML report, so the leak test can search it.
 */
const zlib = require('node:zlib');

function readZipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('Not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let n = 0; n < count; n++) {
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(start, start + compSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(data).toString('utf8') : data.toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Returns all text embedded in a Playwright HTML report's index.html. */
function playwrightReportText(html) {
  const m = /data:application\/zip;base64,([A-Za-z0-9+/=]+)/.exec(html);
  if (!m) return '';
  return Object.values(readZipEntries(Buffer.from(m[1], 'base64'))).join('\n');
}

module.exports = { readZipEntries, playwrightReportText };
