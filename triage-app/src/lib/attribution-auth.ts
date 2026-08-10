import { timingSafeEqual } from "node:crypto";
import type { PolicyActorV1 } from "@rsocko/tyrion-kid-engine/contracts/v1";
import { resolveMissionControlAttributionActor } from "@/lib/homelab-identity";

export const INTERNAL_ATTRIBUTION_HOST = "tyrion-operations-ui:3000";

export class AttributionAuthError extends Error {
  constructor(
    readonly code:
      | "attribution_auth_not_configured"
      | "attribution_auth_required"
      | "attribution_auth_invalid"
      | "attribution_route_not_available",
    readonly status: 401 | 404 | 503,
    message: string
  ) {
    super(message);
    this.name = "AttributionAuthError";
  }
}

export function resolveAttributionServiceActor(
  request: Pick<Request, "headers">,
  environment: NodeJS.ProcessEnv = process.env
): PolicyActorV1 {
  const requestHost = request.headers.get("host")?.toLowerCase();
  if (
    requestHost !== INTERNAL_ATTRIBUTION_HOST ||
    request.headers.has("x-forwarded-host")
  ) {
    throw new AttributionAuthError(
      "attribution_route_not_available",
      404,
      "Attribution route is not available on this host"
    );
  }

  const token = environment.BRIDGE_API_TOKEN;
  if (!token || token.length < 32) {
    throw new AttributionAuthError(
      "attribution_auth_not_configured",
      503,
      "Attribution service authentication is not configured"
    );
  }
  const authorization = request.headers.get("authorization");
  if (!authorization) {
    throw new AttributionAuthError(
      "attribution_auth_required",
      401,
      "A bearer credential is required"
    );
  }
  const prefix = "Bearer ";
  if (
    !authorization.startsWith(prefix) ||
    !safeEqual(authorization.slice(prefix.length), token)
  ) {
    throw new AttributionAuthError(
      "attribution_auth_invalid",
      401,
      "Service credential is invalid"
    );
  }
  return resolveMissionControlAttributionActor();
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  return (
    leftBuffer.byteLength === rightBuffer.byteLength &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}
