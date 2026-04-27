import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MyQError } from "./errors.ts";

export interface NextAction {
  tool: string;
  description: string;
}

export const readOnlyAnnotations = {
  readOnlyHint: true as const,
  destructiveHint: false as const,
  idempotentHint: true as const,
  openWorldHint: false as const,
};

export const destructiveAnnotations = {
  readOnlyHint: false as const,
  destructiveHint: true as const,
  idempotentHint: false as const,
  openWorldHint: true as const,
};

export function toolError(e: MyQError) {
  return {
    isError: true as const,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          error: e.name,
          message: e.message,
          category: e.category,
          retryable: e.retryable,
          recovery: e.recovery,
          status: e.status,
          retryAfter: e.retryAfter,
        }),
      },
    ],
  };
}

export async function wrapTool<T>(
  fn: () => Promise<T> | T,
  hints?: NextAction[],
) {
  try {
    const data = await fn();
    const result: Record<string, unknown> = { data };
    if (Array.isArray(data)) result.totalResults = data.length;
    if (hints?.length) result._next = hints;
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(result, null, 2) },
      ],
    };
  } catch (e) {
    if (e instanceof MyQError) return toolError(e);
    throw e;
  }
}

export type McpServerInstance = InstanceType<typeof McpServer>;
