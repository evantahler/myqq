import { describe, expect, it } from "bun:test";
import {
  Auth,
  CookieJar,
  extractLoginAction,
  extractVerificationToken,
} from "../src/auth.ts";
import { MyQAuthError } from "../src/errors.ts";
import { authorizeHtml, cloudflareHtml, createMockFetch } from "./helpers.ts";

describe("CookieJar", () => {
  it("ingests, sends, and updates cookies", () => {
    const jar = new CookieJar();
    jar.ingest([
      "session=abc; Path=/; HttpOnly",
      "csrf=xyz; Path=/",
      "tracker=1",
    ]);
    expect(jar.has("session")).toBe(true);
    expect(jar.header()).toContain("session=abc");
    expect(jar.header()).toContain("csrf=xyz");

    jar.ingest(["session=def"]);
    expect(jar.header()).toContain("session=def");
    expect(jar.header()).not.toContain("session=abc");
  });

  it("ignores malformed cookie strings", () => {
    const jar = new CookieJar();
    jar.ingest(["", "= ", "name-no-value", "good=1"]);
    expect(jar.header()).toBe("good=1");
  });
});

describe("auth html parsing", () => {
  it("extracts the verification token", () => {
    expect(extractVerificationToken(authorizeHtml("tok-1"))).toBe("tok-1");
  });

  it("extracts the form action", () => {
    expect(extractLoginAction(authorizeHtml())).toBe("/Account/Login");
  });
});

describe("Auth.login", () => {
  it("walks the OAuth + PKCE flow and returns tokens", async () => {
    const expectedCode = "AUTHCODE-OK";
    const mock = createMockFetch((req, i) => {
      if (i === 0) {
        expect(req.method).toBe("GET");
        expect(req.url).toContain("/connect/authorize");
        expect(req.url).toContain("code_challenge=");
        return {
          status: 200,
          headers: { "set-cookie": ["session=abc; Path=/"] },
          body: authorizeHtml("vtok-9"),
        };
      }
      if (i === 1) {
        expect(req.method).toBe("POST");
        expect(req.url).toContain("/Account/Login");
        expect(req.headers.cookie).toContain("session=abc");
        expect(req.body).toContain("__RequestVerificationToken=vtok-9");
        expect(req.body).toContain("Email=user");
        return {
          status: 302,
          headers: {
            Location: `com.myqops://android?code=${expectedCode}`,
          },
        };
      }
      if (i === 2) {
        expect(req.method).toBe("POST");
        expect(req.url).toBe(
          "https://partner-identity.myq-cloud.com/connect/token",
        );
        expect(req.body).toContain("grant_type=authorization_code");
        expect(req.body).toContain(`code=${expectedCode}`);
        expect(req.body).toContain("code_verifier=");
        return {
          status: 200,
          body: {
            access_token: "ACCESS-1",
            refresh_token: "REFRESH-1",
            expires_in: 3600,
          },
        };
      }
      throw new Error(`unexpected request #${i}: ${req.method} ${req.url}`);
    });

    const auth = new Auth({
      email: "user@example.com",
      password: "hunter2",
      fetch: mock.fetch,
    });
    const tokens = await auth.login();
    expect(tokens.accessToken).toBe("ACCESS-1");
    expect(tokens.refreshToken).toBe("REFRESH-1");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    auth.disconnect();
  });

  it("throws MyQAuthError with cloudflare category when blocked", async () => {
    const mock = createMockFetch(() => ({
      status: 403,
      body: cloudflareHtml(),
    }));
    const auth = new Auth({
      email: "u",
      password: "p",
      fetch: mock.fetch,
    });
    await expect(auth.login()).rejects.toMatchObject({
      name: "MyQAuthError",
      category: "cloudflare",
    });
  });

  it("throws on missing verification token", async () => {
    const mock = createMockFetch(() => ({
      status: 200,
      body: "<html><body>no form here</body></html>",
    }));
    const auth = new Auth({
      email: "u",
      password: "p",
      fetch: mock.fetch,
    });
    await expect(auth.login()).rejects.toBeInstanceOf(MyQAuthError);
  });
});

describe("Auth.refresh", () => {
  it("refreshes tokens with a refresh_token grant", async () => {
    let exchange = 0;
    const mock = createMockFetch((req, i) => {
      if (i === 0) {
        return {
          status: 200,
          headers: { "set-cookie": ["session=a"] },
          body: authorizeHtml("v"),
        };
      }
      if (i === 1) {
        return {
          status: 302,
          headers: { Location: "com.myqops://android?code=C" },
        };
      }
      if (i === 2) {
        return {
          status: 200,
          body: {
            access_token: "A1",
            refresh_token: "R1",
            expires_in: 3600,
          },
        };
      }
      // refresh
      exchange++;
      expect(req.body).toContain("grant_type=refresh_token");
      expect(req.body).toContain("refresh_token=R1");
      return {
        status: 200,
        body: { access_token: "A2", refresh_token: "R2", expires_in: 3600 },
      };
    });

    const auth = new Auth({
      email: "u",
      password: "p",
      fetch: mock.fetch,
    });
    await auth.login();
    const refreshed = await auth.refresh();
    expect(refreshed.accessToken).toBe("A2");
    expect(refreshed.refreshToken).toBe("R2");
    expect(exchange).toBe(1);
    auth.disconnect();
  });

  it("single-flights concurrent refreshes", async () => {
    let tokenCalls = 0;
    const mock = createMockFetch((_req, i) => {
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
      tokenCalls++;
      return {
        status: 200,
        body: {
          access_token: `T-${tokenCalls}`,
          refresh_token: `R-${tokenCalls}`,
          expires_in: 3600,
        },
      };
    });
    const auth = new Auth({
      email: "u",
      password: "p",
      fetch: mock.fetch,
    });
    await auth.login(); // tokenCalls = 1
    const [a, b] = await Promise.all([auth.refresh(), auth.refresh()]);
    expect(a.accessToken).toBe(b.accessToken);
    expect(tokenCalls).toBe(2);
    auth.disconnect();
  });
});
