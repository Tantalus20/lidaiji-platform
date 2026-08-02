"use strict";

const crypto = require("node:crypto");

const b64 = (value) => Buffer.from(value).toString("base64url");

function hashPassword(password, salt = crypto.randomBytes(16)) {
  if (typeof password !== "string" || password.length < 12 || password.length > 256) {
    throw new Error("管理员密码必须为12至256个字符。");
  }
  const derived = crypto.scryptSync(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${b64(salt)}$${b64(derived)}`;
}

function verifyPassword(password, encoded) {
  try {
    const [algorithm, n, r, p, salt, expected] = String(encoded).split("$");
    if (algorithm !== "scrypt") return false;
    const derived = crypto.scryptSync(password, Buffer.from(salt, "base64url"), 64, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(derived, Buffer.from(expected, "base64url"));
  } catch {
    return false;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function fingerprint(secret, value) {
  return crypto.createHmac("sha256", secret).update(String(value)).digest("hex");
}

function parseCookies(header = "") {
  return Object.fromEntries(String(header).split(";").map((item) => item.trim()).filter(Boolean).map((item) => {
    const index = item.indexOf("=");
    return [decodeURIComponent(item.slice(0, index)), decodeURIComponent(item.slice(index + 1))];
  }));
}

function safeText(value, min, max, label) {
  const text = String(value ?? "").normalize("NFC").trim();
  if (text.length < min || text.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) {
    throw Object.assign(new Error(`${label}长度或字符不符合要求。`), { statusCode: 400 });
  }
  if (/[<>]/u.test(text)) {
    throw Object.assign(new Error(`${label}不允许包含HTML标签。`), { statusCode: 400 });
  }
  return text;
}

module.exports = { hashPassword, verifyPassword, randomToken, sha256, fingerprint, parseCookies, safeText };
