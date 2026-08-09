import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import {
  evaluateBridgeRequest,
  resolveBridgeConfiguration,
} from "../src/lib/bridge-proxy-policy.mjs";
import { connectionPresentation } from "../src/lib/operational-state.mjs";
import { policyStatePresentation } from "../src/lib/policy-ui-state.mjs";
import { FileAttributionReplayStore } from "../src/lib/attribution-replay-store.mjs";

const appRoot = process.cwd();
const serviceToken = "synthetic-test-service-token-value";
const policyAuthSecret = "synthetic-policy-auth-secret-value-123456";
const fingerprintKey = "synthetic-fingerprint-key-value-12345678";
const reattributionToken = "synthetic-reattribution-token-value-1234";
const attributionAuthSecret = "synthetic-attribution-auth-secret-value-123456";
const attributionClientId = "mission-control-test";
const policyActor = {
  actorId: "actor-synthetic",
  householdId: "household-synthetic",
  permissions: [
    "policy:read",
    "policy:write",
    "reattribution:preview",
    "reattribution:apply",
  ],
};
let fakeBridge;
let fakeBridgeUrl;
let fakeReattribution;
let fakeReattributionUrl;
let uiProcess;
let uiUrl;
let temporaryStateDirectory;
let policyStorePath;
let receivedRequests = [];
let bridgeResponseMode = "normal";
let authState = "connected";
let previews = new Map();
let expireNextPreview = false;
let reattributionResponseMode = "normal";
let activePolicy;

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address()));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function freePort() {
  const server = net.createServer();
  const address = await listen(server);
  await close(server);
  return address.port;
}

async function waitForUi() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (uiProcess.exitCode !== null) {
      throw new Error("The production UI exited before becoming ready");
    }
    try {
      const response = await fetch(`${uiUrl}/api/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The production UI did not become ready");
}

before(async () => {
  const standaloneRoot = join(appRoot, ".next", "standalone", "triage-app");
  const standaloneServer = join(standaloneRoot, "server.js");
  assert.equal(existsSync(standaloneServer), true, "Run npm run build before npm test");

  fakeBridge = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedRequests.push({
        path: request.url,
        method: request.method,
        authorized: request.headers.authorization === `Bearer ${serviceToken}`,
        hasBody: chunks.length > 0,
      });

      if (bridgeResponseMode === "invalid") {
        response.writeHead(502, { "Content-Type": "text/plain" });
        response.end("synthetic upstream detail that must not escape");
        return;
      }

      const common = { contractVersion: "1.0", mode: "live" };
      const payload =
        request.url === "/health"
          ? {
              ...common,
              status: "ok",
              reachable: true,
              authenticated: authState === "connected",
              authState,
            }
          : request.url === "/auth/status"
            ? {
                ...common,
                authenticated: authState === "connected",
                authState,
                email: null,
              }
            : request.url === "/auth/logout"
              ? { contractVersion: "1.0", status: "logged_out", message: "Session cleared", email: null }
              : request.url === "/sync?days=30"
                ? { contractVersion: "1.0", status: "complete" }
                : { contractVersion: "1.0", status: "success", message: "Authenticated", email: null };

      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  const bridgeAddress = await listen(fakeBridge);
  fakeBridgeUrl = `http://127.0.0.1:${bridgeAddress.port}`;

  fakeReattribution = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (reattributionResponseMode === "unavailable") {
        response.writeHead(503, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "synthetic private detail" }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${reattributionToken}`) {
        response.writeHead(401, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      let payload;
      if (request.url === "/v1/reattribution/records:resolve") {
        payload = {
          records: body.sourceRefs.map((sourceRef) =>
            reattributionRecord(body.householdId, sourceRef)
          ),
        };
      } else if (request.url === "/v1/reattribution/previews") {
        const preview = structuredClone(body.preview);
        if (expireNextPreview) {
          preview.createdAt = "2019-01-01T00:00:00.000Z";
          preview.expiresAt = "2020-01-01T00:00:00.000Z";
          expireNextPreview = false;
        }
        previews.set(preview.previewId, preview);
        payload = { stored: true };
      } else if (request.url === "/v1/reattribution/previews:resolve") {
        payload = { preview: previews.get(body.previewId) ?? null };
      } else if (request.url === "/v1/reattribution/previews:apply") {
        payload = { counts: impactCounts(body.preview) };
      } else {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: "not_found" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });
  const reattributionAddress = await listen(fakeReattribution);
  fakeReattributionUrl = `http://127.0.0.1:${reattributionAddress.port}/`;
  temporaryStateDirectory = await mkdtemp(
    resolve(tmpdir(), "tyrion-ui-policy-test-")
  );
  policyStorePath = resolve(temporaryStateDirectory, "policies.json");

  const port = await freePort();
  uiUrl = `http://127.0.0.1:${port}`;
  uiProcess = spawn(process.execPath, [standaloneServer], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      BRIDGE_URL: fakeBridgeUrl,
      BRIDGE_API_TOKEN: serviceToken,
      TYRION_POLICY_AUTH_SECRET: policyAuthSecret,
      TYRION_POLICY_STORE_PATH: policyStorePath,
      TYRION_INSTRUMENT_FINGERPRINT_KEY: fingerprintKey,
      TYRION_REATTRIBUTION_URL: fakeReattributionUrl,
      TYRION_REATTRIBUTION_TOKEN: reattributionToken,
      TYRION_REATTRIBUTION_ALLOW_INSECURE_INTERNAL: "true",
      TYRION_ATTRIBUTION_CLIENT_ID: attributionClientId,
      TYRION_ATTRIBUTION_ACTOR_ID: "mission-control-service",
      TYRION_ATTRIBUTION_HOUSEHOLD_ID: policyActor.householdId,
      TYRION_ATTRIBUTION_AUTH_SECRET: attributionAuthSecret,
      TYRION_ATTRIBUTION_INTERNAL_HOST: `127.0.0.1:${port}`,
      TYRION_ATTRIBUTION_REPLAY_STORE_PATH: resolve(
        temporaryStateDirectory,
        "attribution-replay"
      ),
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: "ignore",
  });
  await waitForUi();
});

after(async () => {
  if (uiProcess && uiProcess.exitCode === null) {
    uiProcess.kill();
  }
  if (fakeBridge?.listening) {
    await close(fakeBridge);
  }
  if (fakeReattribution?.listening) {
    await close(fakeReattribution);
  }
  if (temporaryStateDirectory) {
    await rm(temporaryStateDirectory, { recursive: true, force: true });
  }
});

beforeEach(() => {
  receivedRequests = [];
  bridgeResponseMode = "normal";
  authState = "connected";
  expireNextPreview = false;
  reattributionResponseMode = "normal";
});

test("policy exposes only the operational bridge contract", () => {
  const allowed = [
    ["GET", ["health"]],
    ["GET", ["auth", "status"]],
    ["POST", ["auth", "login"]],
    ["POST", ["auth", "login-with-cookies"]],
    ["POST", ["auth", "logout"]],
    ["POST", ["sync"]],
  ];
  for (const [method, segments] of allowed) {
    assert.equal(
      evaluateBridgeRequest(method, segments, new URLSearchParams()).allowed,
      true
    );
  }

  for (const path of ["accounts", "transactions", "budgets", "recurring", "cashflow", "contract"]) {
    const result = evaluateBridgeRequest("GET", path.split("/"), new URLSearchParams());
    assert.equal(result.allowed, false);
    assert.equal(result.status, 404);
    assert.equal(result.error.code, "bridge_route_not_available");
  }
});

test("policy bounds sync and rejects method or query expansion", () => {
  assert.equal(
    evaluateBridgeRequest("POST", ["sync"], new URLSearchParams("days=90")).upstreamPath,
    "/sync?days=90"
  );
  for (const query of ["days=0", "days=91", "days=abc", "days=30&days=7", "cursor=x"]) {
    const result = evaluateBridgeRequest("POST", ["sync"], new URLSearchParams(query));
    assert.equal(result.allowed, false);
    assert.equal(result.status, 422);
  }
  const wrongMethod = evaluateBridgeRequest(
    "GET",
    ["auth", "login"],
    new URLSearchParams()
  );
  assert.equal(wrongMethod.allowed, false);
  assert.equal(wrongMethod.status, 405);
});

test("proxy configuration fails closed for missing tokens and unsafe URLs", () => {
  assert.equal(
    resolveBridgeConfiguration("http://bridge:8100", undefined, true).configured,
    false
  );
  assert.equal(
    resolveBridgeConfiguration("file:///tmp/session", serviceToken, true).configured,
    false
  );
  assert.equal(
    resolveBridgeConfiguration("http://user:pass@bridge:8100", serviceToken, true)
      .configured,
    false
  );
  assert.equal(
    resolveBridgeConfiguration("http://bridge:8100/private", serviceToken, true)
      .configured,
    false
  );
  const publicHealth = resolveBridgeConfiguration(
    "http://bridge:8100",
    undefined,
    false
  );
  assert.equal(publicHealth.configured, true);
  assert.equal(publicHealth.token, undefined);
});

test("all required authentication states have operator guidance", () => {
  const expected = {
    checking: "Checking",
    unavailable: "Unavailable",
    unauthenticated: "Not authenticated",
    connected: "Connected",
    expired: "Expired",
    degraded: "Degraded",
  };
  for (const [state, label] of Object.entries(expected)) {
    const presentation = connectionPresentation(state);
    assert.equal(presentation.label, label);
    assert.ok(presentation.description.length > 20);
  }
});

test("all policy workflow states have actionable presentation", () => {
  const states = [
    "loading",
    "unavailable",
    "unauthenticated",
    "empty",
    "ready",
    "saving",
    "previewing",
    "applying",
    "success",
    "conflict",
    "failure",
  ];
  for (const state of states) {
    const presentation = policyStatePresentation(state);
    assert.ok(presentation.label.length > 2);
    assert.ok(presentation.description.length > 20);
  }
});

test("production route tree contains no broad finance pages", async () => {
  const root = await fetch(`${uiUrl}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(root.headers.get("x-frame-options"), "DENY");
  const rootHtml = await root.text();
  assert.match(rootHtml, /Monarch connector/);
  assert.match(rootHtml, /Not affiliated with/);
  assert.doesNotMatch(rootHtml, /Finance Dashboard|Transactions|Budgets|Bills|Chat/);

  const configuration = await fetch(`${uiUrl}/configuration`);
  assert.equal(configuration.status, 200);
  const configurationHtml = await configuration.text();
  assert.match(configurationHtml, /Household policy|Loading policy configuration/);
  assert.match(configurationHtml, /independent and unofficial/);

  for (const path of ["/settings", "/triage", "/kids", "/bills", "/chat", "/transactions"]) {
    const response = await fetch(`${uiUrl}${path}`);
    assert.equal(response.status, 404);
  }
});

test("proxy injects service auth only for protected allowed operations", async () => {
  const health = await fetch(`${uiUrl}/api/bridge/health`);
  assert.equal(health.status, 200);
  assert.equal(receivedRequests.at(-1).authorized, false);

  const status = await fetch(`${uiUrl}/api/bridge/auth/status`);
  assert.equal(status.status, 200);
  assert.equal(receivedRequests.at(-1).authorized, true);
  assert.equal(receivedRequests.at(-1).path, "/auth/status");
});

test("proxy blocks broad routes before contacting the bridge", async () => {
  const beforeCount = receivedRequests.length;
  const response = await fetch(`${uiUrl}/api/bridge/transactions`);
  assert.equal(response.status, 404);
  assert.equal(receivedRequests.length, beforeCount);
  assert.equal(
    (await response.json()).error.code,
    "bridge_route_not_available"
  );
});

test("proxy enforces bounded sync before contacting the bridge", async () => {
  const response = await fetch(`${uiUrl}/api/bridge/sync?days=365`, {
    method: "POST",
    headers: { Origin: uiUrl },
  });
  assert.equal(response.status, 422);
  assert.equal(receivedRequests.length, 0);
  assert.equal((await response.json()).error.code, "invalid_query");
});

test("proxy bounds authentication payloads before contacting the bridge", async () => {
  const response = await fetch(`${uiUrl}/api/bridge/auth/login-with-cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: uiUrl },
    body: JSON.stringify({ sessionId: "x".repeat(20_000), csrfToken: "y" }),
  });
  assert.equal(response.status, 413);
  assert.equal(receivedRequests.length, 0);
  assert.equal((await response.json()).error.code, "payload_too_large");
});

test("proxy bounds chunked authentication payloads while streaming", async () => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode('{"sessionId":"'));
      controller.enqueue(encoder.encode("x".repeat(20_000)));
      controller.enqueue(encoder.encode('","csrfToken":"y"}'));
      controller.close();
    },
  });
  const response = await fetch(`${uiUrl}/api/bridge/auth/login-with-cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: uiUrl },
    body,
    duplex: "half",
  });
  assert.equal(response.status, 413);
  assert.equal(receivedRequests.length, 0);
  assert.equal((await response.json()).error.code, "payload_too_large");
});

test("proxy forwards allowed auth bodies without returning them", async () => {
  const response = await fetch(`${uiUrl}/api/bridge/auth/login-with-cookies`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: uiUrl },
    body: JSON.stringify({
      sessionId: "invented-session-value",
      csrfToken: "invented-csrf-value",
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(receivedRequests.at(-1).authorized, true);
  assert.equal(receivedRequests.at(-1).hasBody, true);
  const responseText = await response.text();
  assert.doesNotMatch(responseText, /invented-/);
});

test("proxy rejects cross-site privileged requests before service authorization", async () => {
  const response = await fetch(`${uiUrl}/api/bridge/auth/logout`, {
    method: "POST",
    headers: {
      Origin: "https://untrusted.example",
      "Sec-Fetch-Site": "cross-site",
    },
  });
  assert.equal(response.status, 403);
  assert.equal(receivedRequests.length, 0);
  assert.equal((await response.json()).error.code, "cross_site_request_rejected");
});

test("proxy requires JSON for authentication payloads", async () => {
  const response = await fetch(`${uiUrl}/api/bridge/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "text/plain", Origin: uiUrl },
    body: "{}",
  });
  assert.equal(response.status, 415);
  assert.equal(receivedRequests.length, 0);
  assert.equal((await response.json()).error.code, "unsupported_media_type");
});

test("proxy converts invalid upstream responses to a stable sanitized error", async () => {
  bridgeResponseMode = "invalid";
  const response = await fetch(`${uiUrl}/api/bridge/health`);
  assert.equal(response.status, 502);
  const text = await response.text();
  assert.match(text, /invalid_bridge_response/);
  assert.doesNotMatch(text, /synthetic upstream detail/);
});

test("policy API fails closed without a valid trusted assertion", async () => {
  const missing = await fetch(`${uiUrl}/api/policy`);
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "policy_auth_required");

  const invalidHeaders = policyAssertionHeaders(
    "GET",
    "/api/policy",
    policyActor,
    "invalid-policy-auth-secret-value-123456"
  );
  const invalid = await fetch(`${uiUrl}/api/policy`, {
    headers: invalidHeaders,
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, "policy_auth_invalid");

  const expiredHeaders = policyAssertionHeaders(
    "GET",
    "/api/policy",
    policyActor,
    policyAuthSecret,
    Date.now() - 120_000
  );
  const expired = await fetch(`${uiUrl}/api/policy`, {
    headers: expiredHeaders,
  });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, "policy_auth_invalid");
});

test("policy API reports missing deployment authentication configuration", async () => {
  const standaloneRoot = join(appRoot, ".next", "standalone", "triage-app");
  const standaloneServer = join(standaloneRoot, "server.js");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const processWithoutPolicyAuth = spawn(process.execPath, [standaloneServer], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      BRIDGE_URL: fakeBridgeUrl,
      BRIDGE_API_TOKEN: serviceToken,
      TYRION_POLICY_AUTH_SECRET: "",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: "ignore",
  });
  try {
    await waitForServer(url, processWithoutPolicyAuth);
    const response = await fetch(`${url}/api/policy`);
    assert.equal(response.status, 503);
    assert.equal(
      (await response.json()).error.code,
      "policy_auth_not_configured"
    );
    const attribution = await fetch(
      `${url}/api/internal/v1/attribution/batch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }
    );
    assert.equal(attribution.status, 503);
    assert.equal(
      (await attribution.json()).error.code,
      "attribution_auth_not_configured"
    );
  } finally {
    if (processWithoutPolicyAuth.exitCode === null) processWithoutPolicyAuth.kill();
  }
});

test("policy API creates a strict household-scoped policy and rejects stale writes", async () => {
  const initial = await policyFetch("/api/policy");
  assert.equal(initial.status, 200);
  const initialPayload = await initial.json();
  assert.equal(initialPayload.policy, null);
  assert.deepEqual(initialPayload.draft.exceptionPolicy.notificationSignals, [
    "limit-warning",
    "limit-exceeded",
    "attribution-review",
    "connector-degraded",
  ]);

  const draft = {
    ...initialPayload.draft,
    timezone: "America/New_York",
    kids: [
      {
        id: "kid-synthetic",
        displayName: "Synthetic Kid",
        color: null,
        active: true,
      },
    ],
    merchantRules: [
      {
        id: "rule-merchant-synthetic",
        kidId: "kid-synthetic",
        pattern: "SYNTHETIC STORE",
        confidence: "definite",
        enabled: true,
      },
    ],
    limits: [
      {
        kidId: "kid-synthetic",
        period: "daily",
        amount: 25,
        currency: "USD",
      },
      {
        kidId: "kid-synthetic",
        period: "weekly",
        amount: 100,
        currency: "USD",
      },
      {
        kidId: "kid-synthetic",
        period: "monthly",
        amount: 300,
        currency: "USD",
      },
    ],
  };
  const created = await policyFetch("/api/policy", "PUT", {
    expectedPolicyVersion: null,
    policy: draft,
  });
  assert.equal(created.status, 200);
  activePolicy = (await created.json()).policy;
  assert.equal(activePolicy.policyVersion, 1);
  assert.equal(activePolicy.householdId, policyActor.householdId);

  const stale = await policyFetch("/api/policy", "PUT", {
    expectedPolicyVersion: null,
    policy: draft,
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "policy_version_conflict");
});

test("batch attribution returns only strict normalized decisions", async () => {
  const response = await attributionFetch({
    contractVersion: "1.0",
    provenance: "mission-control-normalized-v1",
    expectedPolicyVersion: activePolicy.policyVersion,
    items: [
      attributionItem("consumer-source-one"),
      {
        ...attributionItem("consumer-source-manual"),
        existingManualDecision: {
          action: "assign-kid",
          kidId: "kid-synthetic",
          decidedAt: "2026-08-08T12:59:00Z",
        },
      },
    ],
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(
    text,
    /merchantName|instrumentFingerprint|occurredOn|observedAt|householdId|actorId/
  );
  const payload = JSON.parse(text);
  assert.equal(payload.policyVersion, activePolicy.policyVersion);
  assert.equal(payload.engineVersion, "1.0.0");
  assert.deepEqual(
    payload.results.map((result) => result.sourceRef),
    ["consumer-source-one", "consumer-source-manual"]
  );
  assert.deepEqual(payload.results[0], {
    contractVersion: "1.0",
    sourceRef: "consumer-source-one",
    status: "attributed",
    kidId: "kid-synthetic",
    confidence: "definite",
    method: "merchant-rule",
    explanation: "A configured merchant rule matched.",
    reviewStatus: "not-required",
    reasons: [],
    decisionSource: "automated",
    policyVersion: activePolicy.policyVersion,
    engineVersion: "1.0.0",
    evaluatedAt: payload.results[0].evaluatedAt,
  });
  assert.match(payload.results[0].evaluatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.results[1].method, "manual");
  assert.equal(payload.results[1].reviewStatus, "resolved");
});

test("batch attribution fails closed for auth, host, body, replay, and policy conflicts", async () => {
  const path = "/api/internal/v1/attribution/batch";
  const body = attributionRequest([attributionItem("consumer-auth")]);
  const missing = await fetch(`${uiUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "attribution_auth_required");

  const invalid = await attributionFetch(body, {
    secret: "invalid-attribution-auth-secret-value-123456",
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, "attribution_auth_invalid");

  const expired = await attributionFetch(body, {
    timestampMilliseconds: Date.now() - 120_000,
  });
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.code, "attribution_auth_invalid");

  const wrongPath = await attributionFetch(body, {
    signaturePath: "/api/internal/v1/attribution/other",
  });
  assert.equal(wrongPath.status, 401);
  assert.equal((await wrongPath.json()).error.code, "attribution_auth_invalid");

  const wrongBodyHash = await attributionFetch(body, {
    requestHeaders: { "x-tyrion-content-sha256": "0".repeat(64) },
  });
  assert.equal(wrongBodyHash.status, 401);
  assert.equal(
    (await wrongBodyHash.json()).error.code,
    "attribution_auth_invalid"
  );

  const publicHost = await attributionFetch(body, {
    requestHeaders: { "x-forwarded-host": "tyrion.socko.us" },
  });
  assert.equal(publicHost.status, 404);
  assert.equal(
    (await publicHost.json()).error.code,
    "attribution_route_not_available"
  );

  const nonce = randomUUID().replaceAll("-", "");
  const first = await attributionFetch(body, { nonce });
  assert.equal(first.status, 200);
  const replay = await attributionFetch(body, { nonce });
  assert.equal(replay.status, 409);
  assert.equal(
    (await replay.json()).error.code,
    "attribution_replay_detected"
  );

  const conflict = await attributionFetch({
    ...body,
    expectedPolicyVersion: activePolicy.policyVersion + 1,
    items: [attributionItem("consumer-conflict")],
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "policy_conflict");
});

test("batch attribution rejects private fields and enforces size and rate bounds", async () => {
  const privateField = await attributionFetch(
    attributionRequest([
      { ...attributionItem("consumer-private"), amount: 12 },
    ])
  );
  assert.equal(privateField.status, 400);
  assert.equal((await privateField.json()).error.code, "invalid_request");

  const changedSourceRef = await attributionFetch(
    attributionRequest([attributionItem(" consumer-whitespace ")])
  );
  assert.equal(changedSourceRef.status, 400);
  assert.equal((await changedSourceRef.json()).error.code, "invalid_request");

  const tooMany = await attributionFetch(
    attributionRequest(
      Array.from({ length: 101 }, (_, index) =>
        attributionItem(`consumer-batch-${index}`)
      )
    )
  );
  assert.equal(tooMany.status, 413);
  assert.equal((await tooMany.json()).error.code, "batch_too_large");

  const oversized = await fetch(`${uiUrl}/api/internal/v1/attribution/batch`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(64 * 1_024 + 1),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "payload_too_large");

  const replayDirectory = resolve(
    temporaryStateDirectory,
    "attribution-replay"
  );
  await mkdir(replayDirectory, { recursive: true });
  await writeFile(
    resolve(replayDirectory, `1-${"a".repeat(64)}.nonce`),
    "",
    "utf8"
  );
  const replayStore = new FileAttributionReplayStore(replayDirectory);
  const concurrent = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      replayStore.consume(
        attributionClientId,
        "100",
        `nonce-concurrent-${index.toString().padStart(4, "0")}`,
        220,
        100
      )
    )
  );
  assert.deepEqual(concurrent, Array(12).fill(true));

  await Promise.all(
    Array.from({ length: 1_001 }, (_, index) =>
      writeFile(
        resolve(
          replayDirectory,
          `1-${index.toString(16).padStart(64, "0")}.nonce`
        ),
        "",
        "utf8"
      )
    )
  );
  const recovered = await replayStore.consume(
    attributionClientId,
    "101",
    "nonce-capacity-recovery",
    221,
    101
  );
  assert.equal(recovered, true);
  assert.equal(
    await replayStore.consume(
      attributionClientId,
      "101",
      "nonce-capacity-recovery",
      221,
      101
    ),
    false
  );

  let limited;
  for (let index = 0; index < 60; index += 1) {
    limited = await attributionFetch(
      attributionRequest([attributionItem(`consumer-rate-${index}`)])
    );
    if (limited.status === 429) break;
  }
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).error.code, "attribution_rate_limited");
});

test("policy mutations reject cross-site requests and client-supplied permissions", async () => {
  const crossSite = await policyFetch(
    "/api/policy",
    "PUT",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      policy: policyDraft(activePolicy),
    },
    policyActor,
    "https://untrusted.example"
  );
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, "cross_site_request_rejected");

  const reader = { ...policyActor, permissions: ["policy:read"] };
  const forbidden = await policyFetch(
    "/api/policy",
    "PUT",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      policy: policyDraft(activePolicy),
      permissions: ["policy:write"],
    },
    reader
  );
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json()).error.code, "invalid_request");

  const actualForbidden = await policyFetch(
    "/api/policy",
    "PUT",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      policy: policyDraft(activePolicy),
    },
    reader
  );
  assert.equal(actualForbidden.status, 403);
  assert.equal((await actualForbidden.json()).error.code, "policy_forbidden");
});

test("instrument references are fingerprinted server-side and never persisted raw", async () => {
  const instrumentReference = "opaque-integration-reference-synthetic";
  const bypass = await policyFetch("/api/policy", "PUT", {
    expectedPolicyVersion: activePolicy.policyVersion,
    policy: {
      ...policyDraft(activePolicy),
      cardRules: [
        {
          id: "rule-card-bypass",
          kidId: "kid-synthetic",
          instrumentFingerprint: instrumentReference,
          confidence: "definite",
          enabled: true,
        },
      ],
    },
  });
  assert.equal(bypass.status, 422);
  assert.equal((await bypass.json()).error.code, "invalid_domain_contract");

  const fingerprintResponse = await policyFetch(
    "/api/policy/instruments/fingerprint",
    "POST",
    { instrumentReference }
  );
  assert.equal(fingerprintResponse.status, 200);
  const fingerprintText = await fingerprintResponse.text();
  assert.doesNotMatch(fingerprintText, new RegExp(instrumentReference));
  const fingerprint = JSON.parse(fingerprintText).instrumentFingerprint;
  assert.match(fingerprint, /^instrument-v1:[A-Za-z0-9_-]{43}$/);

  const updatedDraft = policyDraft(activePolicy);
  updatedDraft.cardRules = [
    {
      id: "rule-card-synthetic",
      kidId: "kid-synthetic",
      instrumentFingerprint: fingerprint,
      confidence: "definite",
      enabled: true,
    },
  ];
  const updated = await policyFetch("/api/policy", "PUT", {
    expectedPolicyVersion: activePolicy.policyVersion,
    policy: updatedDraft,
  });
  assert.equal(updated.status, 200);
  activePolicy = (await updated.json()).policy;
  assert.equal(activePolicy.policyVersion, 2);
  const stored = await readFile(policyStorePath, "utf8");
  assert.doesNotMatch(stored, new RegExp(instrumentReference));
  assert.doesNotMatch(stored, /password|cookie|authorization|sessionPath/i);
});

test("container and homelab contracts keep attribution private and protected", async () => {
  const dockerfile = await readFile(join(appRoot, "Dockerfile"), "utf8");
  assert.match(
    dockerfile,
    /install -d -m 0700 -o tyrion -g tyrion \/var\/lib\/tyrion-policy/
  );
  assert.ok(
    dockerfile.indexOf("/var/lib/tyrion-policy") <
      dockerfile.indexOf("USER tyrion")
  );
  assert.match(dockerfile, /node_modules\/sharp node_modules\/@img\/\*/);
  assert.match(dockerfile, /\[ "\$\{sharp_count\}" -eq 1 \]/);
  assert.match(dockerfile, /\[ "\$\{platform_count\}" -gt 0 \]/);
  assert.match(dockerfile, /\[ "\$\{libvips_count\}" -gt 0 \]/);
  assert.match(dockerfile, /package_license.*LGPL-3\.0-or-later/);
  assert.match(dockerfile, /\/usr\/share\/common-licenses\/LGPL-3/);
  assert.match(
    dockerfile,
    /\/workspace\/runtime-licenses \/licenses\/npm-runtime/
  );
  const compose = await readFile(
    resolve(appRoot, "..", "deploy", "homelab", "compose.yaml"),
    "utf8"
  );
  assert.match(compose, /PathPrefix\(`\/api\/policy`\)/);
  assert.match(compose, /tyrion-policy-auth\.forwardauth\.address/);
  assert.match(compose, /TYRION_POLICY_STORE_PATH: \/var\/lib\/tyrion-policy/);
  assert.match(
    compose,
    /!PathPrefix\(`\/api\/internal\/`\)/
  );
  assert.doesNotMatch(
    compose,
    /routers\.[^.]*attribution[^=]*\.rule=.*PathPrefix/
  );
  assert.match(
    compose,
    /TYRION_ATTRIBUTION_INTERNAL_HOST: tyrion-operations-ui:3000/
  );
  assert.match(
    compose,
    /TYRION_ATTRIBUTION_REPLAY_STORE_PATH: \/var\/lib\/tyrion-policy\/attribution-replay/
  );
});

test("re-attribution preview is bounded, aggregate-only, and requires separate permissions", async () => {
  const tooMany = await policyFetch(
    "/api/policy/reattribution/preview",
    "POST",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      sourceRefs: Array.from({ length: 101 }, (_, index) => `record-${index}`),
    }
  );
  assert.equal(tooMany.status, 422);
  assert.equal(
    (await tooMany.json()).error.code,
    "invalid_reattribution_selection"
  );

  const writerOnly = {
    ...policyActor,
    permissions: ["policy:read", "policy:write"],
  };
  const forbidden = await policyFetch(
    "/api/policy/reattribution/preview",
    "POST",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      sourceRefs: ["record-synthetic"],
    },
    writerOnly
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "policy_forbidden");

  const response = await policyFetch(
    "/api/policy/reattribution/preview",
    "POST",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      sourceRefs: ["record-synthetic", "record-manual"],
    }
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(text, /record-synthetic|SYNTHETIC STORE|sourceRef|previous|proposed/);
  const preview = JSON.parse(text).preview;
  assert.equal(preview.policyVersion, activePolicy.policyVersion);
  assert.equal(preview.selectedCount, 2);
  assert.equal(preview.summary["would-update"], 1);
  assert.equal(preview.summary["manual-preserved"], 1);

  const previewOnly = {
    ...policyActor,
    permissions: ["policy:read", "reattribution:preview"],
  };
  const applyForbidden = await policyFetch(
    "/api/policy/reattribution/apply",
    "POST",
    {
      previewId: preview.previewId,
      expectedPolicyVersion: preview.policyVersion,
      confirm: true,
    },
    previewOnly
  );
  assert.equal(applyForbidden.status, 403);
  assert.equal((await applyForbidden.json()).error.code, "policy_forbidden");

  const applied = await policyFetch(
    "/api/policy/reattribution/apply",
    "POST",
    {
      previewId: preview.previewId,
      expectedPolicyVersion: preview.policyVersion,
      confirm: true,
    }
  );
  assert.equal(applied.status, 200);
  const result = (await applied.json()).result;
  assert.equal(result.applied, 1);
  assert.equal(result.manualPreserved, 1);
});

test("re-attribution integration failures are stable and sanitized", async () => {
  reattributionResponseMode = "unavailable";
  const response = await policyFetch(
    "/api/policy/reattribution/preview",
    "POST",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      sourceRefs: ["record-unavailable"],
    }
  );
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /reattribution_integration_unavailable/);
  assert.doesNotMatch(text, /synthetic private detail/);
});

test("re-attribution apply rejects missing confirmation, expired previews, and policy conflicts", async () => {
  expireNextPreview = true;
  const expiredPreviewResponse = await policyFetch(
    "/api/policy/reattribution/preview",
    "POST",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      sourceRefs: ["record-expired"],
    }
  );
  assert.equal(expiredPreviewResponse.status, 200);
  const expiredPreview = (await expiredPreviewResponse.json()).preview;
  const missingConfirmation = await policyFetch(
    "/api/policy/reattribution/apply",
    "POST",
    {
      previewId: expiredPreview.previewId,
      expectedPolicyVersion: expiredPreview.policyVersion,
      confirm: false,
    }
  );
  assert.equal(missingConfirmation.status, 422);
  assert.equal(
    (await missingConfirmation.json()).error.code,
    "invalid_reattribution_apply"
  );

  const expired = await policyFetch(
    "/api/policy/reattribution/apply",
    "POST",
    {
      previewId: expiredPreview.previewId,
      expectedPolicyVersion: expiredPreview.policyVersion,
      confirm: true,
    }
  );
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error.code, "reattribution_preview_expired");

  const conflictPreviewResponse = await policyFetch(
    "/api/policy/reattribution/preview",
    "POST",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      sourceRefs: ["record-conflict"],
    }
  );
  assert.equal(conflictPreviewResponse.status, 200);
  const conflictPreview = (await conflictPreviewResponse.json()).preview;
  const policyUpdate = await policyFetch("/api/policy", "PUT", {
    expectedPolicyVersion: activePolicy.policyVersion,
    policy: {
      ...policyDraft(activePolicy),
      exceptionPolicy: {
        ...activePolicy.exceptionPolicy,
        limitWarningPercent: 75,
      },
    },
  });
  activePolicy = (await policyUpdate.json()).policy;

  const conflict = await policyFetch(
    "/api/policy/reattribution/apply",
    "POST",
    {
      previewId: conflictPreview.previewId,
      expectedPolicyVersion: conflictPreview.policyVersion,
      confirm: true,
    }
  );
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "policy_version_conflict");
});

function policyFetch(
  path,
  method = "GET",
  body,
  actor = policyActor,
  origin = uiUrl
) {
  const headers = policyAssertionHeaders(method, path, actor, policyAuthSecret);
  if (body !== undefined) {
    headers.set("Content-Type", "application/json");
    headers.set("Origin", origin);
  }
  return fetch(`${uiUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function attributionFetch(body, options = {}) {
  const path = "/api/internal/v1/attribution/batch";
  const serialized = JSON.stringify(body);
  const bytes = new TextEncoder().encode(serialized);
  const timestamp = String(
    Math.floor((options.timestampMilliseconds ?? Date.now()) / 1_000)
  );
  const nonce = options.nonce ?? randomUUID().replaceAll("-", "");
  const host = new URL(uiUrl).host;
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const signature = createHmac(
    "sha256",
    options.secret ?? attributionAuthSecret
  )
    .update(
      [
        "POST",
        options.signaturePath ?? path,
        host,
        attributionClientId,
        timestamp,
        nonce,
        contentHash,
      ].join("\n")
    )
    .digest("hex");
  return fetch(`${uiUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-tyrion-service-client": attributionClientId,
      "x-tyrion-service-timestamp": timestamp,
      "x-tyrion-service-nonce": nonce,
      "x-tyrion-content-sha256": contentHash,
      "x-tyrion-service-signature": signature,
      ...options.requestHeaders,
    },
    body: serialized,
  });
}

function attributionRequest(items) {
  return {
    contractVersion: "1.0",
    provenance: "mission-control-normalized-v1",
    expectedPolicyVersion: activePolicy.policyVersion,
    items,
  };
}

function attributionItem(sourceRef) {
  return {
    sourceRef,
    occurredOn: "2026-08-08",
    merchantName: "Synthetic Store",
    instrumentFingerprint: null,
    observedAt: "2026-08-08T12:58:00Z",
    existingManualDecision: null,
  };
}

function policyAssertionHeaders(
  method,
  pathname,
  actor,
  secret,
  timestampMilliseconds = Date.now()
) {
  const timestamp = String(Math.floor(timestampMilliseconds / 1_000));
  const permissions = actor.permissions.join(",");
  const signature = createHmac("sha256", secret)
    .update(
      [
        method,
        pathname,
        actor.actorId,
        actor.householdId,
        permissions,
        timestamp,
      ].join("\n")
    )
    .digest("hex");
  return new Headers({
    "x-tyrion-actor": actor.actorId,
    "x-tyrion-household": actor.householdId,
    "x-tyrion-permissions": permissions,
    "x-tyrion-auth-timestamp": timestamp,
    "x-tyrion-auth-signature": signature,
  });
}

function policyDraft(policy) {
  return {
    timezone: policy.timezone,
    currency: policy.currency,
    kids: policy.kids,
    cardRules: policy.cardRules,
    merchantRules: policy.merchantRules,
    limits: policy.limits,
    exceptionPolicy: policy.exceptionPolicy,
  };
}

function reattributionRecord(householdId, sourceRef) {
  const manual = sourceRef === "record-manual";
  const evaluatedAt = "2026-01-01T00:00:00.000Z";
  return {
    input: {
      contractVersion: "1.0",
      householdId,
      source: {
        system: "monarch-bridge",
        recordRef: sourceRef,
        observedAt: evaluatedAt,
      },
      transaction: {
        merchantName: "Synthetic Store",
        instrumentFingerprint: null,
        occurredOn: "2026-01-01",
      },
      historicalAttributions: [],
      existingManualDecision: manual
        ? {
            action: "assign-kid",
            kidId: "kid-synthetic",
            actorId: "actor-synthetic",
            decidedAt: evaluatedAt,
            explanation: "Synthetic manual decision.",
          }
        : null,
    },
    current: {
      contractVersion: "1.0",
      sourceRef,
      status: manual ? "attributed" : "unassigned",
      kidId: manual ? "kid-synthetic" : null,
      confidence: manual ? "definite" : "none",
      method: manual ? "manual" : "unassigned",
      explanation: manual
        ? "An existing manual decision is preserved."
        : "No deterministic attribution was available.",
      review: {
        status: manual ? "resolved" : "pending",
        reasons: manual ? [] : ["no-match"],
      },
      provenance: {
        decisionSource: manual ? "manual" : "fallback",
        policyVersion: null,
        engineVersion: "1.0.0",
        ruleIds: [],
        evaluatedAt,
      },
    },
  };
}

function impactCounts(preview) {
  const counts = {
    applied: 0,
    unchanged: 0,
    manualPreserved: 0,
    pendingReview: 0,
  };
  for (const item of preview.items) {
    if (item.disposition === "would-update") counts.applied += 1;
    if (item.disposition === "unchanged") counts.unchanged += 1;
    if (item.disposition === "manual-preserved") counts.manualPreserved += 1;
    if (item.disposition === "pending-review") counts.pendingReview += 1;
  }
  return counts;
}

async function waitForServer(url, process) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) {
      throw new Error("The policy test server exited before becoming ready");
    }
    try {
      const response = await fetch(`${url}/api/health`);
      if (response.ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  throw new Error("The policy test server did not become ready");
}
