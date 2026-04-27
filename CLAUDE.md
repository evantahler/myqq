# CLAUDE.md

## Project

myqq — TypeScript client for the (undocumented) MyQ garage door API used by Liftmaster, Chamberlain, and Craftsman openers. Exposes a small `MyQ`/`Door` API and ships a stdio MCP server (`myqq-mcp`) so AI agents can list doors, read status, and open/close.

## Commands

- `bun test` — Run all tests (mocked fetch, no network)
- `bun run lint` — TypeScript type checking + Biome linting/format checking
- `bun run format` — Auto-fix lint issues and reformat with Biome
- `bun run mcp` — Start the stdio MCP server (requires `MYQ_EMAIL` / `MYQ_PASSWORD`)
- `bun run smoke` — Live smoke test against a real MyQ account (requires env)

## Architecture

- **Runtime**: Bun, ESM, `type: module`
- **No third-party HTTP client** — uses `fetch` with `redirect: "manual"` so we can intercept the OAuth 302 to a custom-scheme URI
- **Auth**: OAuth 2.0 + PKCE flow against `partner-identity.myq-cloud.com`, mirroring the v6 flow from [hjdhjd/myq](https://github.com/hjdhjd/myq) (Apache-2.0). The library is dead and `homebridge-myq` was archived in April 2024 — Cloudflare bot protection may break login at any time
- **Cookie jar**: minimal in-memory header parser/builder in `auth.ts` — no `tough-cookie`
- **Token refresh**: scheduled `expires_in - 180s` ahead via `setTimeout`; single-flight refresh on 401 in `api.ts`
- **MCP server**: thin orchestrator in `src/mcp-server.ts`; each domain registers tools in its own `mcp-tools.ts` (only `doors` for v0.1)

## Key Files

- `src/index.ts` — Public exports (MyQ, Door, types, errors)
- `src/myq.ts` — `MyQ` class — orchestrator (connect, doors, top-level helpers)
- `src/door.ts` — `Door` class — per-device status/open/close
- `src/auth.ts` — OAuth + PKCE login + refresh
- `src/api.ts` — Authed fetch wrapper with single-flight refresh on 401
- `src/pkce.ts` — `code_verifier` / `code_challenge` via Web Crypto
- `src/constants.ts` — Endpoints, client_id/secret, app version, user-agents
- `src/types.ts` — Public + internal types (DoorState, raw API shapes)
- `src/errors.ts` — `MyQError` base + `MyQAuthError`, `MyQApiError`, `MyQNotFoundError`
- `src/mcp-helpers.ts` — Shared `wrapTool`, `toolError`, `readOnlyAnnotations`
- `src/mcp-tools.ts` — Door tool registrations + capability constant
- `src/mcp-server.ts` — Stdio MCP entrypoint (`#!/usr/bin/env bun`)
- `tests/*.test.ts` — Mocked-fetch unit tests for each layer

## Door state values

`DoorState = "open" | "closed" | "opening" | "closing" | "stopped" | "transition" | "autoreverse" | "unknown"` — verbatim strings from the MyQ API.

## MCP Tool Design Patterns

Reference: [Patterns for Agentic Tools](https://arcade.dev/patterns/llm.txt)

When adding or modifying MCP tools, follow these patterns:

### Tool Classification

- **Query Tool**: Read-only, safe to retry — `list_doors`, `get_door_status`
- **Command Tool**: Side-effecting, possibly irreversible — `open_door`, `close_door` (must use destructive annotations)

### Tool Annotations

```ts
// Query
annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true,  openWorldHint: false }
// Command
annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
```

### Error Handling

Errors flow through `toolError(MyQError)` and include:

- `error` — machine-readable name
- `message` — human-readable description
- `category` — `"auth" | "api" | "not_found" | "cloudflare"`
- `retryable` — boolean
- `recovery` — actionable next step

### Response Design

- Wrap all responses in `{ data, totalResults?, _next? }` via `wrapTool`
- Include `_next` hints pointing at related tools

## Documentation

When changing the public API, update **both** `README.md` and `CLAUDE.md`. README must include: TypeScript usage example, MCP `mcpServers` snippet, and the Cloudflare warning.

## Versioning

Always bump the patch version in `package.json` when making code changes. Use semver: patch for fixes/small changes, minor for new features, major for breaking changes. The auto-release workflow publishes to npm automatically when a new version is detected on main.

## Testing

Unit tests use Bun + `mock.module` to stub `globalThis.fetch`. No live network calls in CI — Cloudflare and credential exposure make that impractical. Use `bun run smoke` with `MYQ_EMAIL` / `MYQ_PASSWORD` set for a local end-to-end check.
