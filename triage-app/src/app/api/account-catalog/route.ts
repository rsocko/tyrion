import { NextRequest, NextResponse } from "next/server";
import {
  AccountCatalogServerError,
  loadAccountCatalogServer,
} from "@/lib/account-catalog-server";

function error(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

function expectedOrigin(request: NextRequest): string {
  const host =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host");
  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(":", "");
  return host ? `${protocol}://${host}` : request.nextUrl.origin;
}

function isSameOrigin(request: NextRequest): boolean {
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  const origin = request.headers.get("origin");
  return origin === null || origin === expectedOrigin(request);
}

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return error(
      403,
      "account_catalog_forbidden",
      "Account catalog requires a same-origin request"
    );
  }
  try {
    return NextResponse.json(
      { accounts: await loadAccountCatalogServer() },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (caught) {
    const code =
      caught instanceof AccountCatalogServerError && caught.code === "invalid"
        ? "account_catalog_invalid"
        : "account_catalog_unavailable";
    return error(
      caught instanceof AccountCatalogServerError && caught.code === "invalid"
        ? 502
        : 503,
      code,
      "Account catalog is unavailable"
    );
  }
}
