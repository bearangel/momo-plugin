// IMAP modified UTF-7（RFC 3501 §5.1.3）：`&` 段为 UTF-16BE base64（',' 代替 '/'），`&-` 表字面 '&'。
'use strict';

function decodeSegment(body) {
  const b64 = body.replace(/,/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bytes = Buffer.from(padded, 'base64');
  if (bytes.length < 2 || bytes.length % 2 !== 0) throw new Error('invalid modified-UTF-7');
  const swapped = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1];
    swapped[i + 1] = bytes[i];
  }
  return swapped.toString('utf16le');
}

function decodeModifiedUtf7(str) {
  if (typeof str !== 'string' || !str.includes('&')) return str;
  return str.replace(/&([A-Za-z0-9+,]*)-/g, (whole, body) => {
    if (body === '') return '&';
    try { return decodeSegment(body); } catch { return whole; }
  });
}

module.exports = { decodeModifiedUtf7 };
