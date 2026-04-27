import { z } from "zod";
import {
  destructiveAnnotations,
  type McpServerInstance,
  readOnlyAnnotations,
  wrapTool,
} from "./mcp-helpers.ts";
import type { MyQ } from "./myq.ts";

export const doorsCapability = {
  name: "MyQ Garage Doors",
  description:
    "Control and inspect MyQ-enabled garage doors on this account. Open and close are destructive — clients should confirm before invoking.",
  tools: ["list_doors", "get_door_status", "open_door", "close_door"],
  startWith: "list_doors",
};

const serialInput = {
  serial: z
    .string()
    .optional()
    .describe(
      "Door serial number from list_doors. Optional when the account has exactly one door.",
    ),
};

export function registerDoorTools(server: McpServerInstance, myq: MyQ): void {
  server.registerTool(
    "list_doors",
    {
      title: "List MyQ doors",
      description:
        "List all MyQ-enabled garage doors on this account, with current cached state. Refreshes the device list before returning. Follow up with get_door_status for fresh state, or open_door/close_door to operate.",
      annotations: readOnlyAnnotations,
    },
    async () =>
      wrapTool(async () => {
        await myq.refreshDevices();
        return myq.doors.map((d) => d.toJSON());
      }, [
        {
          tool: "get_door_status",
          description: "Refresh and return state for a specific door",
        },
        { tool: "open_door", description: "Open a specific door" },
        { tool: "close_door", description: "Close a specific door" },
      ]),
  );

  server.registerTool(
    "get_door_status",
    {
      title: "Get door status",
      description:
        "Fetch fresh state for a specific door. Returns one of: open, closed, opening, closing, stopped, transition, autoreverse, unknown.",
      annotations: readOnlyAnnotations,
      inputSchema: serialInput,
    },
    async ({ serial }) =>
      wrapTool(async () => ({ state: await myq.status(serial) })),
  );

  server.registerTool(
    "open_door",
    {
      title: "Open door",
      description:
        "Issue an open command to a MyQ door. Resolves once the API acknowledges the command, NOT once the door is fully open. The user/client should confirm before calling — opening a garage is a real-world destructive action.",
      annotations: destructiveAnnotations,
      inputSchema: serialInput,
    },
    async ({ serial }) =>
      wrapTool(async () => {
        await myq.open(serial);
        return { acknowledged: true, command: "open", serial: serial ?? null };
      }),
  );

  server.registerTool(
    "close_door",
    {
      title: "Close door",
      description:
        "Issue a close command to a MyQ door. Resolves once the API acknowledges the command, NOT once the door is fully closed. The user/client should confirm before calling.",
      annotations: destructiveAnnotations,
      inputSchema: serialInput,
    },
    async ({ serial }) =>
      wrapTool(async () => {
        await myq.close(serial);
        return { acknowledged: true, command: "close", serial: serial ?? null };
      }),
  );
}
