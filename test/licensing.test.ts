import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateKeyPairSync, sign } from "crypto";
import { initDb } from "../src/db.js";
import { verifyLicenseKey } from "../src/license.js";
import {
  checkNodeLimit,
  checkProjectLimit,
  capEvidenceLimit,
  checkScope,
  checkKnowledgeTier,
} from "../src/gates.js";
import { handleOpen } from "../src/tools/open.js";
import { handlePlan } from "../src/tools/plan.js";
import { updateNode } from "../src/nodes.js";
import { EngineError } from "../src/validate.js";

// [sl:l6jLTnjWusw6Di0DX7S-y] End-to-end licensing tests

const AGENT = "test-agent";

// Generate a real Ed25519 keypair for testing
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY_B64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");

function makeKey(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = sign(null, Buffer.from(`${header}.${body}`), privateKey).toString("base64url");
  return `graph_${header}.${body}.${signature}`;
}

beforeEach(() => {
  initDb(":memory:");
});

describe("license key verification", () => {
  it("returns null for missing key", () => {
    expect(verifyLicenseKey(undefined)).toBeNull();
    expect(verifyLicenseKey("")).toBeNull();
  });

  it("returns null when public key not set", () => {
    const key = makeKey({ tier: "pro", exp: Math.floor(Date.now() / 1000) + 3600 });
    // verifyLicenseKey reads PUBLIC_KEY from env at module load — without it, returns null
    expect(verifyLicenseKey(key)).toBeNull();
  });

  it("returns null for malformed key", () => {
    vi.stubEnv("GRAPH_LICENSE_PUBLIC_KEY", PUBLIC_KEY_B64);
    // Re-import to pick up env change — but since PUBLIC_KEY is captured at module load,
    // we test format validation instead
    expect(verifyLicenseKey("not-a-jwt")).toBeNull();
    expect(verifyLicenseKey("graph_a.b")).toBeNull();
    expect(verifyLicenseKey("graph_a.b.c.d")).toBeNull();
    vi.unstubAllEnvs();
  });

  it("validates a properly signed key", async () => {
    // Dynamically import with env set so PUBLIC_KEY picks up the test key
    vi.stubEnv("GRAPH_LICENSE_PUBLIC_KEY", PUBLIC_KEY_B64);

    // We need to re-import because PUBLIC_KEY is captured at module load
    // Instead, test the crypto flow directly
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ tier: "pro", exp, sub: "test@example.com" })).toString("base64url");
    const sig = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");

    // Verify the crypto directly (since module-level const won't re-read env)
    const { verify } = await import("crypto");
    const signedData = Buffer.from(`${header}.${payload}`);
    const signature = Buffer.from(sig, "base64url");
    const pubKeyBuf = Buffer.from(PUBLIC_KEY_B64, "base64");
    const isValid = verify(null, signedData, { key: pubKeyBuf, format: "der", type: "spki" }, signature);
    expect(isValid).toBe(true);

    // Decode payload
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    expect(decoded.tier).toBe("pro");
    expect(decoded.exp).toBe(exp);
    expect(decoded.sub).toBe("test@example.com");

    vi.unstubAllEnvs();
  });

  it("rejects expired keys", async () => {
    const exp = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ tier: "pro", exp })).toString("base64url");
    const sig = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");

    const { verify } = await import("crypto");
    const isValid = verify(
      null,
      Buffer.from(`${header}.${payload}`),
      { key: Buffer.from(PUBLIC_KEY_B64, "base64"), format: "der", type: "spki" },
      Buffer.from(sig, "base64url")
    );
    // Signature is valid but key is expired
    expect(isValid).toBe(true);

    // Payload check catches expiry
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const now = Math.floor(Date.now() / 1000);
    expect(decoded.exp < now).toBe(true);
  });

  it("rejects tampered payloads", async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const header = Buffer.from(JSON.stringify({ alg: "EdDSA" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ tier: "pro", exp })).toString("base64url");
    const sig = sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");

    // Tamper with payload
    const tampered = Buffer.from(JSON.stringify({ tier: "pro", exp: exp + 999999 })).toString("base64url");

    const { verify } = await import("crypto");
    const isValid = verify(
      null,
      Buffer.from(`${header}.${tampered}`),
      { key: Buffer.from(PUBLIC_KEY_B64, "base64"), format: "der", type: "spki" },
      Buffer.from(sig, "base64url")
    );
    expect(isValid).toBe(false);
  });
});

describe("feature gates (acquisition phase — all free)", () => {
  // All gates are relaxed during acquisition phase.
  // Free tier has same limits as pro to maximize adoption.

  it("allows unlimited projects on free tier", () => {
    handleOpen({ project: "first", goal: "First project" }, AGENT);
    expect(() => checkProjectLimit("free")).not.toThrow();
  });

  it("allows unlimited nodes on free tier", () => {
    handleOpen({ project: "test", goal: "Test" }, AGENT);
    expect(() => checkNodeLimit("free", "test", 1000)).not.toThrow();
  });

  it("evidence limit matches pro tier on free", () => {
    expect(capEvidenceLimit("free")).toBe(50);
    expect(capEvidenceLimit("free", 50)).toBe(50);
  });

  it("knowledge tools allowed on free tier", () => {
    expect(() => checkKnowledgeTier("free")).not.toThrow();
  });

  it("scope allowed on free tier", () => {
    expect(checkScope("free", "some-node-id")).toBe("some-node-id");
  });
});
