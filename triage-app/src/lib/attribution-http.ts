import { NextRequest, NextResponse } from "next/server";
import {
  AttributionBatchError,
  AttributionEvaluationError,
  ContractValidationError,
  PolicyAuthorizationError,
  PolicyStoreBusyError,
  PolicyStoreCapacityError,
  PolicyStoreConfigurationError,
  PolicyStoreCorruptError,
  PolicyStoreUnavailableError,
} from "@rsocko/tyrion-kid-engine";
import { AttributionAuthError } from "@/lib/attribution-auth";
import { PolicyRuntimeConfigurationError } from "@/lib/policy-runtime";

export const MAX_ATTRIBUTION_BODY_BYTES = 64 * 1_024;

export class AttributionRequestError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "unsupported_media_type"
      | "payload_too_large",
    readonly status: 400 | 413 | 415,
    message: string
  ) {
    super(message);
    this.name = "AttributionRequestError";
  }
}

export async function readAttributionBody(
  request: NextRequest
): Promise<Uint8Array> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new AttributionRequestError(
      "unsupported_media_type",
      415,
      "Attribution requests require application/json"
    );
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new AttributionRequestError(
        "invalid_request",
        400,
        "Content-Length is invalid"
      );
    }
    if (parsed > MAX_ATTRIBUTION_BODY_BYTES) {
      throw new AttributionRequestError(
        "payload_too_large",
        413,
        "Attribution request payload is too large"
      );
    }
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new AttributionRequestError(
      "invalid_request",
      400,
      "Attribution request body is required"
    );
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ATTRIBUTION_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new AttributionRequestError(
        "payload_too_large",
        413,
        "Attribution request payload is too large"
      );
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function parseAttributionJson(body: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new AttributionRequestError(
      "invalid_request",
      400,
      "Attribution request body is invalid JSON"
    );
  }
}

export function attributionJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function handleAttributionError(error: unknown) {
  if (
    error instanceof AttributionRequestError ||
    error instanceof AttributionAuthError
  ) {
    return jsonError(error.status, error.code, error.message);
  }
  if (error instanceof AttributionBatchError) {
    const status =
      error.code === "policy_conflict"
        ? 409
        : error.code === "batch_too_large"
          ? 413
          : 503;
    return jsonError(
      status,
      error.code,
      error.message
    );
  }
  if (error instanceof ContractValidationError) {
    return jsonError(400, "invalid_request", "Attribution request is invalid");
  }
  if (error instanceof PolicyAuthorizationError) {
    return jsonError(403, "attribution_forbidden", "Attribution is not authorized");
  }
  if (
    error instanceof PolicyStoreBusyError ||
    error instanceof PolicyStoreCapacityError ||
    error instanceof PolicyStoreCorruptError ||
    error instanceof PolicyStoreUnavailableError
  ) {
    return jsonError(
      503,
      "policy_unavailable",
      "Household attribution policy is unavailable"
    );
  }
  if (
    error instanceof PolicyStoreConfigurationError ||
    error instanceof PolicyRuntimeConfigurationError ||
    error instanceof AttributionEvaluationError
  ) {
    return jsonError(
      503,
      "attribution_service_unavailable",
      "Attribution service is unavailable"
    );
  }
  return jsonError(
    500,
    "attribution_operation_failed",
    "Attribution operation failed"
  );
}

function jsonError(status: number, code: string, message: string) {
  return attributionJson({ error: { code, message } }, status);
}
