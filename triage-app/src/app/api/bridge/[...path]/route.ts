import { NextRequest, NextResponse } from "next/server";

const BRIDGE_URL = process.env.BRIDGE_URL || "http://localhost:8100";
const BRIDGE_API_TOKEN = process.env.BRIDGE_API_TOKEN;
const BRIDGE_TIMEOUT_MS = 30_000;

async function proxyRequest(request: NextRequest, params: { path: string[] }) {
  const path = params.path.map(encodeURIComponent).join("/");
  const url = new URL(`${BRIDGE_URL}/${path}`);

  // Forward query params
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.set(key, value);
  });

  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  if (BRIDGE_API_TOKEN) {
    headers.Authorization = `Bearer ${BRIDGE_API_TOKEN}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  const fetchOptions: RequestInit = {
    method: request.method,
    headers,
    cache: "no-store",
    signal: controller.signal,
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      const body = await request.text();
      if (body) {
        fetchOptions.body = body;
      }
    } catch {
      // No body to forward
    }
  }

  try {
    const res = await fetch(url.toString(), fetchOptions);
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("application/json")) {
      return NextResponse.json(
        { error: { code: "invalid_bridge_response", message: "Bridge returned an invalid response" } },
        { status: 502 }
      );
    }
    const data: unknown = await res.json();
    return NextResponse.json(data, {
      status: res.status,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      { error: { code: "bridge_unavailable", message: "Bridge unavailable" } },
      { status: 502 }
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(request, params);
}

export async function POST(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(request, params);
}

export async function PATCH(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(request, params);
}

export async function PUT(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(request, params);
}

export async function DELETE(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxyRequest(request, params);
}
