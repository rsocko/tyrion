import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { PolicyActorV1 } from "@rsocko/tyrion-kid-engine/contracts/v1";
import {
  AttributionReplayStoreError,
  FileAttributionReplayStore,
} from "@/lib/attribution-replay-store.mjs";

const ASSERTION_MAX_AGE_SECONDS = 60;
const REPLAY_RETENTION_SECONDS = 120;
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_REQUESTS = 60;
const HEADER_CLIENT = "x-tyrion-service-client";
const HEADER_TIMESTAMP = "x-tyrion-service-timestamp";
const HEADER_NONCE = "x-tyrion-service-nonce";
const HEADER_CONTENT_HASH = "x-tyrion-content-sha256";
const HEADER_SIGNATURE = "x-tyrion-service-signature";

interface AttributionClientConfiguration {
  clientId: string;
  actorId: string;
  householdId: string;
  secret: string;
  internalHost: string;
  replayStorePath: string;
}

export class AttributionAuthError extends Error {
  constructor(
    readonly code:
      | "attribution_auth_not_configured"
      | "attribution_auth_required"
      | "attribution_auth_invalid"
      | "attribution_replay_detected"
      | "attribution_rate_limited"
      | "attribution_route_not_available"
      | "attribution_service_unavailable",
    readonly status: 401 | 404 | 409 | 429 | 503,
    message: string
  ) {
    super(message);
    this.name = "AttributionAuthError";
  }
}

export async function resolveAttributionServiceActor(
  request: Pick<Request, "headers" | "method" | "url">,
  body: Uint8Array,
  environment: NodeJS.ProcessEnv = process.env,
  now: Date = new Date()
): Promise<PolicyActorV1> {
  const configuration = resolveConfiguration(environment);
  const requestHost = request.headers.get("host")?.toLowerCase();
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  if (
    requestHost !== configuration.internalHost.toLowerCase() ||
    (forwardedHost !== undefined &&
      forwardedHost !== configuration.internalHost.toLowerCase())
  ) {
    throw new AttributionAuthError(
      "attribution_route_not_available",
      404,
      "Attribution route is not available on this host"
    );
  }

  const clientId = request.headers.get(HEADER_CLIENT);
  const timestamp = request.headers.get(HEADER_TIMESTAMP);
  const nonce = request.headers.get(HEADER_NONCE);
  const contentHash = request.headers.get(HEADER_CONTENT_HASH);
  const signature = request.headers.get(HEADER_SIGNATURE);
  if (!clientId || !timestamp || !nonce || !contentHash || !signature) {
    throw new AttributionAuthError(
      "attribution_auth_required",
      401,
      "A trusted attribution service assertion is required"
    );
  }
  if (
    clientId !== configuration.clientId ||
    !identifier(clientId) ||
    !/^[A-Za-z0-9_-]{22,128}$/.test(nonce)
  ) {
    throw invalidAssertion();
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > ASSERTION_MAX_AGE_SECONDS
  ) {
    throw invalidAssertion();
  }

  const actualContentHash = createHash("sha256").update(body).digest("hex");
  if (!safeHexEqual(contentHash, actualContentHash)) {
    throw invalidAssertion();
  }
  const pathname = new URL(request.url).pathname;
  const expected = signAssertion(configuration.secret, {
    method: request.method,
    pathname,
    host: configuration.internalHost,
    clientId,
    timestamp,
    nonce,
    contentHash,
  });
  if (!safeHexEqual(signature, expected)) {
    throw invalidAssertion();
  }

  enforceRateLimit(clientId, nowSeconds);
  const replayStore = replayStoreFor(configuration.replayStorePath);
  let accepted: boolean;
  try {
    accepted = await replayStore.consume(
      clientId,
      timestamp,
      nonce,
      nowSeconds + REPLAY_RETENTION_SECONDS,
      nowSeconds
    );
  } catch (error) {
    if (error instanceof AttributionReplayStoreError) throw unavailable();
    throw error;
  }
  if (!accepted) {
    throw new AttributionAuthError(
      "attribution_replay_detected",
      409,
      "Attribution service assertion was already used"
    );
  }
  return {
    actorId: configuration.actorId,
    householdId: configuration.householdId,
    permissions: ["attribution:batch"],
  };
}

export function createAttributionAssertionHeaders(
  secret: string,
  clientId: string,
  method: string,
  pathname: string,
  host: string,
  body: Uint8Array,
  now: Date = new Date(),
  nonce = randomBytes(24).toString("base64url")
): Headers {
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const contentHash = createHash("sha256").update(body).digest("hex");
  const signature = signAssertion(secret, {
    method,
    pathname,
    host,
    clientId,
    timestamp,
    nonce,
    contentHash,
  });
  return new Headers({
    "Content-Type": "application/json",
    [HEADER_CLIENT]: clientId,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_NONCE]: nonce,
    [HEADER_CONTENT_HASH]: contentHash,
    [HEADER_SIGNATURE]: signature,
  });
}

function resolveConfiguration(
  environment: NodeJS.ProcessEnv
): AttributionClientConfiguration {
  const clientId = environment.TYRION_ATTRIBUTION_CLIENT_ID;
  const actorId = environment.TYRION_ATTRIBUTION_ACTOR_ID;
  const householdId = environment.TYRION_ATTRIBUTION_HOUSEHOLD_ID;
  const secret = environment.TYRION_ATTRIBUTION_AUTH_SECRET;
  const internalHost = environment.TYRION_ATTRIBUTION_INTERNAL_HOST;
  const replayStorePath = environment.TYRION_ATTRIBUTION_REPLAY_STORE_PATH;
  if (
    !clientId ||
    !identifier(clientId) ||
    !actorId ||
    !identifier(actorId) ||
    !householdId ||
    !identifier(householdId) ||
    !secret ||
    secret.length < 32 ||
    !internalHost ||
    !validHost(internalHost) ||
    !replayStorePath ||
    !externalAbsolutePath(replayStorePath)
  ) {
    throw new AttributionAuthError(
      "attribution_auth_not_configured",
      503,
      "Attribution service authentication is not configured"
    );
  }
  return {
    clientId,
    actorId,
    householdId,
    secret,
    internalHost,
    replayStorePath: resolve(replayStorePath),
  };
}

function signAssertion(
  secret: string,
  value: {
    method: string;
    pathname: string;
    host: string;
    clientId: string;
    timestamp: string;
    nonce: string;
    contentHash: string;
  }
): string {
  return createHmac("sha256", secret)
    .update(
      [
        value.method.toUpperCase(),
        value.pathname,
        value.host.toLowerCase(),
        value.clientId,
        value.timestamp,
        value.nonce,
        value.contentHash,
      ].join("\n")
    )
    .digest("hex");
}

function safeHexEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
    return false;
  }
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function identifier(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) &&
    !["__proto__", "constructor", "prototype"].includes(value)
  );
}

function validHost(value: string): boolean {
  return (
    value === value.trim() &&
    value.length <= 253 &&
    /^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(value) &&
    !value.toLowerCase().includes("tyrion.socko.us")
  );
}

function externalAbsolutePath(value: string): boolean {
  if (!isAbsolute(value)) return false;
  const path = resolve(value);
  const relation = relative(resolve(process.cwd()), path);
  return relation.startsWith("..") && !isAbsolute(relation);
}

function invalidAssertion(): AttributionAuthError {
  return new AttributionAuthError(
    "attribution_auth_invalid",
    401,
    "Attribution service assertion is invalid or expired"
  );
}

const replayStores = new Map<string, FileAttributionReplayStore>();
const rateWindows = new Map<string, { startedAt: number; count: number }>();

function replayStoreFor(path: string): FileAttributionReplayStore {
  let store = replayStores.get(path);
  if (!store) {
    store = new FileAttributionReplayStore(path);
    replayStores.set(path, store);
  }
  return store;
}

function enforceRateLimit(clientId: string, now: number): void {
  const current = rateWindows.get(clientId);
  if (!current || now - current.startedAt >= RATE_LIMIT_WINDOW_SECONDS) {
    rateWindows.set(clientId, { startedAt: now, count: 1 });
    return;
  }
  current.count += 1;
  if (current.count > RATE_LIMIT_REQUESTS) {
    throw new AttributionAuthError(
      "attribution_rate_limited",
      429,
      "Attribution request rate limit exceeded"
    );
  }
}

function unavailable(): AttributionAuthError {
  return new AttributionAuthError(
    "attribution_service_unavailable",
    503,
    "Attribution service is unavailable"
  );
}
