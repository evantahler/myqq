#!/usr/bin/env bun

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import { readOnlyAnnotations, wrapTool } from "./mcp-helpers.ts";
import { doorsCapability, registerDoorTools } from "./mcp-tools.ts";
import { MyQ } from "./myq.ts";
import type { MyQOptions } from "./types.ts";

export interface ServerOptions {
  myq?: MyQ;
  myqOptions?: MyQOptions;
}

export function createServer(options: ServerOptions = {}) {
  const myq =
    options.myq ??
    new MyQ(
      options.myqOptions ?? {
        email: requireEnv("MYQ_EMAIL"),
        password: requireEnv("MYQ_PASSWORD"),
      },
    );

  const server = new McpServer({
    name: pkg.name,
    version: pkg.version,
  });

  server.registerTool(
    "get_capabilities",
    {
      title: "Get server capabilities",
      description:
        "Discover available tools and runtime requirements. Call this first to understand what this MyQ MCP server can do.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      wrapTool(() => ({
        dataSources: [doorsCapability],
        requirement:
          "MYQ_EMAIL and MYQ_PASSWORD env vars; subject to Cloudflare bot protection",
        warning:
          "open_door and close_door are real-world destructive actions. Confirm with the user first.",
      })),
  );

  registerDoorTools(server, myq);

  return { server, myq };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} env var is required to start the myqq MCP server`);
  }
  return value;
}

if (import.meta.main) {
  const { server, myq } = createServer();
  await myq.connect();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.on("beforeExit", () => {
    myq.disconnect();
  });
}
