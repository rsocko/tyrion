import { createHmac, timingSafeEqual } from "node:crypto";
import {
  parsePolicyActorV1,
  type PolicyActorV1,
  type PolicyPermissionV1,
} from "@rsocko/tyrion-kid-engine/contracts/v1";

const ASSERTION_MAX_AGE_SECONDS = 60;
const HEADER_ACTOR = "x-tyrion-actor";
const HEADER_HOUSEHOLD = "x-tyrion-household";
const HEADER_PERMISSIONS = "x-tyrion-permissions";
const HEADER_TIMESTAMP = "x-tyrion-auth-timestamp";
const HEADER_SIGNATURE = "x-tyrion-auth-signature";

export class PolicyAuthError extends Error {
  constructor(
    readonly code:
      | "policy_auth_not_configured"
      | "policy_auth_required"
      | "policy_auth_invalid",
    readonly status: 401 | 503,
    message: string
  ) {
    super(message);
    this.name = "PolicyAuthError";
  }
}

export function resolvePolicyActor(
  request: Pick<Request, "headers" | "method" | "url">,
  environment: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): PolicyActorV1 {
  if (environment.TYRION_POLICY_DEMO_MODE === "true") {
    if (environment.NODE_ENV === "production") {
      throw new PolicyAuthError(
        "policy_auth_not_configured",
        503,
        "Policy authentication is not configured"
      );
    }
    return {
      actorId: "demo-operator",
      householdId: "demo-household",
      permissions: [
        "policy:read",
        "policy:write",
        "reattribution:preview",
        "reattribution:apply",
      ],
    };
  }

  const secret = environment.TYRION_POLICY_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new PolicyAuthError(
      "policy_auth_not_configured",
      503,
      "Policy authentication is not configured"
    );
  }

  const actorId = request.headers.get(HEADER_ACTOR);
  const householdId = request.headers.get(HEADER_HOUSEHOLD);
  const permissionsValue = request.headers.get(HEADER_PERMISSIONS);
  const timestamp = request.headers.get(HEADER_TIMESTAMP);
  const signature = request.headers.get(HEADER_SIGNATURE);
  if (!actorId || !householdId || !permissionsValue || !timestamp || !signature) {
    throw new PolicyAuthError(
      "policy_auth_required",
      401,
      "A trusted policy authentication assertion is required"
    );
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > ASSERTION_MAX_AGE_SECONDS
  ) {
    throw invalidAssertion();
  }

  const permissions = permissionsValue
    .split(",")
    .map((permission) => permission.trim())
    .filter(Boolean);
  let actor: PolicyActorV1;
  try {
    actor = parsePolicyActorV1({ actorId, householdId, permissions });
  } catch {
    throw invalidAssertion();
  }

  const pathname = new URL(request.url).pathname;
  const expected = signAssertion(secret, {
    method: request.method,
    pathname,
    actorId: actor.actorId,
    householdId: actor.householdId,
    permissions: actor.permissions,
    timestamp,
  });
  if (!safeEqual(signature, expected)) {
    throw invalidAssertion();
  }
  return actor;
}

export function createPolicyAssertionHeaders(
  secret: string,
  actor: PolicyActorV1,
  method: string,
  pathname: string,
  now: Date = new Date()
): Headers {
  const parsed = parsePolicyActorV1(actor);
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const permissions = parsed.permissions.join(",");
  const signature = signAssertion(secret, {
    method,
    pathname,
    actorId: parsed.actorId,
    householdId: parsed.householdId,
    permissions: parsed.permissions,
    timestamp,
  });
  return new Headers({
    [HEADER_ACTOR]: parsed.actorId,
    [HEADER_HOUSEHOLD]: parsed.householdId,
    [HEADER_PERMISSIONS]: permissions,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_SIGNATURE]: signature,
  });
}

function signAssertion(
  secret: string,
  value: {
    method: string;
    pathname: string;
    actorId: string;
    householdId: string;
    permissions: PolicyPermissionV1[];
    timestamp: string;
  }
): string {
  return createHmac("sha256", secret)
    .update(
      [
        value.method.toUpperCase(),
        value.pathname,
        value.actorId,
        value.householdId,
        value.permissions.join(","),
        value.timestamp,
      ].join("\n")
    )
    .digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left)) return false;
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function invalidAssertion(): PolicyAuthError {
  return new PolicyAuthError(
    "policy_auth_invalid",
    401,
    "Policy authentication assertion is invalid or expired"
  );
}
