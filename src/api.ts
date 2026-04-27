import type { Auth } from "./auth.ts";
import { MYQ_APP_ID, MYQ_APP_UA, MYQ_APP_VERSION } from "./constants.ts";
import { MyQApiError } from "./errors.ts";
import type { Logger } from "./types.ts";

export interface ApiOptions {
  auth: Auth;
  fetch?: typeof fetch;
  logger?: Logger;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  expectJson?: boolean;
}

export class Api {
  private readonly auth: Auth;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;

  constructor(opts: ApiOptions) {
    this.auth = opts.auth;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.logger = opts.logger;
  }

  async request<T = unknown>(
    url: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const method = options.method ?? "GET";
    const body =
      options.body === undefined ? undefined : JSON.stringify(options.body);

    const send = async (token: string): Promise<Response> =>
      this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": MYQ_APP_UA,
          "App-Version": MYQ_APP_VERSION,
          MyQApplicationId: MYQ_APP_ID,
          BrandId: "1",
          "Accept-Encoding": "gzip",
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body,
      });

    let token = this.auth.accessToken;
    if (!token)
      throw new MyQApiError("Not authenticated; call connect() first");

    let res = await send(token);
    if (res.status === 401) {
      this.logger?.debug("api: 401, refreshing once");
      const refreshed = await this.auth.refresh();
      token = refreshed.accessToken;
      res = await send(token);
    }

    if (!res.ok) {
      const retryAfterRaw = res.headers.get("Retry-After");
      const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : undefined;
      const text = await safeText(res);
      throw new MyQApiError(
        `MyQ API ${method} ${url} failed: ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
        {
          status: res.status,
          retryAfter: Number.isFinite(retryAfter) ? retryAfter : undefined,
          retryable: res.status === 429 || res.status >= 500,
        },
      );
    }

    if (options.expectJson === false) return undefined as T;
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return undefined as T;
    return (await res.json()) as T;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
