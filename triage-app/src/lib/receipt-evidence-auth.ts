import { timingSafeEqual } from "node:crypto";

export const INTERNAL_RECEIPT_EVIDENCE_HOST = "tyrion-operations-ui:3000";

export class ReceiptEvidenceHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ReceiptEvidenceHttpError";
  }
}

export function authenticateReceiptEvidenceRequest(
  request: Pick<Request, "headers">,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const host = request.headers.get("host")?.trim().toLowerCase();
  const forwardedHosts = request.headers
    .get("x-forwarded-host")
    ?.split(",")
    .map((value) => value.trim().toLowerCase());
  if (
    host !== INTERNAL_RECEIPT_EVIDENCE_HOST ||
    forwardedHosts?.some((value) => value !== INTERNAL_RECEIPT_EVIDENCE_HOST)
  ) {
    throw new ReceiptEvidenceHttpError(
      404,
      "receipt_evidence_route_not_available",
      "Receipt evidence route is not available on this host"
    );
  }
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    throw new ReceiptEvidenceHttpError(
      403,
      "receipt_evidence_forbidden",
      "Browser requests are not accepted"
    );
  }
  const token = environment.BRIDGE_API_TOKEN;
  if (!token || token.length < 32) {
    throw new ReceiptEvidenceHttpError(
      503,
      "receipt_evidence_auth_not_configured",
      "Receipt evidence authentication is not configured"
    );
  }
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    throw new ReceiptEvidenceHttpError(
      401,
      "receipt_evidence_auth_required",
      "A bearer credential is required"
    );
  }
  const prefix = "Bearer ";
  if (
    !authorization.startsWith(prefix) ||
    !safeEqual(authorization.slice(prefix.length), token)
  ) {
    throw new ReceiptEvidenceHttpError(
      401,
      "receipt_evidence_auth_invalid",
      "Service credential is invalid"
    );
  }
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
