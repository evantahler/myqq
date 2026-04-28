import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp-server.ts";
import { MyQ } from "../src/myq.ts";
import { authorizeHtml, createMockFetch } from "./helpers.ts";

interface FakeDevice {
  serial_number: string;
  device_family: string;
  name?: string;
  state?: { door_state?: string; online?: boolean };
}

function mockedMyQ(devices: FakeDevice[]): {
  myq: MyQ;
  commands: Array<{ url: string; method: string }>;
} {
  const commands: Array<{ url: string; method: string }> = [];
  let phase: "login" | "post-login" = "login";

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
          headers: { Location: "com.myqops://ios?code=C" },
        };
      }
      if (i === 2) {
        phase = "post-login";
        return {
          status: 200,
          body: { access_token: "T", refresh_token: "R", expires_in: 3600 },
        };
      }
    }
    if (req.url.endsWith("/api/v6.0/accounts")) {
      return {
        status: 200,
        body: { accounts: [{ id: "ACC-1", name: "Home" }] },
      };
    }
    if (req.url.endsWith("/Accounts/ACC-1/Devices")) {
      return { status: 200, body: { items: devices } };
    }
    const single = req.url.match(/\/Accounts\/ACC-1\/Devices\/([^/]+)$/);
    if (single) {
      const dev = devices.find((d) => d.serial_number === single[1]);
      if (!dev) return { status: 404 };
      return { status: 200, body: dev };
    }
    if (
      req.url.includes("/door_openers/") &&
      (req.url.endsWith("/open") || req.url.endsWith("/close"))
    ) {
      commands.push({ url: req.url, method: req.method });
      return { status: 204 };
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });

  const myq = new MyQ({
    email: "u",
    password: "p",
    fetch: mock.fetch,
  });
  return { myq, commands };
}

let client: Client;
let cleanup: () => Promise<void>;
let commands: Array<{ url: string; method: string }>;

beforeAll(async () => {
  const fixture = mockedMyQ([
    {
      serial_number: "GDO-1",
      device_family: "garagedooropener",
      name: "Main",
      state: { door_state: "closed", online: true },
    },
  ]);
  commands = fixture.commands;
  await fixture.myq.connect();

  const { server, myq } = createServer({ myq: fixture.myq });

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  cleanup = async () => {
    await myq.disconnect();
  };
});

afterAll(async () => {
  await client.close();
  await cleanup();
});

// biome-ignore lint/suspicious/noExplicitAny: test helper
function parseRaw(result: any) {
  return JSON.parse(result.content[0].text);
}

// biome-ignore lint/suspicious/noExplicitAny: test helper
function parseResult(result: any) {
  return parseRaw(result).data;
}

describe("server metadata", () => {
  test("registers the expected tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "close_door",
      "get_capabilities",
      "get_door_status",
      "list_doors",
      "open_door",
    ]);
  });

  test("each tool has a description", async () => {
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.description?.length).toBeGreaterThan(20);
    }
  });

  test("open_door and close_door are flagged destructive", async () => {
    const { tools } = await client.listTools();
    for (const name of ["open_door", "close_door"]) {
      const tool = tools.find((t) => t.name === name);
      // biome-ignore lint/suspicious/noExplicitAny: test
      const a = (tool as any).annotations;
      expect(a.destructiveHint).toBe(true);
      expect(a.readOnlyHint).toBe(false);
    }
  });

  test("read-only tools have readOnlyHint set", async () => {
    const { tools } = await client.listTools();
    for (const name of ["list_doors", "get_door_status", "get_capabilities"]) {
      const tool = tools.find((t) => t.name === name);
      // biome-ignore lint/suspicious/noExplicitAny: test
      const a = (tool as any).annotations;
      expect(a.readOnlyHint).toBe(true);
      expect(a.destructiveHint).toBe(false);
    }
  });
});

describe("get_capabilities", () => {
  test("returns the doors data source and the env requirement", async () => {
    const result = await client.callTool({ name: "get_capabilities" });
    const data = parseResult(result);
    expect(data.dataSources).toHaveLength(1);
    expect(data.dataSources[0].name).toBe("MyQ Garage Doors");
    expect(data.requirement).toContain("MYQ_EMAIL");
    expect(data.warning).toContain("destructive");
  });
});

describe("list_doors", () => {
  test("returns wrapped door summaries with totalResults", async () => {
    const result = await client.callTool({ name: "list_doors" });
    const raw = parseRaw(result);
    expect(raw.totalResults).toBe(1);
    expect(raw.data[0].serialNumber).toBe("GDO-1");
    expect(raw.data[0].state).toBe("closed");
    expect(raw._next).toBeDefined();
  });
});

describe("get_door_status", () => {
  test("returns the canonical state", async () => {
    const result = await client.callTool({
      name: "get_door_status",
      arguments: { serial: "GDO-1" },
    });
    const data = parseResult(result);
    expect(data.state).toBe("closed");
  });
});

describe("open_door / close_door", () => {
  test("issue PUT commands against the gdo endpoint", async () => {
    commands.length = 0;
    await client.callTool({
      name: "open_door",
      arguments: { serial: "GDO-1" },
    });
    await client.callTool({
      name: "close_door",
      arguments: { serial: "GDO-1" },
    });
    expect(commands).toHaveLength(2);
    expect(commands[0]!.method).toBe("PUT");
    expect(commands[0]!.url).toContain("/door_openers/GDO-1/open");
    expect(commands[1]!.url).toContain("/door_openers/GDO-1/close");
  });

  test("returns structured error for missing serial when ambiguous", async () => {
    // Single-door fixture, so explicitly missing serial defaults to the only door
    const result = await client.callTool({
      name: "open_door",
      arguments: {},
    });
    expect(result.isError).toBeFalsy();
    const data = parseResult(result);
    expect(data.acknowledged).toBe(true);
  });

  test("returns structured error for unknown serial", async () => {
    const result = await client.callTool({
      name: "open_door",
      arguments: { serial: "MISSING" },
    });
    expect(result.isError).toBe(true);
    // biome-ignore lint/suspicious/noExplicitAny: test
    const err = JSON.parse((result as any).content[0].text);
    expect(err.error).toBe("MyQNotFoundError");
    expect(err.category).toBe("not_found");
  });
});
