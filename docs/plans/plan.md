# Plan: `myq-ts` — TypeScript package for the MyQ garage door API

## Context

We want a small TypeScript library exposing four methods against MyQ-enabled
garage doors (Liftmaster / Chamberlain / Craftsman):

- `connect()` — log in and discover devices
- `status()` — current door state (`open`, `closed`, `opening`, `closing`, …)
- `open()` — issue open command
- `close()` — issue close command

The MyQ API is undocumented and actively hostile to third-party integrations.
The reference implementation is [`hjdhjd/myq`](https://github.com/hjdhjd/myq)
(TypeScript, last published Oct 2023). The companion `homebridge-myq` was
**archived in April 2024** and the Home Assistant integration was removed in
late 2023 because Chamberlain enabled Cloudflare bot protection on the auth
endpoint plus Firebase app-checks. Per the codeowner: *“the paid software
engineers are going to win.”*

> **Reality check:** This package may break at any time and has a meaningful
> chance of failing on first auth attempt due to Cloudflare. We mirror the
> known-good v6 OAuth+PKCE flow from `hjdhjd/myq` as our best shot. We will
> document the risk in the README so users aren’t surprised.

The package will live at **`/Users/evan/workspace/myq-ts`** as a new
standalone repo, mirroring `mcpx` tooling (Bun + Biome + ESM + bun:test).

---

## API surface (public)

```ts
import { MyQ } from "myq-ts";

const myq = new MyQ({ email, password });
await myq.connect();                    // login + load accounts + load devices

// Discovery
myq.doors;                              // Door[] — all garage door openers
myq.getDoor(serial);                    // Door | undefined

// Per-door operations
const door = myq.doors[0];
await door.status();                    // "open"|"closed"|"opening"|"closing"|"stopped"|"unknown"
await door.open();                      // resolves once command is acknowledged
await door.close();
door.name;                              // "Main Garage"
door.serialNumber;
door.online;                            // boolean (last known)

// Convenience top-level (single-door homes or by-serial)
await myq.status(serial?);              // serial optional if exactly one door
await myq.open(serial?);
await myq.close(serial?);

await myq.disconnect();                 // clears refresh timer
```

There is also a **stdio MCP server** shipped in the same package (`bin: myq-mcp`) so that AI agents can drive the doors directly. See the *MCP server* section below.

Optional ctor knobs (escape hatches, not required for v0.1):

```ts
new MyQ({
  email, password,
  fetch?: typeof fetch,                 // injectable for tests / proxies
  logger?: { debug, info, warn, error } // pino-style
});
```

---

## Project layout

```
/Users/evan/workspace/myq-ts/
├── package.json                # type:module, scripts mirror mcpx; `bin: { myq-mcp: src/mcp-server.ts }`
├── biome.json                  # copied from mcpx
├── tsconfig.json               # copied from mcpx (ESNext, bundler resolution)
├── .gitignore
├── README.md                   # quickstart + Cloudflare warning + MCP setup snippet
├── LICENSE                     # MIT
├── conductor.json              # Conductor worktree hooks (copied from macos-ts)
├── .conductor/
│   ├── setup.sh                # `bun install` on new worktree
│   └── archive.sh              # pull/fetch main worktree on archive
├── .github/
│   └── workflows/
│       ├── ci.yml              # lint + test on PR/push to main
│       └── auto-release.yml    # on version bump to main: tag, gh release, npm publish
├── src/
│   ├── index.ts                # public exports: MyQ, Door, types, errors
│   ├── myq.ts                  # `MyQ` class — orchestrator
│   ├── door.ts                 # `Door` class — per-device open/close/status
│   ├── auth.ts                 # OAuth + PKCE login flow
│   ├── api.ts                  # low-level fetch wrapper (auth header, retries, refresh-on-401)
│   ├── pkce.ts                 # code_verifier/code_challenge helpers (Web Crypto)
│   ├── constants.ts            # endpoints, client_id, client_secret, user-agents, app version
│   ├── types.ts                # public + internal types
│   ├── errors.ts               # MyQAuthError, MyQApiError, MyQNotFoundError
│   ├── mcp-helpers.ts          # wrapTool, toolError, readOnlyAnnotations, McpServerInstance type
│   ├── mcp-tools.ts            # registerDoorTools(server, myq) + doorsCapability
│   └── mcp-server.ts           # `#!/usr/bin/env bun` — stdio MCP entrypoint
└── test/
    ├── pkce.test.ts            # unit, no network
    ├── auth.test.ts            # mocks fetch, asserts the OAuth dance
    ├── api.test.ts             # mocks fetch for refresh + 401 retry
    ├── door.test.ts            # mocks api, asserts command paths
    └── mcp-server.test.ts      # in-process server with InMemoryTransport, mocked MyQ
```

The CLI surface is a single `bin` — `myq-mcp` — that boots the stdio MCP server. No other CLI in v0.1.

---

## Implementation details

### Constants (port from `hjdhjd/myq` `settings.ts`)

```ts
// src/constants.ts
export const MYQ_AUTH_BASE = "https://partner-identity.myq-cloud.com";
export const MYQ_ACCOUNTS_BASE = "https://accounts.myq-cloud.com/api/v6.0";
export const MYQ_DEVICES_BASE = "https://devices.myq-cloud.com/api/v5.2";
// Per-family command host: account-devices-gdo.myq-cloud.com (door_openers)
export const MYQ_GDO_BASE = "https://account-devices-gdo.myq-cloud.com/api/v5.2";

export const MYQ_CLIENT_ID = "ANDROID_CGI_MYQ";
export const MYQ_CLIENT_SECRET = "VUQ0RFhuS3lQV3EyNUJTdw=="; // base64; decoded at use
export const MYQ_REDIRECT_URI = "com.myqops://android";
export const MYQ_SCOPE = "MyQ_Residential offline_access";
export const MYQ_APP_ID = "D9D7B25035D549D8A3EA16A9FFB8C927D4A19B55B8944011B2670A8321BF8312";
export const MYQ_APP_VERSION = "5.242.0.72704";
export const MYQ_LOGIN_UA =
  "Mozilla/5.0 (Linux; Android 11; sdk_gphone_x86) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/83.0.4103.106 Mobile Safari/537.36";
export const MYQ_APP_UA = "sdk_gphone_x86/Android 11";
```

### OAuth + PKCE flow (`auth.ts`)

Mirrors the v6 flow from `hjdhjd/myq`:

1. Generate `code_verifier` (43–128 char URL-safe random) and
   `code_challenge = base64url(sha256(verifier))` via Web Crypto.
2. `GET https://partner-identity.myq-cloud.com/connect/authorize` with query:
   `client_id`, `code_challenge`, `code_challenge_method=S256`,
   `redirect_uri`, `response_type=code`, `scope`, `prompt=login`,
   `acr_values=unified_flow:v1  brand:myq`.
   Capture `Set-Cookie` jar and the rendered HTML.
3. Scrape `__RequestVerificationToken` from the login form.
4. `POST` credentials + token to the login endpoint with the cookie jar
   and `User-Agent: MYQ_LOGIN_UA`. Detect the 302 redirect to
   `com.myqops://android?code=…`.
5. `POST https://partner-identity.myq-cloud.com/connect/token` with
   `grant_type=authorization_code`, `code`, `code_verifier`,
   `client_id`, `client_secret` (base64-decoded), `redirect_uri`, `scope`.
6. Persist `{ access_token, refresh_token, expires_in }` and schedule a
   refresh `expires_in - 180s` ahead via `setTimeout`. Refresh uses
   `grant_type=refresh_token` against the same endpoint.

Cookies: implement a minimal in-memory cookie jar (header parse + send) —
no need for `tough-cookie`. Redirect handling: do `redirect: "manual"` on
`fetch` so we can inspect 302s to the custom-scheme URI before the runtime
swallows them.

### Headers for API calls (`api.ts`)

```
Authorization: Bearer <access_token>
User-Agent: <MYQ_APP_UA>
App-Version: <MYQ_APP_VERSION>
MyQApplicationId: <MYQ_APP_ID>
BrandId: 1
Accept-Encoding: gzip
```

`api.ts` exposes `request(method, url, body?)` that:
- injects auth headers,
- on 401, awaits one in-flight refresh (single-flight) and retries once,
- on 429, throws `MyQApiError` with `retryAfter` populated (caller decides),
- parses JSON and returns typed result.

### Discovery + state (`myq.ts`)

- `connect()`:
  1. `auth.login()`
  2. `GET {accounts_base}/accounts` → first account id (multi-account
     support: pick first, expose `accounts` for advanced users; keep
     simple).
  3. `GET {devices_base}/Accounts/{accountId}/Devices` → filter
     `device_family === "garagedoor"` (or matches the gdo set:
     `garagedooropener | wifigaragedooropener | virtualgaragedooropener |
     commercialdooropener`) → wrap each in a `Door`.
- Cache devices on the instance; `refresh()` re-pulls device list and
  state. No automatic polling in v0.1 (caller decides cadence).

### Door commands (`door.ts`)

```ts
class Door {
  status(): Promise<DoorState>;     // refreshes self, returns door_state
  open():   Promise<void>;          // PUT {gdo_base}/Accounts/{accountId}/door_openers/{serial}/open
  close():  Promise<void>;          // PUT  …/door_openers/{serial}/close
}
```

`DoorState = "open" | "closed" | "opening" | "closing" | "stopped" |
"transition" | "autoreverse" | "unknown"` (verbatim from MyQ).

`open()`/`close()` resolve as soon as the API returns 2xx. We do **not**
poll-until-final-state in v0.1 — that’s a footgun for callers who want
fast control. We may add `await door.open({ awaitFinalState: true })` later.

### Errors

- `MyQAuthError` — invalid credentials, Cloudflare block, token refresh
  failure. Include the upstream status + a hint string when we detect the
  HTML challenge page.
- `MyQApiError` — non-2xx from devices/commands endpoints. Carries
  `status`, `retryAfter`.
- `MyQNotFoundError` — device serial not found.

### Tests (Bun + `mock.module`)

- `pkce.test.ts` — verify `code_challenge` matches RFC 7636 vector.
- `auth.test.ts` — feed a canned authorize HTML + simulated 302 + token
  JSON via injected `fetch`, assert the final `access_token` lands.
- `api.test.ts` — assert single-flight refresh on 401 and one retry.
- `door.test.ts` — assert PUT URL, that `status()` returns the canonical
  string, that `getDoor("missing")` returns `undefined`.

No live integration test in CI (credentials + Cloudflare); a manual smoke
script under `scripts/smoke.ts` reads `MYQ_EMAIL` / `MYQ_PASSWORD` from
env and runs `connect → status → open → wait → close`.

---

## MCP server

Mirrors the `macos-ts` pattern (`src/mcp-server.ts`, `src/mcp-helpers.ts`,
per-feature `mcp-tools.ts`) so the same conventions and helpers apply.

### `package.json` additions

```jsonc
{
  "bin": { "myq-mcp": "src/mcp-server.ts" },
  "scripts": { "mcp": "bun run src/mcp-server.ts" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    "zod": "^3.23.0"
  }
}
```

### `src/mcp-helpers.ts`

Verbatim port of `macos-ts/src/mcp-helpers.ts`, retyped against `MyQError`
instead of `MacOSError`:

```ts
export const readOnlyAnnotations = {
  readOnlyHint: true, destructiveHint: false,
  idempotentHint: true, openWorldHint: false,
} as const;

export function toolError(e: MyQError) { /* JSON-serialized error envelope */ }
export function wrapTool<T>(fn: () => Promise<T> | T, hints?: NextAction[]) {
  // Run fn(), wrap in { data, totalResults?, _next? } as JSON text content.
  // Catch MyQError → toolError(e); rethrow others.
}
```

### `src/mcp-tools.ts`

```ts
export const doorsCapability = {
  name: "MyQ Garage Doors",
  description: "Control and inspect MyQ-enabled garage doors on this account",
  tools: ["list_doors", "get_door_status", "open_door", "close_door"],
  startWith: "list_doors",
};

export function registerDoorTools(server: McpServerInstance, myq: MyQ): void {
  // list_doors        → readOnly, no input,            returns Door[] metadata
  // get_door_status   → readOnly, { serial? },         returns DoorState
  // open_door         → mutating, { serial? },         confirmation required
  // close_door        → mutating, { serial? },         confirmation required
}
```

`open_door` / `close_door` use destructive annotations
(`{ readOnlyHint: false, destructiveHint: true, idempotentHint: false,
openWorldHint: true }`) so Claude clients prompt before firing. `serial`
is optional when the account has exactly one door (matches the top-level
`MyQ.open(serial?)` ergonomics). Inputs validated with `zod`.

### `src/mcp-server.ts`

```ts
#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MyQ, type MyQOptions } from "./myq.ts";
import { doorsCapability, registerDoorTools } from "./mcp-tools.ts";
import { readOnlyAnnotations, wrapTool } from "./mcp-helpers.ts";

export function createServer(options?: MyQOptions) {
  const myq = new MyQ(options ?? {
    email: process.env.MYQ_EMAIL!,
    password: process.env.MYQ_PASSWORD!,
  });
  const server = new McpServer({ name: "myq", version: PACKAGE_VERSION });

  server.registerTool("get_capabilities", {
    title: "Get server capabilities",
    description: "Discover doors and tools. Call first.",
    annotations: readOnlyAnnotations,
  }, async () => wrapTool(() => ({
    dataSources: [doorsCapability],
    requirement: "MYQ_EMAIL and MYQ_PASSWORD env vars; subject to Cloudflare",
  })));

  registerDoorTools(server, myq);
  return { server, myq };
}

if (import.meta.main) {
  const { server, myq } = createServer();
  await myq.connect();                 // lazy on first tool call would also work; eager is simpler
  await server.connect(new StdioServerTransport());
  process.on("beforeExit", () => myq.disconnect());
}
```

### Configuration (README snippet)

```json
{
  "mcpServers": {
    "myq": {
      "command": "bunx",
      "args": ["myq-ts"],
      "env": { "MYQ_EMAIL": "...", "MYQ_PASSWORD": "..." }
    }
  }
}
```

### MCP test

`test/mcp-server.test.ts` — wire `createServer({ ... })` to
`InMemoryTransport`, list tools, call `list_doors`/`open_door` with a
mocked `MyQ`, assert that the JSON envelope shape matches `wrapTool`'s
contract and that error paths route through `toolError`.

---

## Auto-updating release pipeline

Mirrors `macos-ts/.github/workflows/auto-release.yml` — version bumps
on `main` are the trigger; no manual tagging.

### `.github/workflows/ci.yml`

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun test
```

### `.github/workflows/auto-release.yml`

Three sequential jobs gated on `should_release`:

1. **`check-version`** — read `version` from `package.json`, query
   `gh release view vX.Y.Z`. If absent, emit `should_release=true` plus
   `tag` and `version` outputs.
2. **`create-release`** — `gh release create $tag --generate-notes`.
3. **`ci`** — `bun install --frozen-lockfile && bun run lint && bun test`
   on the tagged commit (gates publish on a green build).
4. **`publish-npm`** — `npm publish --provenance --access public` with
   `id-token: write` (uses npm trusted publishing via OIDC, no
   `NPM_TOKEN` secret needed). Pin Node `22.14.0` and npm `11.5.1` to
   match `macos-ts`.

Workflow permissions: `contents: write` (for the release) and
`id-token: write` (for npm provenance).

### Release flow for the maintainer

```
- bump "version" in package.json (e.g. 0.1.0 → 0.1.1)
- merge to main
- GitHub Actions: tag v0.1.1 → release w/ generated notes → CI → npm publish
```

No manual `npm publish`, no manual tagging, no `NPM_TOKEN` rotation.
Trusted publishing must be configured once on npmjs.com for the package
(post-first-publish; v0.1.0 is the bootstrap and may need a one-time
manual publish + trusted-publisher setup).

---

## Phased build order

1. Scaffold repo (package.json, biome.json, tsconfig.json, .gitignore,
   README skeleton, LICENSE — copy and tweak from `mcpx`). `bun init` is
   not needed; we’ll write these directly. **Also create `docs/plans/`
   and copy this plan to `docs/plans/myq-ts-v0.1.md`** so it ships with
   the repo.
2. `constants.ts`, `types.ts`, `errors.ts`, `pkce.ts` + pkce test.
3. `auth.ts` + auth test (mocked).
4. `api.ts` + api test (mocked).
5. `myq.ts` (`connect`, `getDoor`, top-level helpers).
6. `door.ts` (`status`, `open`, `close`) + door test.
7. `mcp-helpers.ts`, `mcp-tools.ts`, `mcp-server.ts` + MCP test
   (`InMemoryTransport`, mocked `MyQ`).
8. `.github/workflows/ci.yml` and `auto-release.yml`. First publish of
   `0.1.0` is manual (`npm publish --access public --provenance`) so
   trusted publishing can be configured on npmjs.com; subsequent
   versions auto-publish on version bump.
9. README quickstart + clear Cloudflare warning + MCP `mcpServers`
   snippet + license attribution to `hjdhjd/myq` (Apache-2.0 — we’re
   writing fresh, but the auth flow is its IP, so credit is the right
   move).
10. Manual smoke run against a real account; iterate on whatever the API
    actually returns vs. the docs.

---

## Verification

- `bun lint` — clean (Biome + tsc).
- `bun test` — all unit tests pass with mocked fetch.
- Manual smoke: `MYQ_EMAIL=… MYQ_PASSWORD=… bun run scripts/smoke.ts`
  - prints `Connected as <email>, found N door(s)`
  - prints status of each door
  - opens and closes the first door, confirming state transitions in the
    Chamberlain app
- If Cloudflare blocks login: confirm the `MyQAuthError` includes a
  helpful message pointing to the README troubleshooting section.

---

## Open considerations (not blocking, future)

- **Token persistence** — currently in-memory only. Could expose
  `getRefreshToken()` / `connectWithRefreshToken()` so callers can avoid
  re-auth (and avoid Cloudflare) across processes. Worth adding in v0.2.
- **Polling helpers** — `door.waitFor("closed", { timeoutMs })` is a
  natural follow-up.
- **Lamps / commercial doors / gates** — out of scope for v0.1 per the
  user’s ask (garage doors only).
