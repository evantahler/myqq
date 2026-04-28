#!/usr/bin/env bun

import { MyQError } from "../src/errors.ts";
import { MyQ } from "../src/myq.ts";
import type { DoorState } from "../src/types.ts";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env var is required to run the smoke script`);
  }
  return value;
}

function colorState(state: DoorState): string {
  switch (state) {
    case "open":
      return `${c.green}${state}${c.reset}`;
    case "closed":
      return `${c.red}${state}${c.reset}`;
    case "opening":
    case "closing":
    case "transition":
    case "autoreverse":
      return `${c.yellow}${state}${c.reset}`;
    default:
      return `${c.dim}${state}${c.reset}`;
  }
}

function colorOnline(online: boolean): string {
  return online ? `${c.green}yes${c.reset}` : `${c.red}no${c.reset}`;
}

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length;
}

function pad(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

interface Row {
  name: string;
  serial: string;
  online: string;
  state: string;
}

function printTable(rows: Row[]): void {
  const headers: Row = {
    name: "NAME",
    serial: "SERIAL",
    online: "ONLINE",
    state: "STATE",
  };
  const widths = {
    name: Math.max(
      visibleLength(headers.name),
      ...rows.map((r) => visibleLength(r.name)),
    ),
    serial: Math.max(
      visibleLength(headers.serial),
      ...rows.map((r) => visibleLength(r.serial)),
    ),
    online: Math.max(
      visibleLength(headers.online),
      ...rows.map((r) => visibleLength(r.online)),
    ),
    state: Math.max(
      visibleLength(headers.state),
      ...rows.map((r) => visibleLength(r.state)),
    ),
  };
  const sep = `+-${"-".repeat(widths.name)}-+-${"-".repeat(widths.serial)}-+-${"-".repeat(widths.online)}-+-${"-".repeat(widths.state)}-+`;
  const row = (r: Row) =>
    `| ${pad(r.name, widths.name)} | ${pad(r.serial, widths.serial)} | ${pad(r.online, widths.online)} | ${pad(r.state, widths.state)} |`;

  console.log(sep);
  console.log(
    row({
      name: `${c.bold}${headers.name}${c.reset}`,
      serial: `${c.bold}${headers.serial}${c.reset}`,
      online: `${c.bold}${headers.online}${c.reset}`,
      state: `${c.bold}${headers.state}${c.reset}`,
    }),
  );
  console.log(sep);
  for (const r of rows) console.log(row(r));
  console.log(sep);
}

async function main(): Promise<void> {
  const myq = new MyQ({
    email: requireEnv("MYQ_EMAIL"),
    password: requireEnv("MYQ_PASSWORD"),
  });

  try {
    console.log(`${c.dim}Connecting to MyQ...${c.reset}`);
    await myq.connect();

    const account = myq.account;
    if (account) {
      const label = account.name
        ? `${account.name} (${account.id})`
        : account.id;
      console.log(`${c.bold}Account:${c.reset} ${c.cyan}${label}${c.reset}`);
    }

    const doors = myq.doors;
    console.log(`${c.bold}Doors:${c.reset} ${doors.length}\n`);

    if (doors.length === 0) {
      console.log(`${c.yellow}No doors on this account.${c.reset}`);
      return;
    }

    const rows: Row[] = await Promise.all(
      doors.map(async (door) => {
        const state = await door.status();
        return {
          name: door.name,
          serial: door.serialNumber,
          online: colorOnline(door.online),
          state: colorState(state),
        };
      }),
    );

    printTable(rows);
  } finally {
    await myq.disconnect();
  }
}

main().catch((err: unknown) => {
  if (err instanceof MyQError) {
    console.error(`${c.red}${c.bold}${err.name}${c.reset}: ${err.message}`);
    console.error(`  category: ${err.category}`);
    if (err.recovery) console.error(`  recovery: ${err.recovery}`);
    if (err.status !== undefined) console.error(`  status: ${err.status}`);
  } else if (err instanceof Error) {
    console.error(`${c.red}${c.bold}${err.name}${c.reset}: ${err.message}`);
  } else {
    console.error(`${c.red}${c.bold}Error${c.reset}:`, err);
  }
  process.exit(1);
});
