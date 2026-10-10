import { NextRequest, NextResponse } from "next/server";
import {
  authenticateReceiptEvidenceRequest,
  ReceiptEvidenceHttpError,
} from "@/lib/receipt-evidence-auth";
import {
  readReceiptEvidence,
  reconcileReceiptEvidence,
  submitReceiptEvidence,
} from "@/lib/receipt-evidence-service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext) {
  try {
    authenticateReceiptEvidenceRequest(request);
    const { path } = await context.params;
    if (
      request.method === "POST" &&
      path.length === 1 &&
      path[0] === "occurrences"
    ) {
      return json(await submitReceiptEvidence(request), 202);
    }
    if (
      request.method === "GET" &&
      path.length === 2 &&
      path[0] === "occurrences"
    ) {
      return json(await readReceiptEvidence(path[1]!), 200);
    }
    if (
      request.method === "POST" &&
      path.length === 3 &&
      path[0] === "occurrences" &&
      path[2] === "reconcile"
    ) {
      return json(await reconcileReceiptEvidence(path[1]!), 200);
    }
    throw new ReceiptEvidenceHttpError(
      404,
      "receipt_evidence_route_not_available",
      "Receipt evidence operation is not available"
    );
  } catch (error) {
    if (error instanceof ReceiptEvidenceHttpError) {
      return NextResponse.json(
        { error: { code: error.code, message: error.message } },
        {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }
    return NextResponse.json(
      {
        error: {
          code: "receipt_evidence_unavailable",
          message: "Receipt evidence operation is unavailable",
        },
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

function json(value: unknown, status: number) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export const GET = handle;
export const POST = handle;
