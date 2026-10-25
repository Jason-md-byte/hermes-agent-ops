// Illustrative sketch (not the deployed code) of the two ideas that mattered most
// when fixing an auto-approving OAuth server:
//   1. a consent step that needs a secret, compared in constant time
//   2. failing closed at startup if the secret is missing
import crypto from "node:crypto";

const MIN_SECRET_LENGTH = 24;

export type ConsentConfig = { approvalSecret: Buffer };

export function loadConsentConfig(env: NodeJS.ProcessEnv): ConsentConfig {
  const raw = env.APPROVAL_SECRET;
  if (!raw || raw.length < MIN_SECRET_LENGTH) {
    // Fail closed: a forgotten env var must not silently re-open the hole.
    console.error("FATAL: APPROVAL_SECRET missing or too short");
    process.exit(1);
  }
  return { approvalSecret: Buffer.from(raw) };
}

export function secretMatches(config: ConsentConfig, submitted: string): boolean {
  // Hash both sides so lengths are equal and timingSafeEqual cannot throw.
  const a = crypto.createHash("sha256").update(config.approvalSecret).digest();
  const b = crypto.createHash("sha256").update(submitted).digest();
  return crypto.timingSafeEqual(a, b);
}

// Redirect allowlist: exact known callbacks, or loopback with any port.
const LOOPBACK = /^http:\/\/(localhost|127\.0\.0\.1):\d+\/\S*$/;

export function redirectAllowed(uri: string, allowed: readonly string[]): boolean {
  return allowed.includes(uri) || LOOPBACK.test(uri);
}
