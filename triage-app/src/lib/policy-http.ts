import { NextRequest, NextResponse } from "next/server";
import {
  ContractValidationError,
  PolicyAuthorizationError,
  PolicyStoreBusyError,
  PolicyStoreCapacityError,
  PolicyStoreConfigurationError,
  PolicyStoreCorruptError,
  PolicyStoreUnavailableError,
  PolicyVersionConflictError,
  ReattributionError,
} from "@rsocko/tyrion-kid-engine";
import {
  PolicyRuntimeConfigurationError,
  InstrumentReferenceError,
  ReattributionIntegrationError,
} from "@/lib/policy-runtime";

const MAX_POLICY_BODY_BYTES = 64 * 1_024;

export function policyJson(value: unknown, status = 200) {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

export function policyError(error: unknown) {
  if (error instanceof PolicyAuthorizationError) {
    return jsonError(403, error.code, error.message);
  }
  if (error instanceof PolicyVersionConflictError) {
    return jsonError(409, error.code, error.message);
  }
  if (error instanceof ContractValidationError) {
    return jsonError(422, error.code, error.message);
  }
  if (error instanceof InstrumentReferenceError) {
    return jsonError(422, error.code, error.message);
  }
  if (
    error instanceof PolicyStoreBusyError ||
    error instanceof PolicyStoreUnavailableError
  ) {
    return jsonError(503, error.code, error.message);
  }
  if (
    error instanceof PolicyStoreConfigurationError ||
    error instanceof PolicyRuntimeConfigurationError
  ) {
    return jsonError(503, error.code, error.message);
  }
  if (
    error instanceof PolicyStoreCorruptError ||
    error instanceof PolicyStoreCapacityError
  ) {
    return jsonError(500, error.code, error.message);
  }
  if (error instanceof ReattributionError) {
    const status =
      error.code === "policy_version_conflict"
        ? 409
        : error.code === "reattribution_preview_expired"
          ? 410
          : error.code === "policy_unavailable"
            ? 409
            : 422;
    return jsonError(status, error.code, error.message);
  }
  if (error instanceof ReattributionIntegrationError) {
    return jsonError(503, error.code, error.message);
  }
  return jsonError(500, "policy_operation_failed", "Policy operation failed");
}

export async function readPolicyJson(request: NextRequest): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new PolicyRequestError(
      "unsupported_media_type",
      415,
      "Policy operations require application/json"
    );
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const parsed = Number(contentLength);
    if (!Number.isSafeInteger(parsed) || parsed < 0) {
      throw new PolicyRequestError(
        "invalid_request",
        400,
        "Content-Length is invalid"
      );
    }
    if (parsed > MAX_POLICY_BODY_BYTES) {
      throw new PolicyRequestError(
        "payload_too_large",
        413,
        "Request payload is too large"
      );
    }
  }
  const reader = request.body?.getReader();
  if (!reader) {
    throw new PolicyRequestError("invalid_request", 400, "Request body is required");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_POLICY_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new PolicyRequestError(
        "payload_too_large",
        413,
        "Request payload is too large"
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
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    throw new PolicyRequestError("invalid_json", 400, "Request body is invalid JSON");
  }
}

export function validatePolicyMutationOrigin(request: NextRequest): void {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const forwardedProtocol = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  const host = forwardedHost || request.headers.get("host");
  const protocol = forwardedProtocol || request.nextUrl.protocol.replace(":", "");
  const expectedOrigin = host ? `${protocol}://${host}` : request.nextUrl.origin;
  if (!origin || origin !== expectedOrigin || (fetchSite && fetchSite !== "same-origin")) {
    throw new PolicyRequestError(
      "cross_site_request_rejected",
      403,
      "Cross-site request rejected"
    );
  }
}

export class PolicyRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "PolicyRequestError";
  }
}

export function handlePolicyRouteError(error: unknown) {
  if (error instanceof PolicyRequestError) {
    return jsonError(error.status, error.code, error.message);
  }
  return policyError(error);
}

export function strictObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PolicyRequestError(
      "invalid_request",
      400,
      "Request body must be an object"
    );
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    keys.some((key) => !(key in record))
  ) {
    throw new PolicyRequestError(
      "invalid_request",
      400,
      "Request body has missing or unexpected fields"
    );
  }
  return record;
}

function jsonError(status: number, code: string, message: string) {
  return policyJson({ error: { code, message } }, status);
}
