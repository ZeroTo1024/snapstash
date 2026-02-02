const crypto = require("node:crypto");

const DEFAULT_PW_ENV = "SNAPSTASH_PW";
const DEFAULT_KDF_PARAMS = {
  N: 16384,
  r: 8,
  p: 1,
  keyLen: 32,
};

function resolvePassword(pw, pwEnv = DEFAULT_PW_ENV) {
  if (pw) return pw;
  if (pwEnv && process.env[pwEnv]) return process.env[pwEnv];
  return null;
}

function deriveKey(password, salt, kdfParams = DEFAULT_KDF_PARAMS) {
  const { N, r, p, keyLen } = kdfParams;
  return crypto.scryptSync(password, salt, keyLen, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  });
}

function encryptBuffer(plainBuffer, password, kdfParams = DEFAULT_KDF_PARAMS) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(password, salt, kdfParams);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    payload: ciphertext.toString("base64"),
    enc: {
      alg: "aes-256-gcm",
      kdf: "scrypt",
      kdfParams,
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
    },
  };
}

function decryptBuffer(payloadBase64, enc, password) {
  if (!enc || enc.alg !== "aes-256-gcm" || enc.kdf !== "scrypt") {
    throw new Error("不支持的加密格式");
  }
  const kdfParams = enc.kdfParams || DEFAULT_KDF_PARAMS;
  const salt = Buffer.from(enc.salt || "", "base64");
  const iv = Buffer.from(enc.iv || "", "base64");
  const tag = Buffer.from(enc.tag || "", "base64");
  if (!salt.length || !iv.length || !tag.length) {
    throw new Error("加密数据缺少参数");
  }

  const key = deriveKey(password, salt, kdfParams);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const ciphertext = Buffer.from(payloadBase64, "base64");
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

module.exports = {
  DEFAULT_PW_ENV,
  DEFAULT_KDF_PARAMS,
  resolvePassword,
  encryptBuffer,
  decryptBuffer,
};
