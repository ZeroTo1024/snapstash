const zlib = require("node:zlib");

const { encryptRaw, decryptRaw } = require("./crypto");

const MAGIC = Buffer.from("SSBK");
const VERSION = 2;
const FLAG_COMPRESSED = 1;
const HEADER_LEN = 4 + 1 + 1 + 16 + 12 + 16;

function u16ByteLength(str) {
  return Buffer.byteLength(str || "", "utf8");
}

function u8ByteLength(str) {
  return Buffer.byteLength(str || "", "utf8");
}

function writeU16(buf, offset, value) {
  buf.writeUInt16BE(value, offset);
  return offset + 2;
}

function writeU32(buf, offset, value) {
  buf.writeUInt32BE(value, offset);
  return offset + 4;
}

function writeStringU16(buf, offset, value) {
  const text = value || "";
  const len = Buffer.byteLength(text, "utf8");
  offset = writeU16(buf, offset, len);
  if (len) {
    buf.write(text, offset, "utf8");
    offset += len;
  }
  return offset;
}

function writeStringU8(buf, offset, value) {
  const text = value || "";
  const len = Buffer.byteLength(text, "utf8");
  buf.writeUInt8(len, offset);
  offset += 1;
  if (len) {
    buf.write(text, offset, "utf8");
    offset += len;
  }
  return offset;
}

function packBackupBinary(backup) {
  const createdAt = backup.createdAt || "";
  const repoRoot = backup.repoRoot || "";
  const head = backup.head || "";
  const payloadEncoding = backup.payloadEncoding || "";
  const sourceMode = backup.source?.mode || "";
  const sourceRoot = backup.source?.root || "";
  const excludes = Array.isArray(backup.source?.excludes) ? backup.source.excludes : [];
  const data = Array.isArray(backup.data) ? backup.data : [];

  let size = 1;
  size += 2 + u16ByteLength(createdAt);
  size += 2 + u16ByteLength(repoRoot);
  size += 2 + u16ByteLength(head);
  size += 1 + u8ByteLength(payloadEncoding);
  size += 1 + u8ByteLength(sourceMode);
  size += 2 + u16ByteLength(sourceRoot);
  size += 2;
  for (const ex of excludes) {
    size += 2 + u16ByteLength(ex);
  }
  size += 4;
  const dataBuffers = data.map((entry) => Buffer.from(entry, "base64"));
  for (const buf of dataBuffers) {
    size += 4 + buf.length;
  }

  const buffer = Buffer.alloc(size);
  let offset = 0;
  buffer.writeUInt8(backup.version || 2, offset);
  offset += 1;
  offset = writeStringU16(buffer, offset, createdAt);
  offset = writeStringU16(buffer, offset, repoRoot);
  offset = writeStringU16(buffer, offset, head);
  offset = writeStringU8(buffer, offset, payloadEncoding);
  offset = writeStringU8(buffer, offset, sourceMode);
  offset = writeStringU16(buffer, offset, sourceRoot);
  offset = writeU16(buffer, offset, excludes.length);
  for (const ex of excludes) {
    offset = writeStringU16(buffer, offset, ex);
  }
  offset = writeU32(buffer, offset, dataBuffers.length);
  for (const buf of dataBuffers) {
    offset = writeU32(buffer, offset, buf.length);
    buf.copy(buffer, offset);
    offset += buf.length;
  }

  return buffer;
}

function readU16(buf, offset) {
  return { value: buf.readUInt16BE(offset), offset: offset + 2 };
}

function readU32(buf, offset) {
  return { value: buf.readUInt32BE(offset), offset: offset + 4 };
}

function readStringU16(buf, offset) {
  const { value: len, offset: next } = readU16(buf, offset);
  if (!len) return { value: "", offset: next };
  return { value: buf.toString("utf8", next, next + len), offset: next + len };
}

function readStringU8(buf, offset) {
  const len = buf.readUInt8(offset);
  const next = offset + 1;
  if (!len) return { value: "", offset: next };
  return { value: buf.toString("utf8", next, next + len), offset: next + len };
}

function unpackBackupBinary(buffer) {
  let offset = 0;
  const version = buffer.readUInt8(offset);
  offset += 1;
  let out = readStringU16(buffer, offset);
  const createdAt = out.value;
  offset = out.offset;
  out = readStringU16(buffer, offset);
  const repoRoot = out.value;
  offset = out.offset;
  out = readStringU16(buffer, offset);
  const head = out.value;
  offset = out.offset;
  out = readStringU8(buffer, offset);
  const payloadEncoding = out.value;
  offset = out.offset;
  out = readStringU8(buffer, offset);
  const sourceMode = out.value;
  offset = out.offset;
  out = readStringU16(buffer, offset);
  const sourceRoot = out.value;
  offset = out.offset;
  const exCount = buffer.readUInt16BE(offset);
  offset += 2;
  const excludes = [];
  for (let i = 0; i < exCount; i += 1) {
    out = readStringU16(buffer, offset);
    excludes.push(out.value);
    offset = out.offset;
  }
  const { value: itemCount, offset: afterCount } = readU32(buffer, offset);
  offset = afterCount;
  const data = [];
  for (let i = 0; i < itemCount; i += 1) {
    const { value: len, offset: afterLen } = readU32(buffer, offset);
    offset = afterLen;
    const itemBuf = buffer.subarray(offset, offset + len);
    data.push(itemBuf.toString("base64"));
    offset += len;
  }

  return {
    version,
    createdAt,
    repoRoot,
    head: head || null,
    payloadEncoding,
    source: {
      mode: sourceMode || undefined,
      root: sourceRoot || undefined,
      excludes: excludes.length ? excludes : undefined,
    },
    data,
  };
}

function compressPayload(payload) {
  return zlib.brotliCompressSync(payload, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
    },
  });
}

function decompressPayload(payload) {
  return zlib.brotliDecompressSync(payload);
}

function encodeEncryptedToText(backup, password) {
  const binary = packBackupBinary(backup);
  const compressed = compressPayload(binary);
  const encrypted = encryptRaw(compressed, password);

  const header = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(header, 0);
  header[4] = VERSION;
  header[5] = FLAG_COMPRESSED;
  encrypted.salt.copy(header, 6);
  encrypted.iv.copy(header, 22);
  encrypted.tag.copy(header, 34);

  const combined = Buffer.concat([header, encrypted.ciphertext]);
  return combined.toString("base64");
}

function decodeEncryptedFromText(text, password) {
  const raw = Buffer.from(text.trim(), "base64");
  if (raw.length < HEADER_LEN) {
    throw new Error("备份文件格式不正确：长度不足");
  }

  const magic = raw.subarray(0, 4);
  if (!magic.equals(MAGIC)) {
    throw new Error("备份文件格式不正确：magic 不匹配");
  }

  const version = raw[4];
  if (version !== VERSION) {
    throw new Error(`备份文件版本不支持：${version}`);
  }

  const flags = raw[5];
  const salt = raw.subarray(6, 22);
  const iv = raw.subarray(22, 34);
  const tag = raw.subarray(34, 50);
  const ciphertext = raw.subarray(50);

  if (ciphertext.length === 0) {
    throw new Error("备份文件格式不正确：缺少密文");
  }

  const decrypted = decryptRaw(ciphertext, { salt, iv, tag }, password);
  const payload = flags & FLAG_COMPRESSED ? decompressPayload(decrypted) : decrypted;
  return unpackBackupBinary(payload);
}

function encodePlainToText(backup) {
  const binary = packBackupBinary(backup);
  const compressed = compressPayload(binary);
  return `SSP1:${compressed.toString("base64")}`;
}

function decodePlainFromText(text) {
  const value = text.startsWith("SSP1:") ? text.slice(5) : text.trim();
  const raw = Buffer.from(value, "base64");
  const payload = decompressPayload(raw);
  return unpackBackupBinary(payload);
}

function isEncryptedText(text) {
  const raw = Buffer.from(text.trim(), "base64");
  if (raw.length < 4) return false;
  return raw.subarray(0, 4).equals(MAGIC);
}

function parseBackupText(text, password) {
  const trimmed = text.trim();
  if (trimmed.startsWith("SSP1:")) {
    return decodePlainFromText(trimmed);
  }
  if (isEncryptedText(trimmed)) {
    if (!password) {
      throw new Error("该备份已加密：请提供密码");
    }
    return decodeEncryptedFromText(trimmed, password);
  }
  return decodePlainFromText(trimmed);
}

module.exports = {
  encodeEncryptedToText,
  decodeEncryptedFromText,
  encodePlainToText,
  decodePlainFromText,
  parseBackupText,
};
