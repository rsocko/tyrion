import { NextRequest, NextResponse } from "next/server";
import {
  authenticateReceiptEvidenceRequest,
  ReceiptEvidenceHttpError,
} from "@/lib/receipt-evidence-auth";
import {
  reconcileReceiptBroker,
  submitReceiptBroker,
} from "@/lib/receipt-broker-service";

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
      path[0] === "replicas"
    ) {
      const result = await submitReceiptBroker(request);
      return json(result.body, result.status);
    }
    if (
      request.method === "POST" &&
      path.length === 3 &&
      path[0] === "replicas" &&
      path[2] === "reconcile"
    ) {
      const result = await reconcileReceiptBroker(path[1]!, request.headers);
      return json(result.body, result.status);
    }
    throw new ReceiptEvidenceHttpError(
      404,
      "receipt_broker_route_not_available",
      "Receipt broker operation is not available"
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
          code: "receipt_broker_unavailable",
          message: "Receipt broker operation is unavailable",
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

export const POST = handle;
