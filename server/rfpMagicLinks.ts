import { randomBytes } from "crypto";

type MagicLinkEntry = {
  token: string;
  rfpId: string;
  email: string;
  expiresAt: number;
};

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const magicLinks = new Map<string, MagicLinkEntry>();

export function createRfpMagicLinkToken(rfpId: string, email: string, ttlMs: number = TOKEN_TTL_MS) {
  const token = randomBytes(24).toString("hex");
  magicLinks.set(token, {
    token,
    rfpId,
    email: email.toLowerCase(),
    expiresAt: Date.now() + ttlMs,
  });
  return token;
}

export function consumeRfpMagicLinkToken(token: string, rfpId: string, email: string) {
  const entry = magicLinks.get(token);
  if (!entry) return false;
  magicLinks.delete(token);
  if (entry.rfpId !== rfpId) return false;
  if (entry.email !== email.toLowerCase()) return false;
  if (Date.now() > entry.expiresAt) return false;
  return true;
}
