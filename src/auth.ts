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

    const authorizeUrl = this.buildAuthorizeUrl(challenge);
    const authorizeRes = await this.fetchImpl(authorizeUrl, {
      method: "GET",
      redirect: "manual",
      headers: {
        "User-Agent": MYQ_LOGIN_UA,
        Accept: "text/html",
      },
    });
    jar.ingest(getSetCookieHeaders(authorizeRes));
    const authorizeHtml = await authorizeRes.text();

    if (detectCloudflare(authorizeHtml)) {
      throw new MyQAuthError(
        "MyQ login blocked by Cloudflare. See README troubleshooting.",
        {
          category: "cloudflare",
          retryable: true,
          recovery:
            "Try a residential IP and reduce login frequency; reuse a long-lived MyQ instance",
          status: authorizeRes.status,
        },
      );
    }

    const verificationToken = extractVerificationToken(authorizeHtml);
    if (!verificationToken) {
      throw new MyQAuthError(
        "Could not find __RequestVerificationToken on login page",
        {
          recovery:
            "MyQ likely changed the login page HTML; this library may need updating",
          status: authorizeRes.status,
        },
      );
    }

    const loginAction = extractLoginAction(authorizeHtml) ?? "/Account/Login";
    const loginUrl = new URL(loginAction, MYQ_AUTH_BASE).toString();

    const formBody = new URLSearchParams({
      Email: this.email,
      Password: this.password,
      __RequestVerificationToken: verificationToken,
    });

    const loginRes = await this.fetchImpl(loginUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "User-Agent": MYQ_LOGIN_UA,
        Cookie: jar.header(),
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html",
      },
      body: formBody.toString(),
    });
    jar.ingest(getSetCookieHeaders(loginRes));

    const code = await this.followToAuthCode(loginRes, jar);
    return await this.exchangeCode(code, verifier);
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
          throw new MyQAuthError("Token refresh failed", {
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
      throw new MyQAuthError("Token exchange failed", {
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
  return match?.[1];
}

const FORM_ACTION_RE = /<form[^>]*action=["']([^"']+)["']/i;
export function extractLoginAction(html: string): string | undefined {
  const match = FORM_ACTION_RE.exec(html);
  return match?.[1];
}
