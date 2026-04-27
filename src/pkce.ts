const VERIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]!);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function generateVerifier(length = 64): string {
  if (length < 43 || length > 128) {
    throw new Error("PKCE verifier must be 43-128 characters");
  }
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let out = "";
  for (let i = 0; i < length; i++) {
    out += VERIFIER_CHARS[buf[i]! % VERIFIER_CHARS.length];
  }
  return out;
}

export async function challengeFromVerifier(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(digest);
}

export async function generatePkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = generateVerifier();
  const challenge = await challengeFromVerifier(verifier);
  return { verifier, challenge };
}
