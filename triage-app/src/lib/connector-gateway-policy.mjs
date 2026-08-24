import { createHash, timingSafeEqual } from "node:crypto";

export const CONNECTOR_GATEWAY_BASE = "/api/connector/v1";
export const MAX_CONNECTOR_REQUEST_BODY_BYTES = 1_024;
export const MAX_CONNECTOR_RESPONSE_BYTES = 8 * 1_024 * 1_024;

const noQueryRoutes = new Map([
  ["contract", "GET"],
  ["health", "GET"],
  ["accounts", "GET"],
  ["category-groups", "GET"],
  ["categories", "GET"],
  ["tags", "GET"],
  ["recurring", "GET"],
  ["budgets", "GET"],
]);
const transactionQueryParameters = new Set([
  "start_date",
  "end_date",
  "account_id",
  "category_id",
  "merchant_query",
  "tag_id",
  "min_amount",
  "max_amount",
  "is_pending",
  "is_recurring",
  "limit",
  "cursor",
]);
const transactionSingletonParameters = new Set(
  [...transactionQueryParameters].filter((name) => name !== "tag_id")
);
const moneyPattern = /^-?(?:0|[1-9][0-9]{0,8})(?:\.[0-9]{1,2})?$/;
const integerPattern = /^(?:0|[1-9][0-9]*)$/;
const datePattern = /^(\d{4})-(\d{2})-(\d{2})$/;
const cursorPattern = /^[A-Za-z0-9_+/=-]+$/;

const reject = (status, code, message) => ({
  allowed: false,
  status,
  error: { code, message },
});

export function authenticateConnectorRequest(authorization, configuredToken) {
  if (!configuredToken || configuredToken.length < 32) {
    return reject(
      503,
      "connector_auth_not_configured",
      "Connector gateway authentication is not configured"
    );
  }
  if (!authorization) {
    return reject(
      401,
      "connector_auth_required",
      "A bearer credential is required"
    );
  }
  const prefix = "Bearer ";
  if (!authorization.startsWith(prefix)) {
    return reject(
      401,
      "connector_auth_invalid",
      "Service credential is invalid"
    );
  }
  const candidate = authorization.slice(prefix.length);
  if (!candidate || /\s/.test(candidate) || !safeEqual(candidate, configuredToken)) {
    return reject(
      401,
      "connector_auth_invalid",
      "Service credential is invalid"
    );
  }
  return { allowed: true, token: configuredToken };
}

export function isBrowserConnectorRequest(headers) {
  return headers.has("origin") || headers.has("sec-fetch-site");
}

export function evaluateConnectorRequest(method, segments, searchParams) {
  const path = Array.isArray(segments) ? segments.join("/") : "";
  const fixedMethod = noQueryRoutes.get(path);
  if (fixedMethod) {
    if (method !== fixedMethod) return methodNotAllowed();
    if ([...searchParams.keys()].length > 0) return queryNotAccepted();
    return allowed(`/${path}`, false);
  }

  if (
    Array.isArray(segments) &&
    (segments.length === 1 || segments.length === 2) &&
    segments[0] === "document-expectation-signals"
  ) {
    if (method !== "GET") return methodNotAllowed();
    if (segments.length === 1) {
      if ([...searchParams.keys()].length > 0) return queryNotAccepted();
    } else if (
      [...searchParams.keys()].some((key) => key !== "connectorRef") ||
      searchParams.getAll("connectorRef").length !== 1
    ) {
      return reject(
        422,
        "invalid_query",
        "Replay requires exactly one connectorRef parameter"
      );
    }
    return financeInsightAllowed();
  }

  if (path === "sync") {
    if (method !== "POST") return methodNotAllowed();
    const keys = [...searchParams.keys()];
    if (
      keys.some((key) => key !== "days") ||
      searchParams.getAll("days").length > 1
    ) {
      return reject(422, "invalid_query", "Only one days parameter is accepted");
    }
    const rawDays = searchParams.get("days") ?? "90";
    if (!integerPattern.test(rawDays)) {
      return invalidSyncDays();
    }
    const days = Number(rawDays);
    if (days < 1 || days > 365) return invalidSyncDays();
    return allowed(`/sync?days=${days}`, false);
  }

  if (path === "transactions") {
    if (method !== "GET") return methodNotAllowed();
    return evaluateTransactionQuery(searchParams);
  }

  const transactionRoute = matchTransactionRoute(segments);
  if (transactionRoute) {
    const { transactionId, operation } = transactionRoute;
    if (operation === "category") {
      if (method !== "PATCH") return methodNotAllowed();
    } else if (method !== "GET") {
      return methodNotAllowed();
    }
    if ([...searchParams.keys()].length > 0) return queryNotAccepted();
    const suffix =
      operation === "detail" ? "" : operation === "splits" ? "/splits" : "/category";
    return allowed(
      `/transactions/${encodeURIComponent(transactionId)}${suffix}`,
      operation === "category"
    );
  }

  return reject(
    404,
    "connector_route_not_available",
    "This operation is not available through the connector gateway"
  );
}

export function parseCategoryMutation(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return reject(400, "invalid_request", "Category update body is invalid");
  }
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "categoryId") {
    return reject(400, "invalid_request", "Category update body is invalid");
  }
  const categoryId = normalizeId(value.categoryId);
  if (!categoryId) {
    return reject(400, "invalid_request", "categoryId is invalid");
  }
  return {
    allowed: true,
    body: JSON.stringify({ categoryId }),
  };
}

export function resolveConnectorBridgeUrl(rawUrl) {
  let baseUrl;
  try {
    baseUrl = new URL(rawUrl || "");
  } catch {
    return { configured: false };
  }
  if (
    !["http:", "https:"].includes(baseUrl.protocol) ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash ||
    (baseUrl.pathname !== "/" && baseUrl.pathname !== "")
  ) {
    return { configured: false };
  }
  return { configured: true, baseUrl };
}

function evaluateTransactionQuery(searchParams) {
  const pairs = [...searchParams.entries()];
  if (pairs.length > 32) {
    return reject(422, "invalid_query", "Too many query parameters");
  }
  const unknown = [...new Set(pairs.map(([name]) => name))].filter(
    (name) => !transactionQueryParameters.has(name)
  );
  if (unknown.length > 0) {
    return reject(422, "invalid_query", "Query parameter is not accepted");
  }
  for (const name of transactionSingletonParameters) {
    if (searchParams.getAll(name).length > 1) {
      return reject(422, "invalid_query", `${name} may be provided only once`);
    }
  }

  const output = new URLSearchParams();
  const startDate = optionalDate(searchParams.get("start_date"));
  const endDate = optionalDate(searchParams.get("end_date"));
  if (startDate === false || endDate === false) return invalidQuery();
  if (startDate && endDate) {
    const inclusiveDays = Math.floor((endDate.time - startDate.time) / 86_400_000) + 1;
    if (inclusiveDays < 1 || inclusiveDays > 366) {
      return reject(422, "invalid_query", "Transaction date range is invalid");
    }
  }
  appendIfPresent(output, "start_date", startDate?.text);
  appendIfPresent(output, "end_date", endDate?.text);

  for (const name of ["account_id", "category_id"]) {
    const raw = searchParams.get(name);
    if (raw !== null) {
      const normalized = normalizeId(raw);
      if (!normalized) return invalidQuery();
      output.set(name, normalized);
    }
  }

  const rawMerchant = searchParams.get("merchant_query");
  if (rawMerchant !== null) {
    const merchant = rawMerchant.trim().replace(/\s+/g, " ");
    if (!merchant || merchant.length > 120 || hasControlCharacter(merchant)) {
      return invalidQuery();
    }
    output.set("merchant_query", merchant);
  }

  const rawTags = searchParams.getAll("tag_id");
  if (rawTags.length > 20) return invalidQuery();
  const tags = [];
  for (const rawTag of rawTags) {
    const tag = normalizeId(rawTag);
    if (!tag) return invalidQuery();
    if (!tags.includes(tag)) tags.push(tag);
  }
  for (const tag of tags) output.append("tag_id", tag);

  const minAmount = optionalMoney(searchParams.get("min_amount"));
  const maxAmount = optionalMoney(searchParams.get("max_amount"));
  if (minAmount === false || maxAmount === false) return invalidQuery();
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    return invalidQuery();
  }
  appendIfPresent(output, "min_amount", searchParams.get("min_amount"));
  appendIfPresent(output, "max_amount", searchParams.get("max_amount"));

  for (const name of ["is_pending", "is_recurring"]) {
    const value = searchParams.get(name);
    if (value !== null) {
      if (value !== "true" && value !== "false") return invalidQuery();
      output.set(name, value);
    }
  }

  const rawLimit = searchParams.get("limit");
  if (rawLimit !== null) {
    if (!integerPattern.test(rawLimit)) return invalidQuery();
    const limit = Number(rawLimit);
    if (limit < 1 || limit > 500) return invalidQuery();
    output.set("limit", String(limit));
  }

  const cursor = searchParams.get("cursor");
  if (cursor !== null) {
    if (
      cursor.length < 1 ||
      cursor.length > 128 ||
      !cursorPattern.test(cursor) ||
      hasControlCharacter(cursor)
    ) {
      return invalidQuery();
    }
    output.set("cursor", cursor);
  }

  const query = output.toString();
  return allowed(`/transactions${query ? `?${query}` : ""}`, false);
}

function matchTransactionRoute(segments) {
  if (!Array.isArray(segments) || segments[0] !== "transactions") return null;
  if (segments.length < 2 || segments.length > 3) return null;
  const transactionId = normalizeId(segments[1]);
  if (!transactionId || transactionId !== segments[1]) return null;
  if (segments.length === 2) {
    return { transactionId, operation: "detail" };
  }
  if (segments[2] === "splits" || segments[2] === "category") {
    return { transactionId, operation: segments[2] };
  }
  return null;
}

function normalizeId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 512 ||
    hasControlCharacter(normalized)
  ) {
    return null;
  }
  return normalized;
}

function optionalDate(value) {
  if (value === null) return null;
  const match = datePattern.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1) return false;
  const parsed = new Date(0);
  parsed.setUTCHours(0, 0, 0, 0);
  parsed.setUTCFullYear(year, month - 1, day);
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return false;
  }
  return { text: value, time: parsed.getTime() };
}

function optionalMoney(value) {
  if (value === null) return null;
  if (!moneyPattern.test(value)) return false;
  const amount = Number(value);
  if (!Number.isFinite(amount) || Math.abs(amount) > 999_999_999.99) return false;
  return amount;
}

function safeEqual(left, right) {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function hasControlCharacter(value) {
  return /[\u0000-\u001f\u007f]/.test(value);
}

function appendIfPresent(searchParams, name, value) {
  if (value !== null && value !== undefined) searchParams.set(name, value);
}

function allowed(upstreamPath, acceptsBody) {
  return { allowed: true, target: "bridge", upstreamPath, acceptsBody };
}

function financeInsightAllowed() {
  return { allowed: true, target: "finance-insight", acceptsBody: false };
}

function methodNotAllowed() {
  return reject(405, "method_not_allowed", "Method not allowed for this operation");
}

function queryNotAccepted() {
  return reject(422, "invalid_query", "Query parameters are not accepted for this operation");
}

function invalidQuery() {
  return reject(422, "invalid_query", "Transaction query is invalid");
}

function invalidSyncDays() {
  return reject(422, "invalid_query", "Sync days must be an integer from 1 through 365");
}
