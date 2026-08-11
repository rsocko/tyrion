import { timingSafeEqual } from "node:crypto";
import { createInsightErrorV1, type InsightErrorCodeV1 } from "@rsocko/tyrion-finance-insights";

export const INTERNAL_FINANCE_INSIGHT_HOST = "tyrion-operations-ui:3000";

export class FinanceInsightHttpError extends Error {
  constructor(readonly code: InsightErrorCodeV1) {
    super(code);
    this.name = "FinanceInsightHttpError";
  }
}

export function authenticateFinanceInsightRequest(
  request: Pick<Request, "headers">,
  environment: NodeJS.ProcessEnv = process.env
): void {
  const host = request.headers.get("host")?.trim().toLowerCase();
  const forwardedHosts = request.headers
    .get("x-forwarded-host")
    ?.split(",")
    .map((value) => value.trim().toLowerCase());
  if (
    host !== INTERNAL_FINANCE_INSIGHT_HOST ||
    forwardedHosts?.some((value) => value !== INTERNAL_FINANCE_INSIGHT_HOST)
  ) {
    throw new FinanceInsightHttpError("insight_route_not_available");
  }
  if (
    request.headers.has("origin") ||
    request.headers.has("sec-fetch-site")
  ) {
    throw new FinanceInsightHttpError("insight_forbidden");
  }

  const token = environment.BRIDGE_API_TOKEN;
  if (!token || token.length < 32) {
    throw new FinanceInsightHttpError("insight_service_not_configured");
  }
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    throw new FinanceInsightHttpError("insight_auth_required");
  }
  const prefix = "Bearer ";
  if (
    !authorization.startsWith(prefix) ||
    !safeEqual(authorization.slice(prefix.length), token)
  ) {
    throw new FinanceInsightHttpError("insight_auth_invalid");
  }
}

export function financeInsightErrorStatus(error: FinanceInsightHttpError): number {
  return createInsightErrorV1(error.code).status;
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
