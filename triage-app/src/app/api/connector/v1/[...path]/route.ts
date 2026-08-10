import { NextRequest, NextResponse } from "next/server";
import {
  authenticateConnectorRequest,
  evaluateConnectorRequest,
  isBrowserConnectorRequest,
  MAX_CONNECTOR_REQUEST_BODY_BYTES,
  MAX_CONNECTOR_RESPONSE_BYTES,
  parseCategoryMutation,
  resolveConnectorBridgeUrl,
} from "@/lib/connector-gateway-policy.mjs";

const BRIDGE_TIMEOUT_MS = 30_000;
const FORWARDED_RESPONSE_HEADERS = [
  "cache-control",
  "content-type",
  "retry-after",
  "x-monarch-contract-version",
] as const;

type ConnectorRouteContext = RouteContext<"/api/connector/v1/[...path]">;

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

async function readBoundedBody(request: NextRequest, maximumBytes: number) {
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) {
      return { error: jsonError(400, "invalid_request", "Content-Length is invalid") };
    }
    if (parsedLength > maximumBytes) {
      return {
        error: jsonError(413, "payload_too_large", "Request payload is too large"),
      };
    }
  }

  const reader = request.body?.getReader();
  if (!reader) return { bytes: new Uint8Array() };
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return {
        error: jsonError(413, "payload_too_large", "Request payload is too large"),
      };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
}

async function readBoundedResponse(response: Response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_CONNECTOR_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_CONNECTOR_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function proxyConnectorRequest(
  request: NextRequest,
  context: ConnectorRouteContext
) {
  const authentication = authenticateConnectorRequest(
    request.headers.get("authorization"),
    process.env.BRIDGE_API_TOKEN
  );
  if (!authentication.allowed) {
    return jsonError(
      authentication.status,
      authentication.error.code,
      authentication.error.message
    );
  }

  if (isBrowserConnectorRequest(request.headers)) {
    return jsonError(
      403,
      "browser_request_rejected",
      "Browser requests are not accepted by the connector gateway"
    );
  }

  const { path } = await context.params;
  const policy = evaluateConnectorRequest(
    request.method,
    path,
    request.nextUrl.searchParams
  );
  if (!policy.allowed) {
    return jsonError(policy.status, policy.error.code, policy.error.message);
  }

  const bridge = resolveConnectorBridgeUrl(process.env.BRIDGE_URL);
  if (!bridge.configured) {
    return jsonError(
      503,
      "connector_gateway_misconfigured",
      "Connector gateway is not configured"
    );
  }

  let body: string | undefined;
  if (policy.acceptsBody) {
    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      return jsonError(
        415,
        "unsupported_media_type",
        "Category updates require application/json"
      );
    }
    let boundedBody: Awaited<ReturnType<typeof readBoundedBody>>;
    try {
      boundedBody = await readBoundedBody(
        request,
        MAX_CONNECTOR_REQUEST_BODY_BYTES
      );
    } catch {
      return jsonError(400, "invalid_request", "Request body could not be read");
    }
    if (boundedBody.error) return boundedBody.error;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(boundedBody.bytes));
    } catch {
      return jsonError(400, "invalid_request", "Request body is invalid JSON");
    }
    const mutation = parseCategoryMutation(parsed);
    if (!mutation.allowed) {
      return jsonError(
        mutation.status,
        mutation.error.code,
        mutation.error.message
      );
    }
    body = mutation.body;
  } else if (request.body || request.headers.has("content-length")) {
    const boundedBody = await readBoundedBody(
      request,
      MAX_CONNECTOR_REQUEST_BODY_BYTES
    ).catch(() => ({
      error: jsonError(400, "invalid_request", "Request body could not be read"),
    }));
    if (boundedBody.error) return boundedBody.error;
    if (boundedBody.bytes.byteLength > 0) {
      return jsonError(
        400,
        "invalid_request",
        "This connector operation does not accept a body"
      );
    }
  }

  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${authentication.token}`,
  });
  if (body !== undefined) headers.set("Content-Type", "application/json");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);

  try {
    const response = await fetch(new URL(policy.upstreamPath, bridge.baseUrl), {
      method: request.method,
      headers,
      body,
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      return jsonError(
        502,
        "invalid_bridge_response",
        "Bridge returned an invalid response"
      );
    }
    const responseBody = await readBoundedResponse(response);
    if (!responseBody) {
      return jsonError(
        502,
        "invalid_bridge_response",
        "Bridge returned an invalid response"
      );
    }
    try {
      JSON.parse(new TextDecoder().decode(responseBody));
    } catch {
      return jsonError(
        502,
        "invalid_bridge_response",
        "Bridge returned an invalid response"
      );
    }
    const responseHeaders = new Headers();
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = response.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    responseHeaders.set("Cache-Control", "no-store");
    return new Response(responseBody, {
      status: response.status,
      headers: responseHeaders,
    });
  } catch {
    return jsonError(502, "bridge_unavailable", "Bridge unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export const dynamic = "force-dynamic";

export function GET(request: NextRequest, context: ConnectorRouteContext) {
  return proxyConnectorRequest(request, context);
}

export function POST(request: NextRequest, context: ConnectorRouteContext) {
  return proxyConnectorRequest(request, context);
}

export function PUT(request: NextRequest, context: ConnectorRouteContext) {
  return proxyConnectorRequest(request, context);
}

export function PATCH(request: NextRequest, context: ConnectorRouteContext) {
  return proxyConnectorRequest(request, context);
}

export function DELETE(request: NextRequest, context: ConnectorRouteContext) {
  return proxyConnectorRequest(request, context);
}

export function OPTIONS(request: NextRequest, context: ConnectorRouteContext) {
  return proxyConnectorRequest(request, context);
}
