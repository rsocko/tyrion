import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { after, before, beforeEach, test } from "node:test";
import {
  evaluateBridgeRequest,
  resolveBridgeConfiguration,
} from "../src/lib/bridge-proxy-policy.mjs";
import { connectionPresentation } from "../src/lib/operational-state.mjs";

const appRoot = process.cwd();
const serviceToken = "synthetic-test-service-token-value";
let fakeBridge;
let fakeBridgeUrl;
let uiProcess;
let uiUrl;
let receivedRequests = [];
let bridgeResponseMode = "normal";
let authState = "connected";

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
  const standaloneServer = join(appRoot, ".next", "standalone", "server.js");
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

  const port = await freePort();
  uiUrl = `http://127.0.0.1:${port}`;
  uiProcess = spawn(process.execPath, [standaloneServer], {
    cwd: join(appRoot, ".next", "standalone"),
    env: {
      ...process.env,
      BRIDGE_URL: fakeBridgeUrl,
      BRIDGE_API_TOKEN: serviceToken,
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
});

beforeEach(() => {
  receivedRequests = [];
  bridgeResponseMode = "normal";
  authState = "connected";
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

test("production route tree contains no broad finance pages", async () => {
  const root = await fetch(`${uiUrl}/`);
  assert.equal(root.status, 200);
  assert.match(root.headers.get("content-security-policy") || "", /frame-ancestors 'none'/);
  assert.equal(root.headers.get("x-frame-options"), "DENY");
  const rootHtml = await root.text();
  assert.match(rootHtml, /Monarch connector/);
  assert.doesNotMatch(rootHtml, /Finance Dashboard|Transactions|Budgets|Bills|Chat/);

  for (const path of ["/settings", "/triage", "/kids", "/bills", "/chat"]) {
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
