import { NextRequest, NextResponse } from "next/server";
import {
  FinanceInsightContractValidationError,
  createInsightErrorV1,
  isFinanceInsightStoreError,
  MAX_REQUEST_BYTES_V1,
  type InsightErrorCodeV1,
} from "@rsocko/tyrion-finance-insights";
import {
  FinanceInsightHttpError,
} from "@/lib/finance-insight-auth";
import { FinanceInsightRuntimeConfigurationError } from "@/lib/finance-insight-runtime";

const MAX_RESPONSE_BYTES = 512 * 1024;

export async function readFinanceInsightJson(
  request: NextRequest
): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new FinanceInsightHttpError("unsupported_media_type");
  }
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new FinanceInsightHttpError("invalid_request");
    }
    if (length > MAX_REQUEST_BYTES_V1) {
      throw new FinanceInsightHttpError("payload_too_large");
    }
  }
  const reader = request.body?.getReader();
  if (!reader) throw new FinanceInsightHttpError("invalid_request");
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES_V1) {
      await reader.cancel().catch(() => undefined);
      throw new FinanceInsightHttpError("payload_too_large");
    }
    chunks.push(value);
  }
  if (total === 0) throw new FinanceInsightHttpError("invalid_request");
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new FinanceInsightHttpError("invalid_request");
  }
}

export function financeInsightJson(value: unknown, status = 200): NextResponse {
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESPONSE_BYTES) {
    return financeInsightError("page_too_large");
  }
  return new NextResponse(serialized, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

export function handleFinanceInsightError(error: unknown): NextResponse {
  if (error instanceof FinanceInsightHttpError) {
    return financeInsightError(error.code);
  }
  if (isFinanceInsightStoreError(error)) {
    return descriptorResponse(error.descriptor);
  }
  if (error instanceof FinanceInsightContractValidationError) {
    return financeInsightError("invalid_request");
  }
  if (error instanceof FinanceInsightRuntimeConfigurationError) {
    return financeInsightError("insight_service_not_configured");
  }
  return financeInsightError("insight_operation_failed");
}

export function financeInsightError(code: InsightErrorCodeV1): NextResponse {
  return descriptorResponse(
    code === "evaluation_in_progress"
      ? createInsightErrorV1(code, 30)
      : createInsightErrorV1(code)
  );
}

function descriptorResponse(
  descriptor: ReturnType<typeof createInsightErrorV1>
): NextResponse {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (descriptor.retryAfterSeconds !== null) {
    headers["Retry-After"] = String(descriptor.retryAfterSeconds);
  }
  return NextResponse.json(descriptor.body, {
    status: descriptor.status,
    headers,
  });
}
