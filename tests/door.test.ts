import { describe, expect, it } from "bun:test";
import { MyQNotFoundError } from "../src/errors.ts";
import { MyQ } from "../src/myq.ts";
import { authorizeHtml, createMockFetch } from "./helpers.ts";

interface FakeDevice {
  serial_number: string;
  device_family: string;
  name?: string;
  state?: { door_state?: string; online?: boolean };
}

function setupMyQ(opts: {
  devices: FakeDevice[];
  doorStateOverrides?: Record<string, string>;
  commandStatus?: number;
}) {
  const commands: Array<{ url: string; method: string }> = [];
  const refreshes: Array<{ url: string }> = [];
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
          headers: { Location: "com.myqops://android?code=C" },
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
        body: { accounts: [{ id: "ACC-1", name: "Test" }] },
      };
    }
    if (req.url.endsWith("/Accounts/ACC-1/Devices")) {
      refreshes.push({ url: req.url });
      return { status: 200, body: { items: opts.devices } };
    }
    const single = req.url.match(/\/Accounts\/ACC-1\/Devices\/([^/]+)$/);
    if (single) {
      const serial = single[1]!;
      const dev = opts.devices.find((d) => d.serial_number === serial);
      if (!dev) return { status: 404, body: "" };
      const newState = opts.doorStateOverrides?.[serial];
      const stateBlock = {
        ...(dev.state ?? {}),
        ...(newState ? { door_state: newState } : {}),
      };
      return { status: 200, body: { ...dev, state: stateBlock } };
    }
    if (
      req.url.includes("/door_openers/") &&
      (req.url.endsWith("/open") || req.url.endsWith("/close"))
    ) {
      commands.push({ url: req.url, method: req.method });
      return { status: opts.commandStatus ?? 204 };
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  });

  const myq = new MyQ({
    email: "u",
    password: "p",
    fetch: mock.fetch,
  });

  return { myq, commands, refreshes };
}

describe("Door + MyQ", () => {
  it("connects, lists garage doors, and ignores other device families", async () => {
    const { myq } = setupMyQ({
      devices: [
        {
          serial_number: "GDO-1",
          device_family: "garagedooropener",
          name: "Main",
          state: { door_state: "closed", online: true },
        },
        {
          serial_number: "LAMP-1",
          device_family: "lamp",
        },
      ],
    });
    await myq.connect();
    expect(myq.doors).toHaveLength(1);
    expect(myq.doors[0]!.serialNumber).toBe("GDO-1");
    expect(myq.doors[0]!.name).toBe("Main");
    expect(myq.doors[0]!.online).toBe(true);
    expect(myq.doors[0]!.state).toBe("closed");
    await myq.disconnect();
  });

  it("normalizes unknown door states", async () => {
    const { myq } = setupMyQ({
      devices: [
        {
          serial_number: "GDO-1",
          device_family: "garagedooropener",
          state: { door_state: "weirdstate" },
        },
      ],
    });
    await myq.connect();
    expect(myq.doors[0]!.state).toBe("unknown");
    await myq.disconnect();
  });

  it("status() refreshes and returns the canonical state", async () => {
    const overrides: Record<string, string> = {};
    const { myq } = setupMyQ({
      devices: [
        {
          serial_number: "GDO-1",
          device_family: "garagedooropener",
          state: { door_state: "closed" },
        },
      ],
      doorStateOverrides: overrides,
    });
    await myq.connect();
    overrides["GDO-1"] = "opening";
    expect(await myq.status("GDO-1")).toBe("opening");
    expect(myq.doors[0]!.state).toBe("opening");
    await myq.disconnect();
  });

  it("open/close hit the gdo command path", async () => {
    const { myq, commands } = setupMyQ({
      devices: [
        {
          serial_number: "GDO-1",
          device_family: "garagedooropener",
          state: { door_state: "closed" },
        },
      ],
    });
    await myq.connect();
    await myq.open("GDO-1");
    await myq.close("GDO-1");
    expect(commands).toHaveLength(2);
    expect(commands[0]!.method).toBe("PUT");
    expect(commands[0]!.url).toContain(
      "account-devices-gdo.myq-cloud.com/api/v5.2/Accounts/ACC-1/door_openers/GDO-1/open",
    );
    expect(commands[1]!.url).toContain("/door_openers/GDO-1/close");
    await myq.disconnect();
  });

  it("getDoor returns undefined for missing serials", async () => {
    const { myq } = setupMyQ({
      devices: [
        {
          serial_number: "GDO-1",
          device_family: "garagedooropener",
        },
      ],
    });
    await myq.connect();
    expect(myq.getDoor("missing")).toBeUndefined();
    await myq.disconnect();
  });

  it("top-level helpers throw MyQNotFoundError when ambiguous", async () => {
    const { myq } = setupMyQ({
      devices: [
        { serial_number: "A", device_family: "garagedooropener" },
        { serial_number: "B", device_family: "garagedooropener" },
      ],
    });
    await myq.connect();
    await expect(myq.open()).rejects.toBeInstanceOf(MyQNotFoundError);
    await myq.disconnect();
  });

  it("top-level helpers default to the only door", async () => {
    const { myq, commands } = setupMyQ({
      devices: [{ serial_number: "ONLY", device_family: "garagedooropener" }],
    });
    await myq.connect();
    await myq.open();
    expect(commands[0]!.url).toContain("/door_openers/ONLY/open");
    await myq.disconnect();
  });
});
