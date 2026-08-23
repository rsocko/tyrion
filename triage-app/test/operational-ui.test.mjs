import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, request as httpRequest } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { after, before, beforeEach, test } from "node:test";
import {
  evaluateBridgeRequest,
  resolveBridgeConfiguration,
} from "../src/lib/bridge-proxy-policy.mjs";
import {
  authenticateConnectorRequest,
  evaluateConnectorRequest,
  MAX_CONNECTOR_RESPONSE_BYTES,
  parseCategoryMutation,
  resolveConnectorBridgeUrl,
} from "../src/lib/connector-gateway-policy.mjs";
import {
  composeConnectorHealth,
  CONNECTOR_HEALTH_RESPONSE_BYTES,
} from "../src/lib/connector-health.mjs";
import { connectionPresentation } from "../src/lib/operational-state.mjs";
import { policyStatePresentation } from "../src/lib/policy-ui-state.mjs";
import {
  isMissionControlRecoveryEntry,
  reconnectPhase,
  resolveMissionControlHandoff,
} from "../src/lib/reconnect-handoff.mjs";

const appRoot = process.cwd();
const financeRequire = createRequire(
  resolve(appRoot, "..", "finance-insights", "package.json")
);
const Database = financeRequire("better-sqlite3");
const serviceToken = "synthetic-test-service-token-value";
const internalAttributionHost = "tyrion-operations-ui:3000";
const policyActor = {
  actorId: "local-operator",
  householdId: "homelab-household",
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
let standaloneRoot;
let standaloneServer;
let temporaryStateDirectory;
let policyStorePath;
let financeInsightStorePath;
let staleFinanceInsightGeneration;
let financeContract;
let receivedRequests = [];
let bridgeResponseMode = "normal";
let bridgePathResponseModes = new Map();
let authState = "connected";
let healthPayloadOverride;
let authStatusPayloadOverride;
let previews = new Map();
let attributionActionRecords = new Map();
let attributionActionReplays = new Map();
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

async function stopProcess(processHandle) {
  if (processHandle.exitCode !== null) return;
  const exited = new Promise((resolvePromise) =>
    processHandle.once("exit", resolvePromise)
  );
  processHandle.kill();
  await exited;
}

before(async () => {
  standaloneRoot = join(appRoot, ".next", "standalone", "triage-app");
  standaloneServer = join(standaloneRoot, "server.js");
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
        body: Buffer.concat(chunks).toString("utf8"),
      });

      const responseMode =
        bridgePathResponseModes.get(request.url) ?? bridgeResponseMode;
      if (responseMode === "invalid") {
        response.writeHead(502, { "Content-Type": "text/plain" });
        response.end("synthetic upstream detail that must not escape");
        return;
      }
      if (responseMode === "non-json") {
        response.writeHead(200, {
          "Content-Type": "text/plain",
          "X-Monarch-Contract-Version": "1.0",
        });
        response.end("synthetic upstream detail that must not escape");
        return;
      }
      if (responseMode === "network") {
        request.socket.destroy();
        return;
      }
      if (responseMode === "oversized") {
        const payload = JSON.stringify({
          contractVersion: "1.0",
          value: "x".repeat(
            request.url === "/health" || request.url === "/auth/status"
              ? CONNECTOR_HEALTH_RESPONSE_BYTES
              : MAX_CONNECTOR_RESPONSE_BYTES
          ),
        });
        response.writeHead(200, {
          "Content-Type": "application/json",
          "X-Monarch-Contract-Version": "1.0",
        });
        response.end(payload);
        return;
      }
      if (responseMode === "malformed-json") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "X-Monarch-Contract-Version": "1.0",
        });
        response.end("{");
        return;
      }
      if (responseMode === "non-2xx") {
        response.writeHead(503, {
          "Content-Type": "application/json",
          "X-Monarch-Contract-Version": "1.0",
        });
        response.end(JSON.stringify({
          contractVersion: "1.0",
          error: {
            code: "synthetic_private_failure",
            message: "synthetic upstream detail that must not escape",
          },
        }));
        return;
      }
      if (responseMode === "mismatched-version") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "X-Monarch-Contract-Version": "2.0",
        });
        response.end(JSON.stringify({ contractVersion: "2.0" }));
        return;
      }
      if (responseMode === "malformed-shape") {
        response.writeHead(200, {
          "Content-Type": "application/json",
          "X-Monarch-Contract-Version": "1.0",
        });
        response.end(JSON.stringify({
          contractVersion: "1.0",
          authenticated: "yes",
          authState: "connected",
          email: null,
          mode: "live",
        }));
        return;
      }
      if (responseMode === "rate-limited") {
        response.writeHead(429, {
          "Content-Type": "application/json",
          "Retry-After": "17",
          "X-Monarch-Contract-Version": "1.0",
        });
        response.end(JSON.stringify({
          contractVersion: "1.0",
          error: { code: "upstream_rate_limited", message: "Retry later" },
        }));
        return;
      }

      const common = { contractVersion: "1.0", mode: "live" };
      const payload =
        request.url === "/health"
          ? healthPayloadOverride ?? {
              ...common,
              status: "ok",
              reachable: true,
              authenticated: authState === "connected",
              authState,
            }
          : request.url === "/auth/status"
            ? authStatusPayloadOverride ?? {
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

      response.writeHead(200, {
        "Content-Type": "application/json",
        "X-Monarch-Contract-Version": "1.0",
      });
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
      if (request.headers.authorization !== `Bearer ${serviceToken}`) {
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
      } else if (
        request.url === "/v1/attribution-actions/records:resolve"
      ) {
        let record = attributionActionRecords.get(body.sourceRef);
        if (!record && body.sourceRef !== "consumer-action-missing") {
          record = attributionActionRecord(body.householdId, body.sourceRef);
          attributionActionRecords.set(body.sourceRef, record);
        }
        payload = { record: record ?? null };
      } else if (
        request.url === "/v1/attribution-actions/actions:apply"
      ) {
        const mutation = body.mutation;
        const replay = attributionActionReplays.get(
          mutation.request.idempotencyKey
        );
        if (replay) {
          payload = { result: { ...replay, replayed: true } };
        } else {
          const current = attributionActionRecords.get(
            mutation.request.sourceRef
          );
          if (
            !current ||
            current.stateVersion !== mutation.request.expectedStateVersion
          ) {
            payload = { result: null };
          } else {
            const stateVersion = current.stateVersion + 1;
            const record = {
              input: mutation.input,
              attribution: mutation.attribution,
              stateVersion,
              exception: mutation.exception,
              lastAction: {
                ...mutation.audit,
                outcome: "applied",
                stateVersion,
              },
            };
            attributionActionRecords.set(mutation.request.sourceRef, record);
            const result = {
              record,
              replayed: false,
              requestFingerprint: mutation.requestFingerprint,
            };
            attributionActionReplays.set(
              mutation.request.idempotencyKey,
              structuredClone(result)
            );
            payload = { result };
          }
        }
      } else if (
        request.url === "/v1/attribution-actions/actions:resolve"
      ) {
        const replay = attributionActionReplays.get(body.idempotencyKey);
        payload = {
          result:
            replay && replay.record.attribution.sourceRef === body.sourceRef
              ? { ...replay, replayed: true }
              : null,
        }
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
  financeInsightStorePath = resolve(
    temporaryStateDirectory,
    "finance-insights.sqlite"
  );
  financeContract = await import(
    pathToFileURL(
      resolve(appRoot, "..", "finance-insights", "dist", "index.js")
    ).href
  );
  const baseFinancePolicy = financeContract.createCandidatePolicySnapshotV1({
    policyVersion: 1,
    effectiveAt: "2026-08-01T00:00:00Z",
    currency: "USD",
    timezone: "America/New_York",
  });
  const staleStore = new financeContract.FinanceInsightSqliteStoreV1({
    path: financeInsightStorePath,
    cursorChecksumNamespace: Buffer.from(
      "tyrion/finance-insight/cursor-checksum/v1",
      "utf8"
    ),
    clock: () => "2026-08-09T03:00:00.000Z",
  });
  await staleStore.policies.append(
    financeContract.parseFinanceInsightPolicySnapshotV1({
      ...baseFinancePolicy,
      featureGates: {
        ...baseFinancePolicy.featureGates,
        recurringAmountAnalysis: true,
        recurringAmountNotifications: false,
        largeTransactionAnalysis: true,
        varianceAnalysis: true,
        immediateLargeTransactionNotifications: false,
        monthlyMoverDigestNotifications: false,
        confirmedActions: true,
      },
    })
  );
  const staleLifecycle = new financeContract.FinanceInsightLifecycleServiceV1({
    store: staleStore,
    householdScope: "homelab-household",
    detectorSetVersion: "detectors-v1",
  });
  const stalePublication = financePublication(99);
  staleFinanceInsightGeneration =
    financeContract.parseSourceGenerationCreateRequestV1({
      ...stalePublication.request,
      connectorRef: "stale-service-connector",
      sourceGeneration: "stale-service-generation",
      idempotencyKey: "stale-service-generation-idempotency",
    });
  await staleLifecycle.beginSourceGeneration(staleFinanceInsightGeneration);
  staleStore.close();

  const port = await freePort();
  uiUrl = `http://127.0.0.1:${port}`;
  uiProcess = spawn(process.execPath, [standaloneServer], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      BRIDGE_URL: fakeBridgeUrl,
      BRIDGE_API_TOKEN: serviceToken,
      MISSION_CONTROL_RETURN_URL:
        "https://mission-control.example.invalid/finance/settings",
      MISSION_CONTROL_RETURN_ALLOWED_ORIGINS:
        "https://mission-control.example.invalid",
      TYRION_POLICY_STORE_PATH: policyStorePath,
      TYRION_FINANCE_INSIGHT_STORE_PATH: financeInsightStorePath,
      TYRION_FINANCE_INSIGHT_EVALUATION_WRITE_ENABLED: "true",
      TYRION_FINANCE_INSIGHT_READ_ENABLED: "true",
      TYRION_FINANCE_INSIGHT_ACTIONS_ENABLED: "true",
      TYRION_FINANCE_AUTOMATION_WRITE_ENABLED: "true",
      TYRION_FINANCE_INSIGHT_TEST_ONLY_NOW: "2026-08-11T14:00:00Z",
      TYRION_REATTRIBUTION_URL: fakeReattributionUrl,
      TYRION_REATTRIBUTION_ALLOW_INSECURE_INTERNAL: "true",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: "ignore",
  });
  await waitForServer(uiUrl, uiProcess);
});

after(async () => {
  if (uiProcess) await stopProcess(uiProcess);
  if (fakeBridge?.listening) {
    await close(fakeBridge);
  }
  if (fakeReattribution?.listening) {
    await close(fakeReattribution);
  }
  if (temporaryStateDirectory) {
    await rm(temporaryStateDirectory, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

function insightHeaders(overrides = {}) {
  return Object.fromEntries(
    Object.entries({
      Host: internalAttributionHost,
      Authorization: `Bearer ${serviceToken}`,
      "Content-Type": "application/json",
      ...overrides,
    }).filter(([, value]) => value !== undefined)
  );
}

function insightRequest(path, options = {}, baseUrl = uiUrl) {
  const target = new URL(baseUrl);
  const body = options.body;
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path: `/api/internal/v1/finance/insights${path}`,
      method: options.method ?? "GET",
      headers: insightHeaders(options.headers),
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        resolvePromise(
          new Response(Buffer.concat(chunks), {
            status: response.statusCode,
            headers: response.headers,
          })
        );
      });
    });
    request.on("error", reject);
    if (body !== undefined) request.write(body);
    request.end();
  });
}

function financePublication(sequence, transactions = [], additionalFacts = {}) {
  const sourceGeneration = `service-generation-${sequence}`;
  const facts = {
    transaction: transactions,
    recurring: additionalFacts.recurring ?? [],
    category: [],
    account: additionalFacts.account ?? [],
    tag: [],
  };
  const batches = [];
  for (const kind of ["transaction", "recurring", "category", "account", "tag"]) {
    if (facts[kind].length === 0) continue;
    for (let batchIndex = 0; batchIndex * 250 < facts[kind].length; batchIndex += 1) {
      const batchFacts = facts[kind].slice(batchIndex * 250, (batchIndex + 1) * 250);
      batches.push(
        financeContract.parseSourceFactBatchV1({
          contractVersion: "1.0",
          sourceGeneration,
          kind,
          batchIndex,
          facts: batchFacts,
          digest: financeContract.canonicalDigestV1(batchFacts),
          idempotencyKey: `service-${kind}-batch-${sequence}-${batchIndex}`,
        })
      );
    }
  }
  const kinds = ["transaction", "recurring", "category", "account", "tag"];
  const manifest = kinds.map((kind) => ({
    kind,
    batchCount: Math.ceil(facts[kind].length / 250),
    itemCount: facts[kind].length,
    digest: financeContract.sourceManifestKindDigestV1(kind, batches),
  }));
  const sourceAsOf = "2026-08-11T03:30:00Z";
  const request = financeContract.parseSourceGenerationCreateRequestV1({
    contractVersion: "1.0",
    connectorRef: "service-connector",
    sourceGeneration,
    sourceSequence: sequence,
    sourceAsOf,
    coverageStart: "2026-01-01",
    coverageEnd: "2026-08-10",
    currency: "USD",
    bridgeContractVersion: "bridge-v1",
    capturedConstituents: manifest.map((entry) => ({
      kind: entry.kind,
      generationRef: `service-${entry.kind}-constituent-${sequence}`,
      sourceAsOf,
      itemCount: entry.itemCount,
      digest: financeContract.canonicalDigestV1(facts[entry.kind]),
    })),
    manifest,
    idempotencyKey: `service-generation-idempotency-${sequence}`,
  });
  return {
    request,
    batches,
    commit: {
      contractVersion: "1.0",
      sourceGeneration,
      expectedSourceSequence: sequence,
      manifestDigest: financeContract.sourceManifestDigestV1(manifest),
      idempotencyKey: `service-generation-commit-${sequence}`,
    },
  };
}

test("finance insight runtime applies retention cleanup on startup", async () => {
  const health = await fetch(`${uiUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).financeInsights.status, "ready");
  const store = new financeContract.FinanceInsightSqliteStoreV1({
    path: financeInsightStorePath,
    cursorChecksumNamespace: Buffer.from(
      "tyrion/finance-insight/cursor-checksum/v1",
      "utf8"
    ),
  });
  try {
    const generation = await store.sourceGenerations.find(
      staleFinanceInsightGeneration.connectorRef,
      staleFinanceInsightGeneration.sourceGeneration
    );
    assert.equal(generation.state, "expired");
  } finally {
    store.close();
  }
});

async function publishFinanceGeneration(publication) {
  const begin = await insightRequest("/source-generations", {
    method: "POST",
    body: JSON.stringify(publication.request),
  });
  assert.equal(begin.status, 202);
  for (const batch of publication.batches) {
    const receipt = await insightRequest(
      `/source-generations/${batch.sourceGeneration}/batches/${batch.batchIndex}`,
      {
        method: "PUT",
        body: JSON.stringify(batch),
      }
    );
    assert.equal(receipt.status, 200);
  }
  return insightRequest(
    `/source-generations/${publication.request.sourceGeneration}/commit`,
    {
      method: "POST",
      body: JSON.stringify(publication.commit),
    }
  );
}

test("finance insight routes enforce fixed private authority and bearer auth", async () => {
  const wrongAuthority = await fetch(
    `${uiUrl}/api/internal/v1/finance/insights/source-generations`,
    { method: "POST" }
  );
  assert.equal(wrongAuthority.status, 404);
  assert.deepEqual(await wrongAuthority.json(), {
    contractVersion: "1.0",
    error: {
      code: "insight_route_not_available",
      message: "Finance insight route is not available",
    },
  });

  const missing = await insightRequest("/source-generations", {
    method: "POST",
    headers: { Authorization: undefined },
  });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "insight_auth_required");

  const invalid = await insightRequest("/source-generations", {
    method: "POST",
    headers: { Authorization: "Bearer invented-invalid-service-token-value" },
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, "insight_auth_invalid");

  const forbidden = await insightRequest("/source-generations", {
    method: "POST",
    headers: { Origin: "https://invented.example" },
  });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, "insight_forbidden");

  const unsupportedMedia = await insightRequest("/source-generations", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  assert.equal(unsupportedMedia.status, 415);
  assert.equal(
    (await unsupportedMedia.json()).error.code,
    "unsupported_media_type"
  );
});

test("finance insight service promotes an exact empty generation idempotently", async () => {
  const publication = financePublication(1);
  const committed = await publishFinanceGeneration(publication);
  assert.equal(committed.status, 200);
  assert.deepEqual(await committed.json(), {
    contractVersion: "1.0",
    connectorRef: "service-connector",
    sourceGeneration: "service-generation-1",
    sourceSequence: 1,
    state: "promoted",
    detectorSetVersion: "detectors-v1",
    policyVersion: 1,
  });

  const replay = await insightRequest("/source-generations", {
    method: "POST",
    body: JSON.stringify(publication.request),
  });
  assert.equal(replay.status, 202);

  const listed = await insightRequest("/occurrences");
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), {
    contractVersion: "1.0",
    items: [],
    nextCursor: null,
  });

  const evaluationRequest = {
    contractVersion: "1.0",
    connectorRef: publication.request.connectorRef,
    sourceGeneration: publication.request.sourceGeneration,
    detectorSetVersion: "detectors-v1",
    expectedPolicyVersion: 1,
    idempotencyKey: "service-evaluation-retry-1",
  };
  const retried = await insightRequest("/evaluations", {
    method: "POST",
    body: JSON.stringify(evaluationRequest),
  });
  assert.equal(retried.status, 202);
  assert.equal(
    financeContract.parseEvaluationResultV1(await retried.json()).state,
    "completed"
  );

  for (const request of [
    {
      ...evaluationRequest,
      detectorSetVersion: "detectors-v2",
      idempotencyKey: "service-evaluation-wrong-detector",
    },
    {
      ...evaluationRequest,
      expectedPolicyVersion: 2,
      idempotencyKey: "service-evaluation-wrong-policy",
    },
  ]) {
    const fenced = await insightRequest("/evaluations", {
      method: "POST",
      body: JSON.stringify(request),
    });
    assert.equal(fenced.status, 409);
    assert.equal((await fenced.json()).error.code, "stale_evaluation");
  }
});

test("finance automation jobs deliver and acknowledge exact versions idempotently", async () => {
  const candidate = financeContract.createCandidateAutomationPolicyV1(1);
  const automationPolicy = financeContract.parseFinanceAutomationPolicyV1({
    ...candidate,
    connectorHealth: {
      ...candidate.connectorHealth,
      enabled: true,
    },
  });
  const request = {
    contractVersion: "1.0",
    jobKind: "connectorHealth",
    connectorRef: "service-connector",
    scheduledFor: "2026-08-10T13:00:00Z",
    evaluatedAt: "2026-08-10T13:00:00Z",
    observation: {
      observedAt: "2026-08-10T12:59:00Z",
      state: "unavailable",
      lastSuccessfulSyncAt: "2026-08-10T12:00:00Z",
      consecutiveFailures: 3,
      bridgeContractVersion: "bridge-v1",
    },
    automationPolicy,
  };
  const firstResponse = await insightRequest("/automation/jobs", {
    method: "POST",
    body: JSON.stringify(request),
  });
  assert.equal(firstResponse.status, 200);
  const first = financeContract.parseFinanceAutomationJobResultV1(
    await firstResponse.json()
  );
  assert.equal(first.replayed, false);
  assert.equal(first.deliveries.length, 1);
  assert.equal(first.deliveries[0].target, "notification");
  assert.equal(first.deliveries[0].signal.attention, "actionable");

  const acknowledgement = await insightRequest(
    "/automation/deliveries/ack",
    {
      method: "POST",
      body: JSON.stringify({
        contractVersion: "1.0",
        acknowledgedAt: "2026-08-10T13:01:00Z",
        deliveries: [{
          deliveryKey: first.deliveries[0].deliveryKey,
          expectedVersion: first.deliveries[0].version,
        }],
      }),
    }
  );
  assert.equal(acknowledgement.status, 200);
  assert.deepEqual(await acknowledgement.json(), {
    contractVersion: "1.0",
    acknowledged: [first.deliveries[0].deliveryKey],
    conflicts: [],
  });

  const replayResponse = await insightRequest("/automation/jobs", {
    method: "POST",
    body: JSON.stringify(request),
  });
  assert.equal(replayResponse.status, 200);
  const replay = financeContract.parseFinanceAutomationJobResultV1(
    await replayResponse.json()
  );
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.deliveries, []);
});

test("finance insight service publishes detail and enforces action CAS and suppression", async () => {
  const publication = financePublication(2, [
    {
      sourceRef: "invented-large-transaction",
      occurredOn: "2026-08-10",
      amountMinor: -184000,
      merchantName: "Invented Market",
      categoryRef: null,
      accountRef: null,
      isPending: false,
      recurringRef: null,
      tagRefs: [],
    },
  ]);
  const committed = await publishFinanceGeneration(publication);
  assert.equal(committed.status, 200);

  const listed = await insightRequest(
    "/occurrences?kind=largeTransaction&limit=1"
  );
  assert.equal(listed.status, 200);
  const page = await listed.json();
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, null);
  const occurrence = page.items[0];

  const detailResponse = await insightRequest(
    `/occurrences/${occurrence.occurrenceId}`
  );
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json();
  assert.equal(detail.kind, "largeTransaction");
  assert.equal(detail.analysisState, "qualified");

  const staleAction = await insightRequest(
    `/occurrences/${occurrence.occurrenceId}/actions`,
    {
      method: "POST",
      body: JSON.stringify({
        contractVersion: "1.0",
        occurrenceId: occurrence.occurrenceId,
        expectedDeliveryRevision: occurrence.deliveryRevision + 1,
        expectedPolicyVersion: occurrence.provenance.policyVersion,
        idempotencyKey: "service-stale-action-idempotency",
        action: "notUseful",
        reason: "notActionable",
      }),
    }
  );
  assert.equal(staleAction.status, 409);
  assert.equal(
    (await staleAction.json()).error.code,
    "occurrence_revision_conflict"
  );

  const permanent = await insightRequest(
    `/occurrences/${occurrence.occurrenceId}/actions`,
    {
      method: "POST",
      body: JSON.stringify({
        contractVersion: "1.0",
        occurrenceId: occurrence.occurrenceId,
        expectedDeliveryRevision: occurrence.deliveryRevision,
        expectedPolicyVersion: occurrence.provenance.policyVersion,
        idempotencyKey: "service-permanent-suppression",
        action: "suppress",
        confirm: true,
        scope: "occurrence",
        durationDays: 365,
        reason: "temporaryHouseholdChange",
      }),
    }
  );
  assert.equal(permanent.status, 400);
  assert.equal((await permanent.json()).error.code, "invalid_request");

  for (const durationDays of [30, 90, 180]) {
    const suppressed = await insightRequest(
      `/occurrences/${occurrence.occurrenceId}/actions`,
      {
        method: "POST",
        body: JSON.stringify({
          contractVersion: "1.0",
          occurrenceId: occurrence.occurrenceId,
          expectedDeliveryRevision: occurrence.deliveryRevision,
          expectedPolicyVersion: occurrence.provenance.policyVersion,
          idempotencyKey: `service-suppression-${durationDays}-days`,
          action: "suppress",
          confirm: true,
          scope: "occurrence",
          durationDays,
          reason: "temporaryHouseholdChange",
        }),
      }
    );
    assert.equal(suppressed.status, 200);
    const suppression = await suppressed.json();
    const suppressedDetail = await (
      await insightRequest(`/occurrences/${occurrence.occurrenceId}`)
    ).json();
    assert.equal(suppressedDetail.suppression.durationDays, durationDays);
    assert.equal(
      suppressedDetail.suppression.operator,
      "fixedLocalOperator"
    );
    assert.equal(
      Date.parse(suppressedDetail.suppression.expiresAt) -
        Date.parse(suppressedDetail.suppression.createdAt),
      durationDays * 24 * 60 * 60 * 1_000
    );

    const undo = await insightRequest(
      `/occurrences/${occurrence.occurrenceId}/actions`,
      {
        method: "POST",
        body: JSON.stringify({
          contractVersion: "1.0",
          occurrenceId: occurrence.occurrenceId,
          expectedDeliveryRevision: occurrence.deliveryRevision,
          expectedPolicyVersion: occurrence.provenance.policyVersion,
          idempotencyKey: `service-undo-suppression-${durationDays}-days`,
          action: "undoSuppression",
          suppressionId: suppression.suppressionId,
          confirm: true,
        }),
      }
    );
    assert.equal(undo.status, 200);
    assert.equal((await undo.json()).action, "undoSuppression");
  }
});

test("finance insight evaluation claims return bounded Retry-After", async () => {
  const store = new financeContract.FinanceInsightSqliteStoreV1({
    path: financeInsightStorePath,
    cursorChecksumNamespace: Buffer.from(
      "tyrion/finance-insight/cursor-checksum/v1",
      "utf8"
    ),
  });
  const lifecycle = new financeContract.FinanceInsightLifecycleServiceV1({
    store,
    householdScope: "homelab-household",
    detectorSetVersion: "detectors-v1",
  });
  const request = {
    contractVersion: "1.0",
    connectorRef: "service-connector",
    sourceGeneration: "service-generation-2",
    detectorSetVersion: "detectors-v1",
    expectedPolicyVersion: 1,
    idempotencyKey: "service-held-evaluation",
  };
  const queued = await lifecycle.retryEvaluation(request);
  await lifecycle.claimEvaluation(queued.assignment);
  try {
    const response = await insightRequest("/evaluations", {
      method: "POST",
      body: JSON.stringify({
        ...request,
        idempotencyKey: "service-concurrent-evaluation",
      }),
    });
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    assert.equal(
      (await response.json()).error.code,
      "evaluation_in_progress"
    );
  } finally {
    await lifecycle.completeEvaluation(queued.assignment, {
      state: "failed",
      completedAt: new Date().toISOString(),
    });
    store.close();
  }
});

test("finance insight occurrence cursors bind a stable filtered snapshot", async () => {
  const transaction = (sourceRef, amountMinor) => ({
    sourceRef,
    occurredOn: "2026-08-10",
    amountMinor,
    merchantName: `Invented ${sourceRef}`,
    categoryRef: null,
    accountRef: null,
    isPending: false,
    recurringRef: null,
    tagRefs: [],
  });
  assert.equal(
    (
      await publishFinanceGeneration(
        financePublication(3, [
          transaction("snapshot-alpha", -150000),
          transaction("snapshot-beta", -160000),
        ])
      )
    ).status,
    200
  );
  const first = await (
    await insightRequest("/occurrences?kind=largeTransaction&limit=1")
  ).json();
  assert.equal(first.items.length, 1);
  assert.equal(typeof first.nextCursor, "string");

  assert.equal(
    (
      await publishFinanceGeneration(
        financePublication(4, [
          transaction("snapshot-alpha", -150000),
          transaction("snapshot-beta", -160000),
          transaction("snapshot-gamma", -170000),
        ])
      )
    ).status,
    200
  );
  const second = await (
    await insightRequest(
      `/occurrences?kind=largeTransaction&limit=1&cursor=${encodeURIComponent(
        first.nextCursor
      )}`
    )
  ).json();
  assert.equal(second.items.length, 1);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([
      first.items[0].occurrenceId,
      second.items[0].occurrenceId,
    ]).size,
    2
  );

  const rebound = await insightRequest(
    `/occurrences?kind=largeTransaction&severity=high&limit=1&cursor=${encodeURIComponent(
      first.nextCursor
    )}`
  );
  assert.equal(rebound.status, 400);
  assert.equal((await rebound.json()).error.code, "invalid_cursor");
});

test("finance insight analysis filters can return nonqualified occurrences", async () => {
  const transactions = [
    ["alpha", "2026-08-10", -90000],
    ["beta", "2026-08-10", -90000],
    ["baseline", "2026-07-10", -90000],
  ].map(([suffix, occurredOn, amountMinor]) => ({
    sourceRef: `nonqualified-${suffix}`,
    occurredOn,
    amountMinor,
    merchantName: "Invented Baseline-Free Merchant",
    categoryRef: "invented-baseline-free-category",
    accountRef: null,
    isPending: false,
    recurringRef: null,
    tagRefs: [],
  }));
  assert.equal(
    (await publishFinanceGeneration(financePublication(5, transactions))).status,
    200
  );

  const response = await insightRequest(
    "/occurrences?analysisState=insufficientBaseline&limit=10"
  );
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.ok(page.items.length > 0);
  assert.ok(
    page.items.every(
      (item) =>
        item.analysisState === "insufficientBaseline" &&
        item.sourceLifecycle === null
    )
  );
});

test("finance insight service publishes current and generation-addressed OWL projections", async () => {
  const publication = financePublication(6, [], {
    account: [
      { sourceRef: "card-a", accountType: "credit", active: true },
      { sourceRef: "card-b", accountType: "credit", active: true },
      { sourceRef: "cash-a", accountType: "cash", active: true },
    ],
    recurring: [
      {
        sourceRef: "utility-a",
        displayName: "Invented Utility",
        amountMinor: -12345,
        cadence: "monthly",
        nextDate: "2026-09-01",
        categoryRef: null,
        accountRef: "card-a",
        active: true,
      },
      {
        sourceRef: "income-a",
        displayName: "Invented Payroll",
        amountMinor: 500000,
        cadence: "biweekly",
        nextDate: "2026-09-04",
        categoryRef: null,
        accountRef: "card-a",
        active: true,
      },
    ],
  });
  assert.equal((await publishFinanceGeneration(publication)).status, 200);

  const response = await insightRequest(
    `/document-expectation-signals/${publication.request.sourceGeneration}?connectorRef=${publication.request.connectorRef}`
  );
  assert.equal(response.status, 200);
  const projection = financeContract.parseDocumentExpectationSignalsV1(
    await response.json()
  );
  assert.equal(projection.contractVersion, "1");
  assert.equal(projection.sourceGeneration, publication.request.sourceGeneration);
  assert.equal(projection.completeness, "complete");
  assert.equal(projection.signals.length, 3);
  assert.equal(
    projection.signals.filter(
      (signal) => signal.kind === "accountStatementCandidate"
    ).length,
    2
  );
  assert.equal(
    projection.signals.filter(
      (signal) => signal.kind === "recurringDocumentCandidate"
    ).length,
    1
  );
  assert.ok(
    projection.signals.every(
      (signal) =>
        signal.cadence === null &&
        signal.nextExpectedDate === null &&
        !JSON.stringify(signal).includes("card-") &&
        !JSON.stringify(signal).includes("Invented Utility")
    )
  );
  assert.equal(
    projection.signals.find(
      (signal) => signal.kind === "recurringDocumentCandidate"
    )?.displayHint,
    "Recurring expense"
  );

  const connectorPath =
    `/api/connector/v1/document-expectation-signals/${publication.request.sourceGeneration}` +
    `?connectorRef=${publication.request.connectorRef}`;
  const beforeConnectorRead = receivedRequests.length;
  const publicResponse = await fetch(`${uiUrl}${connectorPath}`, {
    headers: insightHeaders({ Host: undefined }),
  });
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await publicResponse.json(), projection);
  assert.equal(receivedRequests.length, beforeConnectorRead);

  const currentConnectorPath =
    "/api/connector/v1/document-expectation-signals" +
    `?connectorRef=${publication.request.connectorRef}`;
  const currentResponse = await fetch(`${uiUrl}${currentConnectorPath}`, {
    headers: insightHeaders({ Host: undefined }),
  });
  assert.equal(currentResponse.status, 200);
  assert.equal(currentResponse.headers.get("cache-control"), "no-store");
  assert.deepEqual(await currentResponse.json(), projection);
  assert.equal(receivedRequests.length, beforeConnectorRead);

  for (const [options, status, code] of [
    [{}, 401, "connector_auth_required"],
    [
      {
        headers: insightHeaders({
          Host: undefined,
          Origin: "https://owl.example.invalid",
        }),
      },
      403,
      "browser_request_rejected",
    ],
    [
      {
        method: "POST",
        headers: insightHeaders({ Host: undefined }),
      },
      405,
      "method_not_allowed",
    ],
  ]) {
    const rejected = await fetch(`${uiUrl}${connectorPath}`, options);
    assert.equal(rejected.status, status);
    assert.equal((await rejected.json()).error.code, code);
    assert.equal(receivedRequests.length, beforeConnectorRead);
  }

  const invalidPublicQuery = await fetch(
    `${uiUrl}/api/connector/v1/document-expectation-signals/${publication.request.sourceGeneration}`,
    { headers: insightHeaders({ Host: undefined }) }
  );
  assert.equal(invalidPublicQuery.status, 400);
  assert.equal((await invalidPublicQuery.json()).error.code, "invalid_filter");
  const invalidCurrentQuery = await fetch(
    `${uiUrl}/api/connector/v1/document-expectation-signals`,
    { headers: insightHeaders({ Host: undefined }) }
  );
  assert.equal(invalidCurrentQuery.status, 400);
  assert.equal((await invalidCurrentQuery.json()).error.code, "invalid_filter");
  const missingCurrentGeneration = await fetch(
    `${uiUrl}/api/connector/v1/document-expectation-signals?connectorRef=missing-connector`,
    { headers: insightHeaders({ Host: undefined }) }
  );
  assert.equal(missingCurrentGeneration.status, 404);
  assert.equal(
    (await missingCurrentGeneration.json()).error.code,
    "source_generation_not_found"
  );
  const missingPublicGeneration = await fetch(
    `${uiUrl}/api/connector/v1/document-expectation-signals/missing-generation?connectorRef=${publication.request.connectorRef}`,
    { headers: insightHeaders({ Host: undefined }) }
  );
  assert.equal(missingPublicGeneration.status, 404);
  assert.equal(
    (await missingPublicGeneration.json()).error.code,
    "source_generation_not_found"
  );

  const replay = await insightRequest(
    `/document-expectation-signals/${publication.request.sourceGeneration}?connectorRef=${publication.request.connectorRef}`
  );
  assert.deepEqual(await replay.json(), projection);
  assert.equal(
    (
      await insightRequest(
        `/document-expectation-signals/${publication.request.sourceGeneration}`
      )
    ).status,
    400
  );
  const missing = await insightRequest(
    `/document-expectation-signals/missing-generation?connectorRef=${publication.request.connectorRef}`
  );
  assert.equal(missing.status, 404);
  assert.equal(
    (await missing.json()).error.code,
    "source_generation_not_found"
  );

  const maximumPublication = financePublication(7, [], {
    account: Array.from({ length: 1000 }, (_, index) => ({
      sourceRef: `bounded-account-${index}`,
      accountType: "credit",
      active: true,
    })),
    recurring: Array.from({ length: 5000 }, (_, index) => ({
      sourceRef: `bounded-recurring-${index}`,
      displayName: `Private recurring name ${index}`,
      amountMinor: -100,
      cadence: "monthly",
      nextDate: null,
      categoryRef: null,
      accountRef: null,
      active: true,
    })),
  });
  assert.equal((await publishFinanceGeneration(maximumPublication)).status, 200);
  const maximumResponse = await insightRequest(
    `/document-expectation-signals/${maximumPublication.request.sourceGeneration}?connectorRef=${maximumPublication.request.connectorRef}`
  );
  assert.equal(maximumResponse.status, 200);
  const maximumProjection = await maximumResponse.json();
  assert.equal(maximumProjection.signals.length, 6000);
  const currentMaximumResponse = await fetch(
    `${uiUrl}/api/connector/v1/document-expectation-signals` +
      `?connectorRef=${maximumPublication.request.connectorRef}`,
    { headers: insightHeaders({ Host: undefined }) }
  );
  assert.equal(currentMaximumResponse.status, 200);
  const currentMaximumProjection = await currentMaximumResponse.json();
  assert.equal(
    currentMaximumProjection.sourceGeneration,
    maximumPublication.request.sourceGeneration
  );
  assert.deepEqual(currentMaximumProjection, maximumProjection);
  assert.ok(Buffer.byteLength(JSON.stringify(maximumProjection), "utf8") > 512 * 1024);
  assert.ok(
    maximumProjection.signals.every(
      (signal) => !signal.displayHint.startsWith("Private recurring name")
    )
  );
});

test("finance insight HTTP bounds and filters fail without unexpected 500", async () => {
  const oversized = await insightRequest("/source-generations", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(256 * 1024) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "payload_too_large");

  for (const query of [
    "?unknown=value",
    "?limit=0",
    "?connectorRef=one&connectorRef=two",
    "?kind=largeTransaction&kind=largeTransaction",
    "?cursor=",
  ]) {
    const response = await insightRequest(`/occurrences${query}`);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "invalid_filter");
  }

  const missing = await insightRequest(
    "/occurrences/occurrence-v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "occurrence_not_found");

  const health = await fetch(`${uiUrl}/api/health`);
  const body = JSON.stringify(await health.json());
  assert.doesNotMatch(
    body,
    /service-connector|invented-large-transaction|Invented Market|184000|sqlite|token|path/i
  );
});

test("finance insight rollout gates fail closed and health remains metadata-only", async () => {
  const port = await freePort();
  const disabledUrl = `http://127.0.0.1:${port}`;
  const disabledProcess = spawn(process.execPath, [standaloneServer], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      BRIDGE_URL: fakeBridgeUrl,
      BRIDGE_API_TOKEN: serviceToken,
      TYRION_POLICY_STORE_PATH: policyStorePath,
      TYRION_FINANCE_INSIGHT_STORE_PATH: resolve(
        temporaryStateDirectory,
        "finance-insights-disabled.sqlite"
      ),
      TYRION_FINANCE_INSIGHT_EVALUATION_WRITE_ENABLED: "false",
      TYRION_FINANCE_INSIGHT_READ_ENABLED: "false",
      TYRION_FINANCE_INSIGHT_ACTIONS_ENABLED: "false",
      TYRION_FINANCE_AUTOMATION_WRITE_ENABLED: "false",
      TYRION_FINANCE_INSIGHT_TEST_ONLY_NOW: "2026-08-11T14:00:00Z",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: "ignore",
  });
  try {
    await waitForServer(disabledUrl, disabledProcess);
    const initializedStore = new financeContract.FinanceInsightSqliteStoreV1({
      path: resolve(
        temporaryStateDirectory,
        "finance-insights-disabled.sqlite"
      ),
      cursorChecksumNamespace: Buffer.from(
        "tyrion/finance-insight/cursor-checksum/v1",
        "utf8"
      ),
    });
    try {
      assert.deepEqual(
        (await initializedStore.policies.current()),
        financeContract.createCandidatePolicySnapshotV1({
          policyVersion: 2,
          effectiveAt: "1970-01-02T00:00:00.000Z",
          currency: "USD",
          timezone: "America/New_York",
        })
      );
      assert.equal((await initializedStore.policies.find(1))?.policyVersion, 1);
    } finally {
      initializedStore.close();
    }
    for (const [path, options] of [
      ["/source-generations", { method: "POST", body: "{}" }],
      ["/occurrences", {}],
      ["/occurrences/disabled/actions", { method: "POST", body: "{}" }],
      ["/automation/jobs", { method: "POST", body: "{}" }],
    ]) {
      const response = await insightRequest(path, options, disabledUrl);
      assert.equal(response.status, 503);
      assert.equal(
        (await response.json()).error.code,
        "insight_service_not_configured"
      );
    }
    const health = await (await fetch(`${disabledUrl}/api/health`)).json();
    assert.deepEqual(health.financeInsights, {
      status: "disabled",
      telemetry: {
        evaluationStartedCount: 0,
        evaluationCompletedCount: 0,
        evaluationFailedCount: 0,
        automationStartedCount: 0,
        automationCompletedCount: 0,
        automationRejectedCount: 0,
        automationFailedCount: 0,
      },
    });
    assert.doesNotMatch(
      JSON.stringify(health),
      /invented-disabled|sqlite|cursor|identity|service-token/i
    );
  } finally {
    await stopProcess(disabledProcess);
  }
});

test("finance insight startup preserves an existing policy history", async () => {
  const store = new financeContract.FinanceInsightSqliteStoreV1({
    path: financeInsightStorePath,
    cursorChecksumNamespace: Buffer.from(
      "tyrion/finance-insight/cursor-checksum/v1",
      "utf8"
    ),
    clock: () => "2026-08-11T14:00:00.000Z",
  });
  try {
    assert.equal((await store.policies.current())?.policyVersion, 1);
    assert.equal(
      (await store.policies.current())?.featureGates.confirmedActions,
      true
    );
    assert.equal(await store.policies.find(2), null);
  } finally {
    store.close();
  }
});

test("finance insight startup preserves a future-effective v2-only history", async () => {
  const storePath = resolve(
    temporaryStateDirectory,
    "finance-insights-v2-only.sqlite"
  );
  const store = new financeContract.FinanceInsightSqliteStoreV1({
    path: storePath,
    cursorChecksumNamespace: Buffer.from(
      "tyrion/finance-insight/cursor-checksum/v1",
      "utf8"
    ),
    clock: () => "2026-08-11T14:00:00.000Z",
  });
  const first = financeContract.createCandidatePolicySnapshotV1({
    policyVersion: 1,
    effectiveAt: "2030-01-01T00:00:00.000Z",
    currency: "USD",
    timezone: "America/New_York",
  });
  const second = financeContract.createCandidatePolicySnapshotV1({
    policyVersion: 2,
    effectiveAt: "2030-01-02T00:00:00.000Z",
    currency: "USD",
    timezone: "America/New_York",
  });
  await store.policies.append(first);
  await store.policies.append(second);
  store.close();

  const database = new Database(storePath);
  database
    .prepare(
      "DELETE FROM finance_insight_policy_snapshots WHERE policy_version = 1"
    )
    .run();
  database.close();

  const port = await freePort();
  const serverUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, [standaloneServer], {
    cwd: standaloneRoot,
    env: {
      ...process.env,
      BRIDGE_URL: fakeBridgeUrl,
      BRIDGE_API_TOKEN: serviceToken,
      TYRION_POLICY_STORE_PATH: policyStorePath,
      TYRION_FINANCE_INSIGHT_STORE_PATH: storePath,
      TYRION_FINANCE_INSIGHT_EVALUATION_WRITE_ENABLED: "false",
      TYRION_FINANCE_INSIGHT_READ_ENABLED: "false",
      TYRION_FINANCE_INSIGHT_ACTIONS_ENABLED: "false",
      TYRION_FINANCE_AUTOMATION_WRITE_ENABLED: "false",
      TYRION_FINANCE_INSIGHT_TEST_ONLY_NOW: "2026-08-11T14:00:00Z",
      HOSTNAME: "127.0.0.1",
      PORT: String(port),
    },
    stdio: "ignore",
  });
  try {
    await waitForServer(serverUrl, server);
    const health = await (await fetch(`${serverUrl}/api/health`)).json();
    assert.equal(health.financeInsights.status, "disabled");
    const preserved = new financeContract.FinanceInsightSqliteStoreV1({
      path: storePath,
      cursorChecksumNamespace: Buffer.from(
        "tyrion/finance-insight/cursor-checksum/v1",
        "utf8"
      ),
      clock: () => "2026-08-11T14:00:00.000Z",
    });
    try {
      assert.equal(await preserved.policies.current(), null);
      assert.deepEqual(await preserved.policies.latest(), second);
      assert.equal(await preserved.policies.find(1), null);
    } finally {
      preserved.close();
    }
  } finally {
    await stopProcess(server);
  }
});

beforeEach(() => {
  receivedRequests = [];
  bridgeResponseMode = "normal";
  bridgePathResponseModes = new Map();
  authState = "connected";
  healthPayloadOverride = undefined;
  authStatusPayloadOverride = undefined;
  expireNextPreview = false;
  reattributionResponseMode = "normal";
  attributionActionRecords = new Map();
  attributionActionReplays = new Map();
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

test("connector authentication is bearer-only, minimum-length, and fail-closed", () => {
  const missingConfiguration = authenticateConnectorRequest(
    `Bearer ${serviceToken}`,
    "too-short"
  );
  assert.equal(missingConfiguration.allowed, false);
  assert.equal(missingConfiguration.status, 503);

  for (const authorization of [
    null,
    serviceToken,
    `bearer ${serviceToken}`,
    "Bearer wrong-synthetic-service-token-value",
    `Bearer ${serviceToken} extra`,
  ]) {
    const result = authenticateConnectorRequest(authorization, serviceToken);
    assert.equal(result.allowed, false);
    assert.equal(result.status, 401);
  }
  assert.deepEqual(
    authenticateConnectorRequest(`Bearer ${serviceToken}`, serviceToken),
    { allowed: true, token: serviceToken }
  );
});

test("connector policy exposes exactly the backend connector operations", () => {
  const allowed = [
    ["GET", "contract"],
    ["GET", "health"],
    ["GET", "transactions"],
    ["GET", "transactions/invented-transaction"],
    ["GET", "transactions/invented-transaction/splits"],
    ["PATCH", "transactions/invented-transaction/category"],
    ["GET", "accounts"],
    ["GET", "category-groups"],
    ["GET", "categories"],
    ["GET", "tags"],
    ["GET", "recurring"],
    ["GET", "budgets"],
    ["GET", "document-expectation-signals"],
    ["GET", "document-expectation-signals/invented-generation"],
    ["POST", "sync"],
  ];
  for (const [method, path] of allowed) {
    const result = evaluateConnectorRequest(
      method,
      path.split("/"),
      new URLSearchParams()
    );
    assert.equal(result.allowed, true, `${method} ${path}`);
  }
  assert.equal(
    evaluateConnectorRequest(
      "GET",
      ["document-expectation-signals", "invented-generation"],
      new URLSearchParams("connectorRef=invented-connector")
    ).target,
    "finance-insight"
  );

  for (const [method, path] of allowed) {
    const wrongMethod = method === "GET" ? "POST" : "GET";
    const result = evaluateConnectorRequest(
      wrongMethod,
      path.split("/"),
      new URLSearchParams()
    );
    assert.equal(result.allowed, false, `${wrongMethod} ${path}`);
    assert.equal(result.status, 405);
  }

  for (const path of [
    "auth/status",
    "auth/login",
    "auth/login-with-cookies",
    "auth/logout",
    "cashflow",
    "openapi.json",
    "api/internal/v2/attribution/batch",
    "unknown",
    "transactions/invented-transaction/unknown",
  ]) {
    const result = evaluateConnectorRequest(
      "GET",
      path.split("/"),
      new URLSearchParams()
    );
    assert.equal(result.allowed, false, path);
    assert.equal(result.status, 404);
  }
});

test("connector policy strictly bounds and canonicalizes transaction queries", () => {
  const validQuery = new URLSearchParams([
    ["start_date", "2026-01-01"],
    ["end_date", "2026-12-31"],
    ["account_id", " invented-account "],
    ["category_id", "invented-category"],
    ["merchant_query", "  Invented   Merchant "],
    ["tag_id", "invented-tag-one"],
    ["tag_id", "invented-tag-two"],
    ["min_amount", "-999999999.99"],
    ["max_amount", "999999999.99"],
    ["is_pending", "false"],
    ["is_recurring", "true"],
    ["limit", "500"],
    ["cursor", "NTAw"],
  ]);
  const valid = evaluateConnectorRequest("GET", ["transactions"], validQuery);
  assert.equal(valid.allowed, true);
  const upstream = new URL(valid.upstreamPath, "http://bridge.invalid");
  assert.equal(upstream.searchParams.get("account_id"), "invented-account");
  assert.equal(upstream.searchParams.get("merchant_query"), "Invented Merchant");
  assert.deepEqual(upstream.searchParams.getAll("tag_id"), [
    "invented-tag-one",
    "invented-tag-two",
  ]);

  const invalidQueries = [
    "unknown=value",
    "limit=0",
    "limit=501",
    "limit=1&limit=2",
    "start_date=2026-02-30",
    "start_date=2025-01-01&end_date=2026-01-02",
    "start_date=2026-02-02&end_date=2026-02-01",
    "account_id=",
    `category_id=${"x".repeat(513)}`,
    "merchant_query=%20%20",
    `merchant_query=${"x".repeat(121)}`,
    Array.from({ length: 21 }, (_, index) => `tag_id=tag-${index}`).join("&"),
    "min_amount=1.001",
    "max_amount=1000000000",
    "min_amount=2&max_amount=1",
    "is_pending=1",
    "is_recurring=True",
    `cursor=${"x".repeat(129)}`,
  ];
  for (const query of invalidQueries) {
    const result = evaluateConnectorRequest(
      "GET",
      ["transactions"],
      new URLSearchParams(query)
    );
    assert.equal(result.allowed, false, query);
    assert.equal(result.status, 422);
  }
});

test("connector policy bounds sync, identifiers, category bodies, and bridge URLs", () => {
  assert.equal(
    evaluateConnectorRequest(
      "POST",
      ["sync"],
      new URLSearchParams("days=365")
    ).upstreamPath,
    "/sync?days=365"
  );
  for (const query of ["days=0", "days=366", "days=1.5", "days=1&days=2", "x=1"]) {
    assert.equal(
      evaluateConnectorRequest(
        "POST",
        ["sync"],
        new URLSearchParams(query)
      ).allowed,
      false
    );
  }
  for (const path of [
    ["transactions", ""],
    ["transactions", " x "],
    ["transactions", "x".repeat(513)],
  ]) {
    assert.equal(
      evaluateConnectorRequest("GET", path, new URLSearchParams()).allowed,
      false
    );
  }

  assert.deepEqual(parseCategoryMutation({ categoryId: " invented-category " }), {
    allowed: true,
    body: '{"categoryId":"invented-category"}',
  });
  for (const body of [
    null,
    [],
    {},
    { categoryId: "" },
    { categoryId: "x".repeat(513) },
    { categoryId: "invented", extra: true },
  ]) {
    assert.equal(parseCategoryMutation(body).allowed, false);
  }

  assert.equal(resolveConnectorBridgeUrl("http://bridge:8100").configured, true);
  for (const url of [
    undefined,
    "file:///private",
    "http://user:password@bridge:8100",
    "http://bridge:8100/private",
    "http://bridge:8100/?query=value",
  ]) {
    assert.equal(resolveConnectorBridgeUrl(url).configured, false);
  }
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

test("reconnect recovery requires connected auth and a successful bounded sync", () => {
  assert.equal(reconnectPhase("checking", false), "checking");
  assert.equal(reconnectPhase("unavailable", false), "unavailable");
  for (const state of ["unauthenticated", "expired", "degraded"]) {
    assert.equal(reconnectPhase(state, false), "authentication-required");
  }
  assert.equal(reconnectPhase("connected", false), "sync-required");
  assert.equal(reconnectPhase("connected", true), "recovered");
  assert.notEqual(reconnectPhase("expired", true), "recovered");
});

test("Mission Control recovery accepts only a fixed entry marker and server allowlist", () => {
  assert.equal(isMissionControlRecoveryEntry("?source=mission-control"), true);
  assert.equal(isMissionControlRecoveryEntry("?source=mission-control&source=other"), false);
  assert.equal(
    isMissionControlRecoveryEntry(
      "?source=mission-control&returnUrl=https%3A%2F%2Fevil.example"
    ),
    false
  );

  assert.deepEqual(
    resolveMissionControlHandoff(
      "https://mission-control.example.invalid/finance/settings",
      "https://mission-control.example.invalid"
    ),
    {
      available: true,
      returnUrl: "https://mission-control.example.invalid/finance/settings",
    }
  );
  for (const [url, origins] of [
    ["http://mission-control.example.invalid/finance/settings", "http://mission-control.example.invalid"],
    ["https://evil.example/finance/settings", "https://mission-control.example.invalid"],
    ["https://mission-control.example.invalid/finance/settings?token=value", "https://mission-control.example.invalid"],
    ["https://mission-control.example.invalid/finance/settings#return", "https://mission-control.example.invalid"],
    ["https://user:password@mission-control.example.invalid/finance/settings", "https://mission-control.example.invalid"],
    ["https://mission-control.example.invalid/finance/settings", "https://mission-control.example.invalid/path"],
  ]) {
    assert.deepEqual(resolveMissionControlHandoff(url, origins), {
      available: false,
    });
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

test("recovery handoff returns only the fixed server-allowlisted destination", async () => {
  const response = await fetch(
    `${uiUrl}/api/recovery-handoff?returnUrl=https%3A%2F%2Fevil.example`
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    available: true,
    returnUrl: "https://mission-control.example.invalid/finance/settings",
  });
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

test("public connector gateway forwards every allowlisted operation with caller auth", async () => {
  const requests = [
    ["GET", "/api/connector/v1/contract"],
    ["GET", "/api/connector/v1/health"],
    ["GET", "/api/connector/v1/transactions?limit=25&tag_id=invented-tag"],
    ["GET", "/api/connector/v1/transactions/invented-transaction"],
    ["GET", "/api/connector/v1/transactions/invented-transaction/splits"],
    ["GET", "/api/connector/v1/accounts"],
    ["GET", "/api/connector/v1/category-groups"],
    ["GET", "/api/connector/v1/categories"],
    ["GET", "/api/connector/v1/tags"],
    ["GET", "/api/connector/v1/recurring"],
    ["GET", "/api/connector/v1/budgets"],
    ["POST", "/api/connector/v1/sync?days=365"],
    [
      "PATCH",
      "/api/connector/v1/transactions/invented-transaction/category",
      { categoryId: "invented-category" },
    ],
  ];

  for (const [method, path, body] of requests) {
    const response = await fetch(`${uiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.status, 200, `${method} ${path}`);
    assert.equal(response.headers.get("x-monarch-contract-version"), "1.0");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(receivedRequests.at(-1).authorized, true);
  }
  assert.equal(
    receivedRequests.at(-1).body,
    '{"categoryId":"invented-category"}'
  );
});

test("connector health derives connected, unauthenticated, expired, and transient degraded states", async () => {
  for (const state of [
    "connected",
    "unauthenticated",
    "expired",
    "degraded",
  ]) {
    authState = state;
    const response = await fetch(`${uiUrl}/api/connector/v1/health`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    assert.equal(response.status, 200, state);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-monarch-contract-version"), "1.0");
    assert.deepEqual(await response.json(), {
      contractVersion: "1.0",
      status: state === "connected" || state === "unauthenticated" ? "ok" : "degraded",
      mode: "live",
      reachable: true,
      authenticated: state === "connected",
      authState: state,
    });
  }
});

test("connector health repairs restart-stale state from one live verification", async () => {
  healthPayloadOverride = {
    contractVersion: "1.0",
    status: "degraded",
    mode: "demo",
    reachable: true,
    authenticated: false,
    authState: "degraded",
  };
  authStatusPayloadOverride = {
    contractVersion: "1.0",
    authenticated: true,
    authState: "connected",
    email: "invented@example.invalid",
    mode: "live",
  };

  const response = await fetch(`${uiUrl}/api/connector/v1/health`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    contractVersion: "1.0",
    status: "ok",
    mode: "live",
    reachable: true,
    authenticated: true,
    authState: "connected",
  });
  assert.deepEqual(
    receivedRequests.map(({ path, method, authorized, hasBody }) => ({
      path,
      method,
      authorized,
      hasBody,
    })),
    [
      {
        path: "/auth/status",
        method: "GET",
        authorized: true,
        hasBody: false,
      },
    ]
  );
});

test("connector health fails closed for each invalid auth-status response", async () => {
  const cases = [
    ["non-2xx", 502, "bridge_health_check_failed"],
    ["non-json", 502, "invalid_bridge_response"],
    ["malformed-json", 502, "invalid_bridge_response"],
    ["oversized", 502, "invalid_bridge_response"],
    ["malformed-shape", 502, "invalid_bridge_response"],
    ["mismatched-version", 502, "bridge_contract_mismatch"],
    ["network", 502, "bridge_unavailable"],
  ];
  for (const [mode, status, code] of cases) {
    bridgePathResponseModes.set("/auth/status", mode);
    const response = await fetch(`${uiUrl}/api/connector/v1/health`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    assert.equal(response.status, status, mode);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-monarch-contract-version"), "1.0");
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), {
      contractVersion: "1.0",
      error: {
        code,
        message:
          code === "bridge_health_check_failed"
            ? "Bridge health check failed"
            : code === "bridge_contract_mismatch"
              ? "Bridge contract version is incompatible"
              : code === "bridge_unavailable"
                ? "Bridge unavailable"
                : "Bridge returned an invalid response",
      },
    });
    assert.doesNotMatch(
      text,
      /synthetic upstream detail|ECONN|127\.0\.0\.1|invented@example/
    );
    bridgePathResponseModes.clear();
  }
});

test("connector health bounds the private verification response", async () => {
  bridgePathResponseModes.set("/auth/status", "oversized");
  const response = await fetch(`${uiUrl}/api/connector/v1/health`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "invalid_bridge_response");
});

test("connector health maps bounded timeouts without leaking failures", async () => {
  const calls = [];
  const result = await composeConnectorHealth({
    baseUrl: new URL("https://bridge.invalid/"),
    token: serviceToken,
    timeoutMs: 5,
    fetchImpl: (url, options) => {
      calls.push({
        url: url.href,
        method: options.method,
        authorization: options.headers.get("authorization"),
      });
      return new Promise((resolve, reject) => {
        options.signal.addEventListener("abort", () => reject(new Error("private")));
      });
    },
  });
  assert.deepEqual(result, {
    ok: false,
    status: 504,
    error: {
      code: "bridge_timeout",
      message: "Bridge health check timed out",
    },
  });
  assert.deepEqual(calls, [
    {
      url: "https://bridge.invalid/auth/status",
      method: "GET",
      authorization: `Bearer ${serviceToken}`,
    },
  ]);
});

test("connector gateway requires independent auth and rejects browser use before forwarding", async () => {
  for (const request of [
    {},
    { headers: { Authorization: "Bearer invalid-synthetic-token-value-123456" } },
    {
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        Origin: uiUrl,
        "Sec-Fetch-Site": "same-origin",
      },
    },
  ]) {
    const beforeCount = receivedRequests.length;
    const response = await fetch(
      `${uiUrl}/api/connector/v1/transactions`,
      request
    );
    assert.equal(response.status, request.headers?.Origin ? 403 : 401);
    assert.equal(receivedRequests.length, beforeCount);
    const text = await response.text();
    assert.doesNotMatch(text, new RegExp(serviceToken));
  }

  const uiProxy = await fetch(`${uiUrl}/api/bridge/transactions`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(uiProxy.status, 404);
  assert.equal((await uiProxy.json()).error.code, "bridge_route_not_available");
});

test("connector gateway blocks route, method, query, and body expansion before forwarding", async () => {
  const cases = [
    ["GET", "/api/connector/v1/auth/status"],
    ["POST", "/api/connector/v1/transactions"],
    ["GET", "/api/connector/v1/transactions?unknown=value"],
    ["GET", "/api/connector/v1/accounts?include=private"],
    ["DELETE", "/api/connector/v1/transactions/invented-transaction"],
    ["GET", "/api/connector/v1/unknown"],
    ["GET", "/api/connector/v1/../internal/v1/attribution/batch"],
  ];
  for (const [method, path] of cases) {
    const beforeCount = receivedRequests.length;
    const response = await fetch(`${uiUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    assert.ok([404, 405, 422].includes(response.status), `${method} ${path}`);
    assert.equal(receivedRequests.length, beforeCount);
  }

  for (const body of [
    "not-json",
    JSON.stringify({ categoryId: "" }),
    JSON.stringify({ categoryId: "invented", extra: true }),
  ]) {
    const beforeCount = receivedRequests.length;
    const response = await fetch(
      `${uiUrl}/api/connector/v1/transactions/invented-transaction/category`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${serviceToken}`,
          "Content-Type": "application/json",
        },
        body,
      }
    );
    assert.equal(response.status, 400);
    assert.equal(receivedRequests.length, beforeCount);
  }
});

test("public ingress marker blocks encoded traversal into private API trees", async () => {
  const paths = [
    "/api/connector/v1/%2e%2e/%2e%2e/bridge/auth/logout",
    "/api/connector/v1/%2e%2e/%2e%2e/policy",
    "/api/connector/v1/%2e%2e/%2e%2e/internal/v1/attribution/batch",
  ];
  for (const path of paths) {
    const beforeCount = receivedRequests.length;
    const response = await rawHttpFetch(path, "POST", {
      "X-Tyrion-Public-Connector": "1",
    });
    assert.equal(response.status, 404, path);
    assert.equal(
      (await response.json()).error.code,
      "connector_route_not_available"
    );
    assert.equal(receivedRequests.length, beforeCount);
  }
});

test("connector gateway bounds request and response bodies", async () => {
  const oversizedRequest = await fetch(
    `${uiUrl}/api/connector/v1/transactions/invented-transaction/category`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${serviceToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ categoryId: "x".repeat(2_000) }),
    }
  );
  assert.equal(oversizedRequest.status, 413);
  assert.equal((await oversizedRequest.json()).error.code, "payload_too_large");

  bridgeResponseMode = "oversized";
  const oversizedResponse = await fetch(`${uiUrl}/api/connector/v1/accounts`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(oversizedResponse.status, 502);
  assert.equal(
    (await oversizedResponse.json()).error.code,
    "invalid_bridge_response"
  );
});

test("connector gateway preserves bridge status and safe contract headers", async () => {
  bridgeResponseMode = "rate-limited";
  const response = await fetch(`${uiUrl}/api/connector/v1/transactions`, {
    headers: { Authorization: `Bearer ${serviceToken}` },
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "17");
  assert.equal(response.headers.get("x-monarch-contract-version"), "1.0");
  assert.deepEqual(await response.json(), {
    contractVersion: "1.0",
    error: { code: "upstream_rate_limited", message: "Retry later" },
  });
});

test("connector gateway sanitizes invalid and network bridge failures", async () => {
  for (const mode of ["invalid", "network"]) {
    bridgeResponseMode = mode;
    const response = await fetch(`${uiUrl}/api/connector/v1/accounts`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    assert.equal(response.status, 502);
    const text = await response.text();
    assert.doesNotMatch(text, /synthetic upstream detail|ECONN|127\.0\.0\.1/);
    assert.match(text, /invalid_bridge_response|bridge_unavailable/);
  }
});

test("policy API uses a fixed trusted-homelab identity", async () => {
  const missing = await fetch(`${uiUrl}/api/policy`);
  assert.equal(missing.status, 200);
  const payload = await missing.json();
  assert.equal(payload.policy, null);
  assert.deepEqual(payload.capabilities, {
    write: true,
    previewReattribution: true,
    applyReattribution: true,
  });

  const spoofed = await fetch(`${uiUrl}/api/policy`, {
    headers: {
      "x-tyrion-actor": "untrusted-actor",
      "x-tyrion-household": "untrusted-household",
      "x-tyrion-permissions": "",
    },
  });
  assert.equal(spoofed.status, 200);
  assert.equal((await spoofed.json()).policy, null);
});

test("policy remains independent while attribution fails closed without its bearer credential", async () => {
  const standaloneRoot = join(appRoot, ".next", "standalone", "triage-app");
  const standaloneServer = join(standaloneRoot, "server.js");
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  let processWithoutBackendCredential;
  try {
    processWithoutBackendCredential = spawn(
      process.execPath,
      [standaloneServer],
      {
        cwd: standaloneRoot,
        env: {
          ...process.env,
          BRIDGE_URL: fakeBridgeUrl,
          BRIDGE_API_TOKEN: "",
          TYRION_POLICY_STORE_PATH: resolve(
            temporaryStateDirectory,
            "missing-token-policies.json"
          ),
          HOSTNAME: "127.0.0.1",
          PORT: String(port),
        },
        stdio: "ignore",
      }
    );
    await waitForServer(url, processWithoutBackendCredential);
    const response = await fetch(`${url}/api/policy`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).policy, null);
    const attribution = await rawAttributionFetch(url, "{}", {
      Authorization: ["Bearer", serviceToken].join(" "),
    });
    assert.equal(attribution.status, 503);
    assert.equal(
      (await attribution.json()).error.code,
      "attribution_auth_not_configured"
    );
    const connector = await fetch(`${url}/api/connector/v1/health`, {
      headers: { Authorization: `Bearer ${serviceToken}` },
    });
    assert.equal(connector.status, 503);
    assert.equal(
      (await connector.json()).error.code,
      "connector_auth_not_configured"
    );
  } finally {
    if (
      processWithoutBackendCredential &&
      processWithoutBackendCredential.exitCode === null
    ) {
      processWithoutBackendCredential.kill();
    }
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
    contractVersion: "2.0",
    provenance: "mission-control-normalized-v2",
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
    /merchantName|accountRef|occurredOn|observedAt|householdId|actorId/
  );
  const payload = JSON.parse(text);
  assert.equal(payload.policyVersion, activePolicy.policyVersion);
  assert.equal(payload.engineVersion, "2.0.0");
  assert.deepEqual(
    payload.results.map((result) => result.sourceRef),
    ["consumer-source-one", "consumer-source-manual"]
  );
  assert.deepEqual(payload.results[0], {
    contractVersion: "2.0",
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
    engineVersion: "2.0.0",
    evaluatedAt: payload.results[0].evaluatedAt,
  });
  assert.match(payload.results[0].evaluatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(payload.results[1].method, "manual");
  assert.equal(payload.results[1].reviewStatus, "resolved");
});

test("batch attribution fails closed for auth, host, body, and policy conflicts", async () => {
  const body = attributionRequest([attributionItem("consumer-auth")]);
  const retired = await rawInternalAttributionFetch(
    uiUrl,
    "/api/internal/v1/attribution/batch",
    JSON.stringify(body),
    { Authorization: ["Bearer", serviceToken].join(" ") }
  );
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).error.code, "contract_version_retired");
  const missing = await rawAttributionFetch(uiUrl, JSON.stringify(body));
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, "attribution_auth_required");

  const invalid = await attributionFetch(body, {
    token: "invalid-attribution-auth-token-value-123456",
  });
  assert.equal(invalid.status, 401);
  assert.equal((await invalid.json()).error.code, "attribution_auth_invalid");

  const publicHost = await attributionFetch(body, {
    requestHeaders: { Host: "tyrion.socko.us" },
  });
  assert.equal(publicHost.status, 404);
  assert.equal(
    (await publicHost.json()).error.code,
    "attribution_route_not_available"
  );

  const malformedPublicHost = await rawAttributionFetch(uiUrl, "not-json", {
    Host: "tyrion.socko.us",
  });
  assert.equal(malformedPublicHost.status, 404);
  assert.equal(
    (await malformedPublicHost.json()).error.code,
    "attribution_route_not_available"
  );

  const oversizedPublicHost = await rawAttributionFetch(
    uiUrl,
    "x".repeat(64 * 1_024 + 1),
    { Host: "tyrion.socko.us" }
  );
  assert.equal(oversizedPublicHost.status, 404);
  assert.equal(
    (await oversizedPublicHost.json()).error.code,
    "attribution_route_not_available"
  );

  const forwardedPublicHost = await attributionFetch(body, {
    requestHeaders: { "x-forwarded-host": "tyrion.socko.us" },
  });
  assert.equal(forwardedPublicHost.status, 404);
  assert.equal(
    (await forwardedPublicHost.json()).error.code,
    "attribution_route_not_available"
  );

  const mixedForwardedHosts = await attributionFetch(body, {
    requestHeaders: {
      "x-forwarded-host": `${internalAttributionHost}, tyrion.socko.us`,
    },
  });
  assert.equal(mixedForwardedHosts.status, 404);
  assert.equal(
    (await mixedForwardedHosts.json()).error.code,
    "attribution_route_not_available"
  );

  const conflict = await attributionFetch({
    ...body,
    expectedPolicyVersion: activePolicy.policyVersion + 1,
    items: [attributionItem("consumer-conflict")],
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "policy_conflict");
});

test("batch attribution rejects private fields and enforces size bounds", async () => {
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

  const oversized = await rawAttributionFetch(
    uiUrl,
    "x".repeat(64 * 1_024 + 1),
    { Authorization: ["Bearer", serviceToken].join(" ") }
  );
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "payload_too_large");
});

test("attribution actions explain bounded corrections and Monarch provenance", async () => {
  const retired = await rawInternalAttributionFetch(
    uiUrl,
    "/api/internal/v1/attribution/actions",
    JSON.stringify(
      attributionActionRequest("consumer-action-retired", "explain")
    ),
    { Authorization: ["Bearer", serviceToken].join(" ") }
  );
  assert.equal(retired.status, 410);
  assert.equal((await retired.json()).error.code, "contract_version_retired");
  const response = await attributionActionFetch(
    attributionActionRequest("consumer-action-explain", "explain")
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.doesNotMatch(
    text,
    /merchantName|accountRef|occurredOn|observedAt|householdId/
  );
  const payload = JSON.parse(text);
  assert.deepEqual(payload.attribution, {
    contractVersion: "2.0",
    sourceRef: "consumer-action-explain",
    status: "pending",
    kidId: "kid-synthetic",
    confidence: "likely",
    method: "merchant-rule",
    explanation: "A configured merchant rule matched.",
    review: { status: "pending", reasons: ["low-confidence"] },
    provenance: {
      decisionSource: "automated",
      policyVersion: activePolicy.policyVersion,
      engineVersion: "2.0.0",
      ruleIds: ["rule-merchant-synthetic"],
      evaluatedAt: "2026-08-08T12:58:00.000Z",
    },
  });
  assert.deepEqual(payload.authoritativeDeepLink, {
    system: "monarch",
    target: "transaction",
    sourceRef: "consumer-action-explain",
  });
  assert.deepEqual(payload.assignableKidIds, ["kid-synthetic"]);
  assert.deepEqual(payload.availableActions, [
    "explain",
    "assign-kid",
    "mark-parent-expense",
    "unassign",
    "resolve-exception",
    "defer-exception",
    "open-in-monarch",
  ]);
});

test("attribution actions apply confirmed corrections with replayable audit state", async () => {
  const sourceRef = "consumer-action-assign";
  const request = attributionActionRequest(sourceRef, "assign-kid", {
    expectedStateVersion: 1,
    idempotencyKey: "consumer-action-assign-v1",
    confirm: true,
    kidId: "kid-synthetic",
  });
  const applied = await attributionActionFetch(request);
  assert.equal(applied.status, 200);
  const payload = await applied.json();
  assert.equal(payload.attribution.status, "attributed");
  assert.equal(payload.attribution.method, "manual");
  assert.equal(payload.exception.status, "resolved");
  assert.deepEqual(payload.audit, {
    actionRef: payload.audit.actionRef,
    idempotencyKey: "consumer-action-assign-v1",
    action: "assign-kid",
    actorId: "mission-control-finance-manager",
    outcome: "applied",
    previousStateVersion: 1,
    stateVersion: 2,
    policyVersion: activePolicy.policyVersion,
    appliedAt: payload.audit.appliedAt,
  });
  assert.match(payload.audit.actionRef, /^[A-Za-z0-9-]+$/);
  assert.match(payload.audit.appliedAt, /^\d{4}-\d{2}-\d{2}T/);

  const replay = await attributionActionFetch(request);
  assert.equal(replay.status, 200);
  assert.deepEqual((await replay.json()).audit, {
    ...payload.audit,
    outcome: "replayed",
  });

  const conflict = await attributionActionFetch({
    ...request,
    kidId: "kid-synthetic-other",
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, "idempotency_conflict");
});

test("attribution actions support parent, unassign, resolve, and defer outcomes", async () => {
  for (const [action, extra, expectedStatus] of [
    ["mark-parent-expense", {}, "resolved"],
    ["unassign", {}, "resolved"],
    ["resolve-exception", {}, "resolved"],
    [
      "defer-exception",
      { deferUntil: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000).toISOString() },
      "deferred",
    ],
  ]) {
    const sourceRef = `consumer-action-${action}`;
    const response = await attributionActionFetch(
      attributionActionRequest(sourceRef, action, {
        expectedStateVersion: 1,
        idempotencyKey: `${sourceRef}-v1`,
        confirm: true,
        ...extra,
      })
    );
    assert.equal(response.status, 200, action);
    const payload = await response.json();
    assert.equal(payload.exception.status, expectedStatus, action);
    assert.equal(payload.audit.action, action);
  }
});

test("attribution actions fail closed for confirmation, conflicts, and integration errors", async () => {
  const unconfirmed = await attributionActionFetch(
    attributionActionRequest("consumer-action-unconfirmed", "unassign", {
      expectedStateVersion: 1,
      idempotencyKey: "consumer-action-unconfirmed-v1",
      confirm: false,
    })
  );
  assert.equal(unconfirmed.status, 400);
  assert.equal((await unconfirmed.json()).error.code, "invalid_request");

  const policyConflict = await attributionActionFetch({
    ...attributionActionRequest("consumer-action-policy-conflict", "explain"),
    expectedPolicyVersion: activePolicy.policyVersion + 1,
  });
  assert.equal(policyConflict.status, 409);
  assert.equal((await policyConflict.json()).error.code, "policy_conflict");

  const stateConflict = await attributionActionFetch(
    attributionActionRequest("consumer-action-state-conflict", "unassign", {
      expectedStateVersion: 2,
      idempotencyKey: "consumer-action-state-conflict-v1",
      confirm: true,
    })
  );
  assert.equal(stateConflict.status, 409);
  assert.equal(
    (await stateConflict.json()).error.code,
    "attribution_state_conflict"
  );

  const missing = await attributionActionFetch(
    attributionActionRequest("consumer-action-missing", "explain")
  );
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "attribution_not_found");

  reattributionResponseMode = "unavailable";
  const unavailable = await attributionActionFetch(
    attributionActionRequest("consumer-action-unavailable", "explain")
  );
  assert.equal(unavailable.status, 503);
  const unavailableText = await unavailable.text();
  assert.match(unavailableText, /attribution_state_unavailable/);
  assert.doesNotMatch(unavailableText, /synthetic private detail/);
});

test("policy mutations reject cross-site requests and ignore client identity headers", async () => {
  const crossSite = await policyFetch(
    "/api/policy",
    "PUT",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      policy: policyDraft(activePolicy),
    },
    "https://untrusted.example"
  );
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).error.code, "cross_site_request_rejected");

  const forbidden = await policyFetch(
    "/api/policy",
    "PUT",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      policy: policyDraft(activePolicy),
      permissions: ["policy:write"],
    }
  );
  assert.equal(forbidden.status, 400);
  assert.equal((await forbidden.json()).error.code, "invalid_request");

  const spoofed = await policyFetch(
    "/api/policy",
    "PUT",
    {
      expectedPolicyVersion: activePolicy.policyVersion,
      policy: policyDraft(activePolicy),
    },
    uiUrl,
    {
      "x-tyrion-actor": "untrusted-actor",
      "x-tyrion-household": "untrusted-household",
      "x-tyrion-permissions": "policy:read",
    }
  );
  assert.equal(spoofed.status, 200);
  activePolicy = (await spoofed.json()).policy;
  assert.equal(activePolicy.householdId, policyActor.householdId);
});

test("account rules persist only connector-generated opaque account references", async () => {
  const accountRef =
    "account-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const previousPolicyVersion = activePolicy.policyVersion;
  const bypass = await policyFetch("/api/policy", "PUT", {
    expectedPolicyVersion: activePolicy.policyVersion,
    policy: {
      ...policyDraft(activePolicy),
      accountRules: [
        {
          id: "rule-account-bypass",
          kidId: "kid-synthetic",
          accountRef: "raw-monarch-account-id",
          confidence: "definite",
          enabled: true,
        },
      ],
    },
  });
  assert.equal(bypass.status, 422);
  assert.equal((await bypass.json()).error.code, "invalid_domain_contract");

  const updatedDraft = policyDraft(activePolicy);
  updatedDraft.accountRules = [
    {
      id: "rule-account-synthetic",
      kidId: "kid-synthetic",
      accountRef,
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
  assert.equal(activePolicy.policyVersion, previousPolicyVersion + 1);
  const stored = await readFile(policyStorePath, "utf8");
  assert.match(stored, new RegExp(accountRef));
  await assert.rejects(readFile(`${policyStorePath}.fingerprint-key`, "utf8"));
  assert.doesNotMatch(stored, /password|cookie|authorization|sessionPath/i);
});

test("container and homelab contracts separate public connector and private attribution", async () => {
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
  assert.doesNotMatch(compose, /PathPrefix\(`\/api\/policy`\)/);
  assert.match(compose, /trusted-private-networks@file/);
  assert.doesNotMatch(compose, /forwardauth|TYRION_POLICY_AUTH/i);
  assert.match(compose, /TYRION_POLICY_STORE_PATH: \/var\/lib\/tyrion-policy/);
  assert.match(compose, /BRIDGE_API_TOKEN: \$\{BRIDGE_API_TOKEN:/);
  assert.match(
    compose,
    /!PathPrefix\(`\/api\/internal\/`\)/
  );
  assert.match(
    compose,
    /!PathPrefix\(`\/api\/connector\/v1\/`\)/
  );
  assert.match(
    compose,
    /routers\.tyrion-connector-secure\.rule=.*Path\(`\/api\/connector\/v1\/health`\).*Path\(`\/api\/connector\/v1\/document-expectation-signals`\).*\^\/api\/connector\/v1\/document-expectation-signals\/.*\^\/api\/connector\/v1\/transactions\//
  );
  assert.match(
    compose,
    /routers\.tyrion-connector-secure\.middlewares=tyrion-public-connector-marker,compression@file,security-headers@file/
  );
  assert.doesNotMatch(
    compose,
    /routers\.tyrion-connector-secure\.middlewares=[^\r\n]*trusted-private-networks/
  );
  assert.match(
    compose,
    /middlewares\.tyrion-public-connector-marker\.headers\.customrequestheaders\.X-Tyrion-Public-Connector=1/
  );
  assert.doesNotMatch(
    compose,
    /routers\.[^.]*attribution[^=]*\.rule=.*PathPrefix/
  );
  assert.doesNotMatch(
    compose,
    /TYRION_(INSTRUMENT_FINGERPRINT_KEY|ATTRIBUTION_)/
  );
});

test("re-attribution preview is bounded and aggregate-only", async () => {
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
  origin = uiUrl,
  requestHeaders = {}
) {
  const headers = new Headers(requestHeaders);
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
  const serialized = JSON.stringify(body);
  return rawAttributionFetch(uiUrl, serialized, {
    Authorization: ["Bearer", options.token ?? serviceToken].join(" "),
    ...options.requestHeaders,
  });
}

function attributionActionFetch(body, options = {}) {
  const serialized = JSON.stringify(body);
  return rawInternalAttributionFetch(
    uiUrl,
    "/api/internal/v2/attribution/actions",
    serialized,
    {
      Authorization: ["Bearer", options.token ?? serviceToken].join(" "),
      ...options.requestHeaders,
    }
  );
}

function rawAttributionFetch(baseUrl, body, requestHeaders = {}) {
  return rawInternalAttributionFetch(
    baseUrl,
    "/api/internal/v2/attribution/batch",
    body,
    requestHeaders
  );
}

function rawInternalAttributionFetch(
  baseUrl,
  path,
  body,
  requestHeaders = {}
) {
  const target = new URL(path, baseUrl);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Host: internalAttributionHost,
          ...requestHeaders,
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolvePromise({
            status: response.statusCode,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      }
    );
    request.on("error", reject);
    request.end(body);
  });
}

function rawHttpFetch(path, method = "GET", requestHeaders = {}) {
  const target = new URL(uiUrl);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method,
        headers: requestHeaders,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolvePromise({
            status: response.statusCode,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
      }
    );
    request.on("error", reject);
    request.end();
  });
}

function attributionRequest(items) {
  return {
    contractVersion: "2.0",
    provenance: "mission-control-normalized-v2",
    expectedPolicyVersion: activePolicy.policyVersion,
    items,
  };
}

function attributionItem(sourceRef) {
  return {
    sourceRef,
    occurredOn: "2026-08-08",
    merchantName: "Synthetic Store",
    accountRef: "account-v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    observedAt: "2026-08-08T12:58:00Z",
    existingManualDecision: null,
  };
}

function attributionActionRequest(sourceRef, action, extra = {}) {
  return {
    contractVersion: "2.0",
    provenance: "mission-control-normalized-v2",
    sourceRef,
    expectedPolicyVersion: activePolicy.policyVersion,
    action,
    ...extra,
  };
}

function policyDraft(policy) {
  return {
    timezone: policy.timezone,
    currency: policy.currency,
    kids: policy.kids,
    accountRules: policy.accountRules,
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
      contractVersion: "2.0",
      householdId,
      source: {
        system: "monarch-bridge",
        recordRef: sourceRef,
        observedAt: evaluatedAt,
      },
      transaction: {
        merchantName: "Synthetic Store",
        accountRef: "account-v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
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
      contractVersion: "2.0",
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
        engineVersion: "2.0.0",
        ruleIds: [],
        evaluatedAt,
      },
    },
  };
}

function attributionActionRecord(householdId, sourceRef) {
  const evaluatedAt = "2026-08-08T12:58:00.000Z";
  return {
    input: {
      contractVersion: "2.0",
      householdId,
      source: {
        system: "monarch-bridge",
        recordRef: sourceRef,
        observedAt: evaluatedAt,
      },
      transaction: {
        merchantName: "Synthetic Store",
        accountRef: "account-v1:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        occurredOn: "2026-08-08",
      },
      historicalAttributions: [],
      existingManualDecision: null,
    },
    attribution: {
      contractVersion: "2.0",
      sourceRef,
      status: "pending",
      kidId: "kid-synthetic",
      confidence: "likely",
      method: "merchant-rule",
      explanation: "A configured merchant rule matched.",
      review: { status: "pending", reasons: ["low-confidence"] },
      provenance: {
        decisionSource: "automated",
        policyVersion: activePolicy.policyVersion,
        engineVersion: "2.0.0",
        ruleIds: ["rule-merchant-synthetic"],
        evaluatedAt,
      },
    },
    stateVersion: 1,
    exception: {
      status: "open",
      reasons: ["low-confidence"],
      deferredUntil: null,
      updatedAt: evaluatedAt,
    },
    lastAction: null,
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
