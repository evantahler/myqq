export interface MockResponseSpec {
  status?: number;
  headers?: Record<string, string | string[] | undefined>;
  body?: string | object;
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface MockFetch {
  fetch: typeof fetch;
  requests: RecordedRequest[];
}

export function createMockFetch(
  handler: (
    request: RecordedRequest,
    index: number,
  ) => MockResponseSpec | Promise<MockResponseSpec>,
): MockFetch {
  const requests: RecordedRequest[] = [];

  const mock = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;
    const method = (init?.method ?? "GET").toUpperCase();
    const headersIn = new Headers(init?.headers ?? {});
    const headers: Record<string, string> = {};
    headersIn.forEach((v, k) => {
      headers[k] = v;
    });
    const body =
      typeof init?.body === "string" ? init.body : init?.body ? "" : undefined;

    const recorded: RecordedRequest = { url, method, headers, body };
    requests.push(recorded);

    const spec = await handler(recorded, requests.length - 1);
    return buildResponse(spec);
  };

  return { fetch: mock as unknown as typeof fetch, requests };
}

function buildResponse(spec: MockResponseSpec): Response {
  const status = spec.status ?? 200;
  const headers = new Headers();
  if (spec.headers) {
    for (const [name, value] of Object.entries(spec.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const v of value) headers.append(name, v);
      } else {
        headers.set(name, value);
      }
    }
  }
  let body: string | null = null;
  if (typeof spec.body === "string") {
    body = spec.body;
  } else if (spec.body !== undefined) {
    body = JSON.stringify(spec.body);
    if (!headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
  }
  return new Response(body, { status, headers });
}

export function authorizeHtml(token = "vtoken123"): string {
  return `<!DOCTYPE html><html><body>
<form method="post" action="/Account/LoginWithEmail?returnUrl=%2Fconnect%2Fauthorize%2Fcallback">
  <input type="hidden" name="ReturnUrl" value="/connect/authorize/callback?client_id=IOS_CGI_MYQ&amp;code_challenge=abc" />
  <input type="hidden" name="Brand" value="myq" />
  <input type="hidden" name="UnifiedFlowRequested" value="True" />
  <input type="hidden" name="__RequestVerificationToken" value="${token}" />
  <input type="email" name="Email" />
  <input type="password" name="Password" />
</form>
</body></html>`;
}

export function cloudflareHtml(): string {
  return `<!DOCTYPE html><html><body>
<title>Attention Required! | Cloudflare</title>
<div class="cf-browser-verification"></div>
</body></html>`;
}
