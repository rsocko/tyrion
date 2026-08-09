import { NextRequest, NextResponse } from "next/server";
import {
  evaluateBridgeRequest,
  resolveBridgeConfiguration,
} from "@/lib/bridge-proxy-policy.mjs";

const BRIDGE_TIMEOUT_MS = 30_000;
const MAX_REQUEST_BODY_BYTES = 16_384;

type BridgeRouteContext = RouteContext<"/api/bridge/[...path]">;

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function requestOrigin(request: NextRequest) {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProtocol = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host");
  const protocol = forwardedProtocol || request.nextUrl.protocol.replace(":", "");
  return host ? `${protocol}://${host}` : request.nextUrl.origin;
}

function validatePostOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (!origin || origin !== requestOrigin(request)) {
    return false;
  }
  return !fetchSite || fetchSite === "same-origin";
}

async function readBoundedBody(request: NextRequest) {
  if (!request.body) {
    return { body: "" };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: new TextDecoder().decode(body) };
}

async function proxyRequest(request: NextRequest, context: BridgeRouteContext) {
  const { path } = await context.params;
  const policy = evaluateBridgeRequest(
    request.method,
    path,
    request.nextUrl.searchParams
  );
  if (!policy.allowed) {
    return jsonError(policy.status, policy.error.code, policy.error.message);
  }

  const configuration = resolveBridgeConfiguration(
    process.env.BRIDGE_URL,
    process.env.BRIDGE_API_TOKEN,
    policy.requiresToken
  );
  if (!configuration.configured) {
    return jsonError(503, "bridge_proxy_misconfigured", "Bridge proxy is not configured");
  }

  if (request.method === "POST" && !validatePostOrigin(request)) {
    return jsonError(403, "cross_site_request_rejected", "Cross-site request rejected");
  }

  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (!Number.isInteger(parsedLength) || parsedLength < 0) {
      return jsonError(400, "invalid_request", "Content-Length is invalid");
    }
    if (parsedLength > MAX_REQUEST_BODY_BYTES) {
      return jsonError(413, "payload_too_large", "Request payload is too large");
    }
  }

  const headers = new Headers({ Accept: "application/json" });
  if (configuration.token) {
    headers.set("Authorization", `Bearer ${configuration.token}`);
  }

  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
  };
  if (request.method === "POST") {
    const expectsJsonBody = policy.upstreamPath.startsWith("/auth/login");
    const contentType = request.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (expectsJsonBody && contentType !== "application/json") {
      return jsonError(415, "unsupported_media_type", "Authentication requires application/json");
    }

    let boundedBody: Awaited<ReturnType<typeof readBoundedBody>>;
    try {
      boundedBody = await readBoundedBody(request);
    } catch {
      return jsonError(400, "invalid_request", "Request body could not be read");
    }
    if (boundedBody.tooLarge) {
      return jsonError(413, "payload_too_large", "Request payload is too large");
    }
    const body = boundedBody.body || "";
    if (!expectsJsonBody && body) {
      return jsonError(400, "invalid_request", "This bridge operation does not accept a body");
    }
    if (body) {
      headers.set("Content-Type", "application/json");
      fetchOptions.body = body;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  fetchOptions.signal = controller.signal;

  try {
    const upstreamUrl = new URL(policy.upstreamPath, configuration.baseUrl);
    const response = await fetch(upstreamUrl, fetchOptions);
    const contentType = response.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonError(502, "invalid_bridge_response", "Bridge returned an invalid response");
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return jsonError(502, "invalid_bridge_response", "Bridge returned an invalid response");
    }
    return NextResponse.json(payload, {
      status: response.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return jsonError(502, "bridge_unavailable", "Bridge unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

export const dynamic = "force-dynamic";

export function GET(request: NextRequest, context: BridgeRouteContext) {
  return proxyRequest(request, context);
}

export function POST(request: NextRequest, context: BridgeRouteContext) {
  return proxyRequest(request, context);
}

export function PUT(request: NextRequest, context: BridgeRouteContext) {
  return proxyRequest(request, context);
}

export function PATCH(request: NextRequest, context: BridgeRouteContext) {
  return proxyRequest(request, context);
}

export function DELETE(request: NextRequest, context: BridgeRouteContext) {
  return proxyRequest(request, context);
}
