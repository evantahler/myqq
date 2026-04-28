# myqq

TypeScript client for the (undocumented) [MyQ](https://www.myq.com/) garage door API used by Liftmaster, Chamberlain, and Craftsman openers — plus a stdio **MCP server** so AI agents can list doors, check status, and open/close them.

> ⚠️ **Warning** The MyQ API is undocumented and Chamberlain has been actively hostile to third-party integrations. The reference TypeScript implementation [`hjdhjd/myq`](https://github.com/hjdhjd/myq) (Apache-2.0) was last published in October 2023, the companion `homebridge-myq` was archived in April 2024, and Home Assistant removed its MyQ integration in late 2023 because of Cloudflare bot protection on the auth endpoint. The most actively maintained reference today is the Python [`arraylabs/pymyq`](https://github.com/arraylabs/pymyq), which is what this package now tracks for OAuth client identity (the iOS `IOS_CGI_MYQ` client; the Android variant has been deactivated server-side). Even so — **expect this to break at some point**, possibly on the very first login attempt if Cloudflare picks up your IP.

## Install

```bash
bun add @evantahler/myqq
# or
npm install @evantahler/myqq
```

## Quickstart

```ts
import { MyQ } from "@evantahler/myqq";

const myq = new MyQ({
  email: process.env.MYQ_EMAIL!,
  password: process.env.MYQ_PASSWORD!,
});

await myq.connect();

for (const door of myq.doors) {
  console.log(door.name, door.serialNumber, await door.status());
}

// Single-door homes can use the top-level helpers
await myq.open();
await myq.close();

await myq.disconnect();
```

### API surface

```ts
const myq = new MyQ({ email, password });
await myq.connect();          // login + load accounts + load devices

myq.doors;                    // Door[]
myq.getDoor(serial);          // Door | undefined

const door = myq.doors[0]!;
await door.status();          // "open"|"closed"|"opening"|"closing"|"stopped"|"transition"|"autoreverse"|"unknown"
await door.open();
await door.close();
door.name;
door.serialNumber;
door.online;                  // last known

// Convenience top-level (single-door homes or by-serial)
await myq.status(serial?);
await myq.open(serial?);
await myq.close(serial?);

await myq.disconnect();       // clears refresh timer
```

### Errors

All thrown errors extend `MyQError`:

- `MyQAuthError` — bad credentials, Cloudflare block, refresh failure
- `MyQApiError` — non-2xx from devices/commands; carries `status`, `retryAfter`
- `MyQNotFoundError` — unknown door serial

## MCP Server

`@evantahler/myqq` ships a stdio MCP server so AI agents can drive your garage doors.

### Configure (Claude Desktop / Claude Code / any MCP client)

```json
{
  "mcpServers": {
    "myqq": {
      "command": "bunx",
      "args": ["@evantahler/myqq"],
      "env": {
        "MYQ_EMAIL": "you@example.com",
        "MYQ_PASSWORD": "..."
      }
    }
  }
}
```

### Available Tools

#### Discovery

- **get_capabilities** — Lists data sources, tools, and runtime requirements

#### Doors

- **list_doors** — List all garage doors on the account (read-only)
- **get_door_status** — Current state for a door (read-only)
- **open_door** — Issue an open command (destructive — clients should confirm)
- **close_door** — Issue a close command (destructive — clients should confirm)

`serial` is optional on per-door tools when the account has exactly one door.

## Cloudflare troubleshooting

If `connect()` throws `MyQAuthError` with category `"cloudflare"`:

- Try again from a residential IP — VPNs and datacenter ranges are flagged faster
- Reduce login frequency; reuse a long-lived `MyQ` instance instead of reconnecting per request
- There is no official workaround. The Home Assistant / Homebridge communities have hit the same wall.

## Development

```bash
bun install
bun test               # mocked-fetch unit tests
bun run lint           # tsc --noEmit + biome check
bun run format         # biome --write
bun run mcp            # start the stdio MCP server (needs MYQ_EMAIL/MYQ_PASSWORD)
bun run smoke          # live end-to-end against a real account
```

## Credits

The OAuth + PKCE flow, endpoint set, and app constants were originally reverse-engineered from [`hjdhjd/myq`](https://github.com/hjdhjd/myq) (Apache-2.0). The current `IOS_CGI_MYQ` client identity and the unified-flow form handling track [`arraylabs/pymyq`](https://github.com/arraylabs/pymyq), which has stayed alive as MyQ has changed things. This is a fresh TypeScript implementation but the protocol knowledge is theirs.

## License

MIT — see [LICENSE](./LICENSE).
