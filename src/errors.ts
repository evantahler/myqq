export type MyQErrorCategory =
  | "auth"
  | "api"
  | "not_found"
  | "cloudflare"
  | "invalid_input";

export interface MyQErrorOptions {
  category: MyQErrorCategory;
  retryable?: boolean;
  recovery?: string;
  status?: number;
  retryAfter?: number;
  cause?: unknown;
}

export class MyQError extends Error {
  override readonly name: string = "MyQError";
  readonly category: MyQErrorCategory;
  readonly retryable: boolean;
  readonly recovery: string | undefined;
  readonly status: number | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, opts: MyQErrorOptions) {
    super(
      message,
      opts.cause !== undefined ? { cause: opts.cause } : undefined,
    );
    this.category = opts.category;
    this.retryable = opts.retryable ?? false;
    this.recovery = opts.recovery;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
  }
}

export class MyQAuthError extends MyQError {
  override readonly name = "MyQAuthError";
  constructor(
    message: string,
    opts: Omit<MyQErrorOptions, "category"> & {
      category?: "auth" | "cloudflare";
    } = {},
  ) {
    super(message, { ...opts, category: opts.category ?? "auth" });
  }
}

export class MyQApiError extends MyQError {
  override readonly name = "MyQApiError";
  constructor(message: string, opts: Omit<MyQErrorOptions, "category"> = {}) {
    super(message, { ...opts, category: "api" });
  }
}

export class MyQNotFoundError extends MyQError {
  override readonly name = "MyQNotFoundError";
  constructor(message: string, opts: Omit<MyQErrorOptions, "category"> = {}) {
    super(message, {
      ...opts,
      category: "not_found",
      recovery:
        opts.recovery ?? "Use list_doors / myq.doors to see available serials",
    });
  }
}
