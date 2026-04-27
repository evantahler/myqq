import { describe, expect, it } from "bun:test";
import {
  challengeFromVerifier,
  generatePkcePair,
  generateVerifier,
} from "../src/pkce.ts";

describe("pkce", () => {
  it("matches the RFC 7636 vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await challengeFromVerifier(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates a verifier in the legal length range", () => {
    const v = generateVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
    expect(v.length).toBeLessThanOrEqual(128);
    expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
  });

  it("rejects out-of-range verifier lengths", () => {
    expect(() => generateVerifier(10)).toThrow();
    expect(() => generateVerifier(200)).toThrow();
  });

  it("produces matching verifier/challenge pairs", async () => {
    const { verifier, challenge } = await generatePkcePair();
    expect(challenge).toBe(await challengeFromVerifier(verifier));
  });
});
