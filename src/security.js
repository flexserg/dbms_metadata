import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export function safeEqual(a, b) {
  const x = createHmac("sha256", "comparison").update(String(a)).digest();
  const y = createHmac("sha256", "comparison").update(String(b)).digest();
  return timingSafeEqual(x, y);
}
export function vault(key) {
  if (!/^[a-f0-9]{64}$/i.test(key || ""))
    throw new Error("APP_KEY must be 64 hexadecimal characters");
  const secret = Buffer.from(key, "hex");
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", secret, iv);
      const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
      ]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
        "base64",
      );
    },
    open(value) {
      const bytes = Buffer.from(value, "base64");
      const decipher = createDecipheriv(
        "aes-256-gcm",
        secret,
        bytes.subarray(0, 12),
      );
      decipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString("utf8");
    },
    token(password) {
      const payload = `${Date.now() + 8 * 3600_000}.${randomBytes(16).toString("hex")}`;
      return `${payload}.${createHmac("sha256", secret)
        .update(payload + password)
        .digest("hex")}`;
    },
    verify(token, password) {
      if (typeof token !== "string") return false;
      const [expiry, nonce, signature] = token.split(".");
      if (!expiry || !nonce || !signature || Number(expiry) <= Date.now())
        return false;
      return safeEqual(
        signature,
        createHmac("sha256", secret)
          .update(`${expiry}.${nonce}` + password)
          .digest("hex"),
      );
    },
  };
}
