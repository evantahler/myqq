import {
  MYQ_APP_VERSION,
  MYQ_AUTH_BASE,
  MYQ_CLIENT_ID,
  MYQ_CLIENT_SECRET_B64,
  MYQ_LOGIN_UA,
  MYQ_REDIRECT_URI,
  MYQ_SCOPE,
  TOKEN_REFRESH_LEEWAY_S,
} from "./constants.ts";
import { MyQAuthError } from "./errors.ts";
import { generatePkcePair } from "./pkce.ts";
import type { AuthTokens, Logger } from "./types.ts";

export class CookieJar {
  private cookies = new Map<string, string>();

  ingest(setCookieHeaders: string[]): void {
    for (const raw of setCookieHeaders) {
      const [pair] = raw.split(";", 1);
      if (!pair) continue;
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (value === "" || value === "deleted") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.cookies.has(name);
  }
}

export interface AuthOptions {
  email: string;
  password: string;
  fetch?: typeof fetch;
  logger?: Logger;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

const VERIFICATION_TOKEN_RE =
  /name=["']__RequestVerificationToken["'][^>]*value=["']([^"']+)["']/i;

const CLOUDFLARE_HINTS = [
  "Cloudflare",
  "cf-browser-verification",
  "cf-chl-bypass",
  "Attention Required!",
];

function detectCloudflare(html: string): boolean {
  return CLOUDFLARE_HINTS.some((h) => html.includes(h));
}

function isCloudflareResponse(res: Response, body: string): boolean {
  if (res.headers.get("cf-mitigated")) return true;
  if (res.headers.get("cf-ray")) {
    const server = res.headers.get("server")?.toLowerCase() ?? "";
    if (server.includes("cloudflare")) return true;
  }
  return detectCloudflare(body);
}

function decodeClientSecret(): string {
  return atob(MYQ_CLIENT_SECRET_B64);
}

export class Auth {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly email: string;
  private readonly password: string;
  private tokens: AuthTokens | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private inflightRefresh: Promise<AuthTokens> | undefined;

  constructor(opts: AuthOptions) {
    this.email = opts.email;
    this.password = opts.password;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
  }

  get accessToken(): string | undefined {
    return this.tokens?.accessToken;
  }

  get refreshToken(): string | undefined {
    return this.tokens?.refreshToken;
  }

  get expiresAt(): number | undefined {
    return this.tokens?.expiresAt;
  }

  async login(): Promise<AuthTokens> {
    const { verifier, challenge } = await generatePkcePair();
    const jar = new CookieJar();

    const { html, finalUrl, status } = await this.fetchLoginPage(
      this.buildAuthorizeUrl(challenge),
      jar,
    );

    if (detectCloudflare(html)) {
      throw new MyQAuthError(
        "MyQ login blocked by Cloudflare. See README troubleshooting.",
        {
          category: "cloudflare",
          retryable: true,
          recovery:
            "Try a residential IP and reduce login frequency; reuse a long-lived MyQ instance",
          status,
        },
      );
    }

    const hiddenInputs = extractHiddenInputs(html);
    if (!hiddenInputs.__RequestVerificationToken) {
      throw new MyQAuthError(
        "Could not find __RequestVerificationToken on login page",
        {
          recovery:
            "MyQ likely changed the login page HTML; this library may need updating",
          status,
        },
      );
    }

    const loginAction = extractLoginAction(html);
    if (!loginAction) {
      throw new MyQAuthError("Could not find login form action on login page", {
        recovery:
          "MyQ likely changed the login page HTML; this library may need updating",
        status,
      });
    }
    const loginUrl = new URL(loginAction, finalUrl).toString();

    const formBody = new URLSearchParams({
      ...hiddenInputs,
      Email: this.email,
      Password: this.password,
    });

    const loginRes = await this.fetchImpl(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "User-Agent": MYQ_LOGIN_UA,
        Cookie: jar.header(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
        Referer: finalUrl,
        Origin: new URL(finalUrl).origin,
      },
      body: formBody.toString(),
    });
    jar.ingest(getSetCookieHeaders(loginRes));

    const code = await this.followToAuthCode(loginRes, jar);
    return await this.exchangeCode(code, verifier);
  }

  private async fetchLoginPage(
    startUrl: string,
    jar: CookieJar,
  ): Promise<{ html: string; finalUrl: string; status: number }> {
    let url = startUrl;
    for (let hop = 0; hop < 5; hop++) {
      const res = await this.fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": MYQ_LOGIN_UA,
          Cookie: jar.header(),
          Accept: "text/html",
        },
      });
      jar.ingest(getSetCookieHeaders(res));

      const location = res.headers.get("Location");
      if (res.status >= 300 && res.status < 400 && location) {
        url = new URL(location, url).toString();
        continue;
      }

      const html = await res.text();

      if (res.status >= 400) {
        if (isCloudflareResponse(res, html)) {
          throw new MyQAuthError(
            "MyQ login blocked by Cloudflare. See README troubleshooting.",
            {
              category: "cloudflare",
              retryable: true,
              recovery:
                "Wait 10-30 minutes, try from a residential IP, reduce login frequency, and reuse a long-lived MyQ instance across calls.",
              status: res.status,
            },
          );
        }
        const excerpt = html.length > 300 ? `${html.slice(0, 300)}…` : html;
        throw new MyQAuthError(
          `MyQ login page returned ${res.status}: ${excerpt || "(empty body)"}`,
          {
            retryable: res.status >= 500,
            status: res.status,
          },
        );
      }

      return { html, finalUrl: url, status: res.status };
    }
    throw new MyQAuthError("Too many redirects fetching MyQ login page");
  }

  async refresh(): Promise<AuthTokens> {
    if (this.inflightRefresh) return this.inflightRefresh;
    if (!this.tokens?.refreshToken) {
      throw new MyQAuthError("No refresh token; call connect() first");
    }
    const refreshToken = this.tokens.refreshToken;
    this.inflightRefresh = (async () => {
      try {
        const body = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: MYQ_CLIENT_ID,
          client_secret: decodeClientSecret(),
          scope: MYQ_SCOPE,
          redirect_uri: MYQ_REDIRECT_URI,
        });
        const res = await this.fetchImpl(`${MYQ_AUTH_BASE}/connect/token`, {
          method: "POST",
          headers: {
            "User-Agent": MYQ_LOGIN_UA,
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: body.toString(),
        });
        if (!res.ok) {
          const detail = await readErrorDetail(res);
          throw new MyQAuthError(`Token refresh failed: ${detail}`, {
            status: res.status,
            retryable: res.status >= 500,
          });
        }
        const json = (await res.json()) as TokenResponse;
        this.tokens = this.persistTokens(json);
        return this.tokens;
      } finally {
        this.inflightRefresh = undefined;
      }
    })();
    return this.inflightRefresh;
  }

  disconnect(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.tokens = undefined;
  }

  private buildAuthorizeUrl(challenge: string): string {
    const url = new URL(`${MYQ_AUTH_BASE}/connect/authorize`);
    url.searchParams.set("client_id", MYQ_CLIENT_ID);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("redirect_uri", MYQ_REDIRECT_URI);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", MYQ_SCOPE);
    url.searchParams.set("prompt", "login");
    url.searchParams.set("acr_values", "unified_flow:v1 brand:myq");
    return url.toString();
  }

  private async followToAuthCode(
    res: Response,
    jar: CookieJar,
  ): Promise<string> {
    let current: Response = res;
    for (let hop = 0; hop < 5; hop++) {
      const location = current.headers.get("Location");
      if (!location) {
        if (current.status === 200) {
          const body = await current.text();
          if (
            body.includes("login") ||
            body.includes("password") ||
            body.includes("Email")
          ) {
            throw new MyQAuthError(
              "Invalid credentials (login form returned)",
              {
                status: current.status,
                recovery: "Verify MYQ_EMAIL and MYQ_PASSWORD",
              },
            );
          }
        }
        throw new MyQAuthError("Login did not redirect to auth code", {
          status: current.status,
        });
      }
      if (location.startsWith(MYQ_REDIRECT_URI)) {
        const url = new URL(location);
        const code = url.searchParams.get("code");
        if (!code) {
          throw new MyQAuthError("Redirect missing authorization code", {
            recovery: location,
          });
        }
        return code;
      }
      const nextUrl = new URL(location, MYQ_AUTH_BASE).toString();
      current = await this.fetchImpl(nextUrl, {
        method: "GET",
        redirect: "manual",
        headers: {
          "User-Agent": MYQ_LOGIN_UA,
          Cookie: jar.header(),
          Accept: "text/html",
        },
      });
      jar.ingest(getSetCookieHeaders(current));
    }
    throw new MyQAuthError("Too many redirects during login");
  }

  private async exchangeCode(
    code: string,
    verifier: string,
  ): Promise<AuthTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: MYQ_CLIENT_ID,
      client_secret: decodeClientSecret(),
      code,
      code_verifier: verifier,
      redirect_uri: MYQ_REDIRECT_URI,
      scope: MYQ_SCOPE,
    });
    const res = await this.fetchImpl(`${MYQ_AUTH_BASE}/connect/token`, {
      method: "POST",
      headers: {
        "User-Agent": MYQ_LOGIN_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "App-Version": MYQ_APP_VERSION,
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      throw new MyQAuthError(`Token exchange failed: ${detail}`, {
        status: res.status,
        retryable: res.status >= 500,
      });
    }
    const json = (await res.json()) as TokenResponse;
    this.tokens = this.persistTokens(json);
    return this.tokens;
  }

  private persistTokens(json: TokenResponse): AuthTokens {
    const expiresAt = Date.now() + json.expires_in * 1000;
    const tokens: AuthTokens = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt,
    };
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delayMs = Math.max(
      1000,
      (json.expires_in - TOKEN_REFRESH_LEEWAY_S) * 1000,
    );
    this.refreshTimer = setTimeout(() => {
      this.refresh().catch((err) => {
        this.logger?.warn("background token refresh failed", err);
      });
    }, delayMs);
    if (typeof this.refreshTimer === "object" && this.refreshTimer !== null) {
      const timer = this.refreshTimer as { unref?: () => void };
      timer.unref?.();
    }
    return tokens;
  }
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `HTTP ${res.status}`;
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch {
    return `HTTP ${res.status}`;
  }
}

function getSetCookieHeaders(res: Response): string[] {
  const anyHeaders = res.headers as Headers & {
    getSetCookie?: () => string[];
  };
  if (typeof anyHeaders.getSetCookie === "function") {
    return anyHeaders.getSetCookie();
  }
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

export function extractVerificationToken(html: string): string | undefined {
  const match = VERIFICATION_TOKEN_RE.exec(html);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

const FORM_ACTION_RE = /<form[^>]*action=["']([^"']+)["']/i;
export function extractLoginAction(html: string): string | undefined {
  const match = FORM_ACTION_RE.exec(html);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

const HIDDEN_INPUT_RE = /<input\b[^>]*\btype=["']hidden["'][^>]*>/gi;
const ATTR_NAME_RE = /\bname=["']([^"']+)["']/i;
const ATTR_VALUE_RE = /\bvalue=["']([^"']*)["']/i;

export function extractHiddenInputs(html: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const match of html.matchAll(HIDDEN_INPUT_RE)) {
    const tag = match[0];
    const nameMatch = ATTR_NAME_RE.exec(tag);
    const valueMatch = ATTR_VALUE_RE.exec(tag);
    if (!nameMatch?.[1]) continue;
    result[decodeHtmlEntities(nameMatch[1])] = valueMatch?.[1]
      ? decodeHtmlEntities(valueMatch[1])
      : "";
  }
  return result;
}

const HTML_ENTITY_MAP: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#?\w+);/g, (raw, name: string) =>
    name in HTML_ENTITY_MAP ? (HTML_ENTITY_MAP[name] ?? raw) : raw,
  );
}
