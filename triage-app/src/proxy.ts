import { NextRequest, NextResponse } from "next/server";

const PUBLIC_CONNECTOR_MARKER = "x-tyrion-public-connector";
const CONNECTOR_PATH_PREFIX = "/api/connector/v1/";

export function proxy(request: NextRequest) {
  if (
    request.headers.get(PUBLIC_CONNECTOR_MARKER) === "1" &&
    !request.nextUrl.pathname.startsWith(CONNECTOR_PATH_PREFIX)
  ) {
    return NextResponse.json(
      {
        error: {
          code: "connector_route_not_available",
          message: "This operation is not available through the connector gateway",
        },
      },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    );
  }
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
