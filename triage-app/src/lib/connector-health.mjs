export const CONNECTOR_HEALTH_RESPONSE_BYTES = 4 * 1_024;
export const CONNECTOR_HEALTH_TIMEOUT_MS = 30_000;
export const MONARCH_CONTRACT_VERSION = "1.0";

const authStates = new Set([
  "unauthenticated",
  "connected",
  "expired",
  "degraded",
]);
const modes = new Set(["demo", "live"]);
const healthStatuses = new Set(["ok", "degraded"]);

export async function composeConnectorHealth({
  baseUrl,
  token,
  fetchImpl = fetch,
  timeoutMs = CONNECTOR_HEALTH_TIMEOUT_MS,
}) {
  const [health, authStatus] = await Promise.all([
    fetchBridgeComponent({
      baseUrl,
      token,
      path: "/health",
      fetchImpl,
      timeoutMs,
      parse: parseHealthResponse,
    }),
    fetchBridgeComponent({
      baseUrl,
      token,
      path: "/auth/status",
      fetchImpl,
      timeoutMs,
      parse: parseAuthStatusResponse,
    }),
  ]);

  const failure = health.ok ? (authStatus.ok ? null : authStatus) : health;
  if (failure) return failure;

  return {
    ok: true,
    body: {
      contractVersion: MONARCH_CONTRACT_VERSION,
      status: health.value.status,
      mode: authStatus.value.mode,
      reachable: health.value.reachable,
      authenticated: authStatus.value.authenticated,
      authState: authStatus.value.authState,
    },
  };
}

async function fetchBridgeComponent({
  baseUrl,
  token,
  path,
  fetchImpl,
  timeoutMs,
  parse,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method: "GET",
      headers: new Headers({
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      }),
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return failure(
        502,
        "bridge_health_check_failed",
        "Bridge health check failed"
      );
    }

    const headerVersion = response.headers.get("x-monarch-contract-version");
    if (headerVersion !== MONARCH_CONTRACT_VERSION) {
      await response.body?.cancel().catch(() => undefined);
      return failure(
        502,
        "bridge_contract_mismatch",
        "Bridge contract version is incompatible"
      );
    }

    const contentType = response.headers.get("content-type")?.toLowerCase() || "";
    if (!contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      return invalidResponse();
    }

    const bytes = await readBoundedResponse(response);
    if (!bytes) return invalidResponse();

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return invalidResponse();
    }
    if (payload?.contractVersion !== MONARCH_CONTRACT_VERSION) {
      return failure(
        502,
        "bridge_contract_mismatch",
        "Bridge contract version is incompatible"
      );
    }

    const value = parse(payload);
    return value ? { ok: true, value } : invalidResponse();
  } catch {
    return controller.signal.aborted
      ? failure(504, "bridge_timeout", "Bridge health check timed out")
      : failure(502, "bridge_unavailable", "Bridge unavailable");
  } finally {
    clearTimeout(timeout);
  }
}

async function readBoundedResponse(response) {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const parsedLength = Number(contentLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > CONNECTOR_HEALTH_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      return null;
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CONNECTOR_HEALTH_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseHealthResponse(value) {
  if (
    !isRecord(value) ||
    !healthStatuses.has(value.status) ||
    !modes.has(value.mode) ||
    typeof value.reachable !== "boolean" ||
    typeof value.authenticated !== "boolean" ||
    !authStates.has(value.authState) ||
    value.authenticated !== (value.authState === "connected")
  ) {
    return null;
  }
  return {
    status: value.status,
    mode: value.mode,
    reachable: value.reachable,
    authenticated: value.authenticated,
    authState: value.authState,
  };
}

function parseAuthStatusResponse(value) {
  if (
    !isRecord(value) ||
    typeof value.authenticated !== "boolean" ||
    !authStates.has(value.authState) ||
    value.authenticated !== (value.authState === "connected") ||
    !modes.has(value.mode) ||
    !("email" in value) ||
    (value.email !== null && typeof value.email !== "string")
  ) {
    return null;
  }
  return {
    authenticated: value.authenticated,
    authState: value.authState,
    mode: value.mode,
  };
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidResponse() {
  return failure(
    502,
    "invalid_bridge_response",
    "Bridge returned an invalid response"
  );
}

function failure(status, code, message) {
  return { ok: false, status, error: { code, message } };
}
