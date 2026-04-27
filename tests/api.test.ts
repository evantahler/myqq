import { describe, expect, it } from "bun:test";
import { Api } from "../src/api.ts";
import { Auth } from "../src/auth.ts";
import { MyQApiError } from "../src/errors.ts";
import { authorizeHtml, createMockFetch } from "./helpers.ts";

async function loggedInAuth(mockFetch: typeof fetch): Promise<Auth> {
  const auth = new Auth({
    email: "u",
    password: "p",
    fetch: mockFetch,
  });
  await auth.login();
  return auth;
}

describe("Api.request", () => {
  it("retries once on 401 with a refreshed token", async () => {
    let phase: "login" | "first-call" | "refresh" | "retry" = "login";
    const mock = createMockFetch((req, i) => {
      if (phase === "login") {
        if (i === 0) {
          return {
            status: 200,
            headers: { "set-cookie": ["s=1"] },
            body: authorizeHtml(),
          };
        }
        if (i === 1) {
          return {
            status: 302,
            headers: { Location: "com.myqops://android?code=C" },
          };
        }
        if (i === 2) {
          phase = "first-call";
          return {
            status: 200,
            body: {
              access_token: "OLD",
              refresh_token: "REFRESH",
              expires_in: 3600,
            },
          };
        }
      }
      if (phase === "first-call") {
        expect(req.url).toBe("https://example.com/data");
        expect(req.headers.authorization).toBe("Bearer OLD");
        phase = "refresh";
        return { status: 401, body: { error: "expired" } };
      }
      if (phase === "refresh") {
        expect(req.body).toContain("grant_type=refresh_token");
        phase = "retry";
        return {
          status: 200,
          body: { access_token: "NEW", refresh_token: "R2", expires_in: 3600 },
        };
      }
      // retry
      expect(req.headers.authorization).toBe("Bearer NEW");
      return { status: 200, body: { ok: true } };
    });

    const auth = await loggedInAuth(mock.fetch);
    const api = new Api({ auth, fetch: mock.fetch });
    const result = await api.request<{ ok: boolean }>(
      "https://example.com/data",
    );
    expect(result.ok).toBe(true);
    auth.disconnect();
  });

  it("throws MyQApiError with retryAfter on 429", async () => {
    let loggedIn = false;
    const mock = createMockFetch((_req, i) => {
      if (!loggedIn) {
        if (i === 0) {
          return {
            status: 200,
            headers: { "set-cookie": ["s=1"] },
            body: authorizeHtml(),
          };
        }
        if (i === 1) {
          return {
            status: 302,
            headers: { Location: "com.myqops://android?code=C" },
          };
        }
        if (i === 2) {
          loggedIn = true;
          return {
            status: 200,
            body: { access_token: "T", refresh_token: "R", expires_in: 3600 },
          };
        }
      }
      return {
        status: 429,
        headers: { "Retry-After": "30" },
        body: "rate limited",
      };
    });
    const auth = await loggedInAuth(mock.fetch);
    const api = new Api({ auth, fetch: mock.fetch });
    try {
      await api.request("https://example.com/throttled");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(MyQApiError);
      const err = e as MyQApiError;
      expect(err.status).toBe(429);
      expect(err.retryAfter).toBe(30);
      expect(err.retryable).toBe(true);
    }
    auth.disconnect();
  });

  it("sends auth and app headers", async () => {
    let loggedIn = false;
    const mock = createMockFetch((req, i) => {
      if (!loggedIn) {
        if (i === 0) {
          return {
            status: 200,
            headers: { "set-cookie": ["s=1"] },
            body: authorizeHtml(),
          };
        }
        if (i === 1) {
          return {
            status: 302,
            headers: { Location: "com.myqops://android?code=C" },
          };
        }
        if (i === 2) {
          loggedIn = true;
          return {
            status: 200,
            body: { access_token: "T", refresh_token: "R", expires_in: 3600 },
          };
        }
      }
      expect(req.headers.authorization).toBe("Bearer T");
      expect(req.headers["myqapplicationid"]).toBeDefined();
      expect(req.headers["app-version"]).toBeDefined();
      expect(req.headers["brandid"]).toBe("1");
      return { status: 200, body: { hello: "world" } };
    });
    const auth = await loggedInAuth(mock.fetch);
    const api = new Api({ auth, fetch: mock.fetch });
    await api.request("https://example.com/headers");
    auth.disconnect();
  });
});
