import {
  FilePolicyRepository,
  AttributionActionService,
  AttributionBatchService,
  PolicyService,
  PolicyVersionConflictError,
  ReattributionService,
  parseAttributionInputV1,
  parseAttributionActionRecordV1,
  parseAttributionResultV1,
  parseReattributionPreviewV1,
  type AttributionResultV1,
  type AttributionActionApplyResultV1,
  type AttributionActionMutationV1,
  type AttributionActionRecordV1,
  type AttributionActionRepository,
  type PolicyAuditEventV1,
  type PolicyRepository,
  type PolicySnapshotV1,
  type ReattributionApplyCountsV1,
  type ReattributionPreviewV1,
  type ReattributionRecordV1,
  type ReattributionRepository,
} from "@rsocko/tyrion-kid-engine";
import { HOMELAB_HOUSEHOLD_ID } from "@/lib/homelab-identity";

const MAX_INTEGRATION_RESPONSE_BYTES = 1_048_576;
const INTEGRATION_TIMEOUT_MS = 10_000;
export interface PolicyRuntime {
  mode: "demo" | "production";
  policyService: PolicyService;
  attributionBatchService: AttributionBatchService;
  getAttributionActionService(): AttributionActionService;
  getReattributionService(): ReattributionService;
}

export class PolicyRuntimeConfigurationError extends Error {
  readonly code = "policy_runtime_not_configured";

  constructor() {
    super("Policy runtime is not configured");
    this.name = "PolicyRuntimeConfigurationError";
  }
}

export class ReattributionIntegrationError extends Error {
  readonly code = "reattribution_integration_unavailable";

  constructor() {
    super("Re-attribution integration is unavailable");
    this.name = "ReattributionIntegrationError";
  }
}

let cachedRuntime: PolicyRuntime | undefined;

export function getPolicyRuntime(
  environment: NodeJS.ProcessEnv = process.env
): PolicyRuntime {
  if (cachedRuntime) return cachedRuntime;

  const demo = environment.TYRION_POLICY_DEMO_MODE === "true";
  if (demo && environment.NODE_ENV === "production") {
    throw new PolicyRuntimeConfigurationError();
  }

  const policyRepository: PolicyRepository = demo
    ? new MemoryPolicyRepository()
    : createFilePolicyRepository(environment);
  let reattributionService: ReattributionService | undefined;
  let attributionActionService: AttributionActionService | undefined;
  let integrationClient: AttributionStateIntegrationClient | undefined;
  const getIntegrationClient = () => {
    integrationClient ??= new AttributionStateIntegrationClient(environment);
    return integrationClient;
  };
  cachedRuntime = {
    mode: demo ? "demo" : "production",
    policyService: new PolicyService(policyRepository),
    attributionBatchService: new AttributionBatchService(policyRepository),
    getAttributionActionService() {
      if (!attributionActionService) {
        const repository: AttributionActionRepository = demo
          ? new DemoAttributionActionRepository()
          : new HttpAttributionActionRepository(getIntegrationClient());
        attributionActionService = new AttributionActionService(
          policyRepository,
          repository
        );
      }
      return attributionActionService;
    },
    getReattributionService() {
      if (!reattributionService) {
        const repository: ReattributionRepository = demo
          ? new DemoReattributionRepository()
          : new HttpReattributionRepository(getIntegrationClient());
        reattributionService = new ReattributionService(
          policyRepository,
          repository
        );
      }
      return reattributionService;
    },
  };
  return cachedRuntime;
}

function createFilePolicyRepository(
  environment: NodeJS.ProcessEnv
): FilePolicyRepository {
  const path = environment.TYRION_POLICY_STORE_PATH;
  if (!path) throw new PolicyRuntimeConfigurationError();
  return new FilePolicyRepository(path, {
    canonicalHouseholdId: HOMELAB_HOUSEHOLD_ID,
  });
}

class MemoryPolicyRepository implements PolicyRepository {
  private snapshot: PolicySnapshotV1 | null = null;
  private audit: PolicyAuditEventV1[] = [];

  async load(householdId: string): Promise<PolicySnapshotV1 | null> {
    return this.snapshot?.householdId === householdId
      ? structuredClone(this.snapshot)
      : null;
  }

  async save(
    snapshot: PolicySnapshotV1,
    expectedPolicyVersion: number | null,
    auditEvent: PolicyAuditEventV1
  ): Promise<void> {
    if ((this.snapshot?.policyVersion ?? null) !== expectedPolicyVersion) {
      throw new PolicyVersionConflictError();
    }
    this.snapshot = structuredClone(snapshot);
    this.audit.push(structuredClone(auditEvent));
  }

  async listAudit(householdId: string): Promise<PolicyAuditEventV1[]> {
    return this.audit
      .filter((event) => event.householdId === householdId)
      .map((event) => structuredClone(event));
  }

  async withPolicyVersionFence<T>(
    householdId: string,
    expectedPolicyVersion: number,
    operation: () => Promise<T>
  ): Promise<T | null> {
    if (
      this.snapshot?.householdId !== householdId ||
      this.snapshot.policyVersion !== expectedPolicyVersion
    ) {
      return null;
    }
    return operation();
  }
}

class DemoReattributionRepository implements ReattributionRepository {
  private readonly previews = new Map<string, ReattributionPreviewV1>();
  private readonly records = new Map<string, ReattributionRecordV1>([
    ["demo-record-1", demoRecord("demo-record-1", null)],
    [
      "demo-record-manual",
      demoRecord("demo-record-manual", {
        contractVersion: "2.0",
        sourceRef: "demo-record-manual",
        status: "attributed",
        kidId: "demo-kid",
        confidence: "definite",
        method: "manual",
        explanation: "An existing manual decision is preserved.",
        review: { status: "resolved", reasons: [] },
        provenance: {
          decisionSource: "manual",
          policyVersion: null,
          engineVersion: "2.0.0",
          ruleIds: [],
          evaluatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    ],
  ]);

  async loadRecords(
    householdId: string,
    sourceRefs: string[]
  ): Promise<ReattributionRecordV1[]> {
    if (householdId !== HOMELAB_HOUSEHOLD_ID) return [];
    return sourceRefs.flatMap((sourceRef) => {
      const record = this.records.get(sourceRef);
      return record ? [structuredClone(record)] : [];
    });
  }

  async savePreview(preview: ReattributionPreviewV1): Promise<void> {
    this.previews.set(preview.previewId, structuredClone(preview));
  }

  async loadPreview(
    householdId: string,
    previewId: string
  ): Promise<ReattributionPreviewV1 | null> {
    const preview = this.previews.get(previewId);
    return preview?.householdId === householdId ? structuredClone(preview) : null;
  }

  async applyPreviewIfPolicyVersion(
    preview: ReattributionPreviewV1,
    _appliedAt: string,
    expectedPolicyVersion: number
  ): Promise<ReattributionApplyCountsV1 | null> {
    if (preview.policyVersion !== expectedPolicyVersion) return null;
    return summarizePreview(preview);
  }
}

class HttpReattributionRepository implements ReattributionRepository {
  constructor(private readonly client: AttributionStateIntegrationClient) {}

  async loadRecords(
    householdId: string,
    sourceRefs: string[]
  ): Promise<ReattributionRecordV1[]> {
    const value = await this.client.request("v1/reattribution/records:resolve", {
      householdId,
      sourceRefs,
    });
    const record = exactObject(value, ["records"]);
    if (!Array.isArray(record.records)) throw new ReattributionIntegrationError();
    try {
      return record.records.map((item) => {
        const candidate = exactObject(item, ["input", "current"]);
        return {
          input: parseAttributionInputV1(candidate.input),
          current: parseAttributionResultV1(candidate.current),
        };
      });
    } catch {
      throw new ReattributionIntegrationError();
    }
  }

  async savePreview(preview: ReattributionPreviewV1): Promise<void> {
    const result = exactObject(
      await this.client.request("v1/reattribution/previews", { preview }),
      ["stored"]
    );
    if (result.stored !== true) throw new ReattributionIntegrationError();
  }

  async loadPreview(
    householdId: string,
    previewId: string
  ): Promise<ReattributionPreviewV1 | null> {
    const value = await this.client.request("v1/reattribution/previews:resolve", {
      householdId,
      previewId,
    });
    const record = exactObject(value, ["preview"]);
    if (record.preview === null) return null;
    try {
      return parseReattributionPreviewV1(record.preview);
    } catch {
      throw new ReattributionIntegrationError();
    }
  }

  async applyPreviewIfPolicyVersion(
    preview: ReattributionPreviewV1,
    appliedAt: string,
    expectedPolicyVersion: number
  ): Promise<ReattributionApplyCountsV1 | null> {
    const value = await this.client.request("v1/reattribution/previews:apply", {
      preview,
      appliedAt,
      expectedPolicyVersion,
    });
    const record = exactObject(value, ["counts"]);
    if (record.counts === null) return null;
    const counts = exactObject(record.counts, [
      "applied",
      "unchanged",
      "manualPreserved",
      "pendingReview",
    ]);
    return {
      applied: count(counts.applied),
      unchanged: count(counts.unchanged),
      manualPreserved: count(counts.manualPreserved),
      pendingReview: count(counts.pendingReview),
    };
  }

}

class AttributionStateIntegrationClient {
  private readonly baseUrl: URL;
  private readonly token: string;

  constructor(environment: NodeJS.ProcessEnv) {
    const token = environment.BRIDGE_API_TOKEN;
    if (!token || token.length < 32) throw new ReattributionIntegrationError();
    this.token = token;
    const rawUrl = environment.TYRION_REATTRIBUTION_URL;
    if (!rawUrl) throw new ReattributionIntegrationError();
    try {
      this.baseUrl = new URL(rawUrl);
    } catch {
      throw new ReattributionIntegrationError();
    }
    const allowInternalHttp =
      environment.TYRION_REATTRIBUTION_ALLOW_INSECURE_INTERNAL === "true";
    if (
      (this.baseUrl.protocol !== "https:" &&
        !(this.baseUrl.protocol === "http:" && allowInternalHttp)) ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.pathname !== "/" ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new ReattributionIntegrationError();
    }
  }

  async request(path: string, body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), INTEGRATION_TIMEOUT_MS);
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) throw new ReattributionIntegrationError();
      const declaredLength = Number(response.headers.get("content-length") || "0");
      if (
        !Number.isSafeInteger(declaredLength) ||
        declaredLength > MAX_INTEGRATION_RESPONSE_BYTES
      ) {
        throw new ReattributionIntegrationError();
      }
      const payload = new Uint8Array(await response.arrayBuffer());
      if (payload.byteLength > MAX_INTEGRATION_RESPONSE_BYTES) {
        throw new ReattributionIntegrationError();
      }
      return JSON.parse(new TextDecoder().decode(payload));
    } catch (error) {
      if (error instanceof ReattributionIntegrationError) throw error;
      throw new ReattributionIntegrationError();
    } finally {
      clearTimeout(timeout);
    }
  }
}

class DemoAttributionActionRepository implements AttributionActionRepository {
  private readonly records = new Map<string, AttributionActionRecordV1>([
    ["demo-record-1", demoActionRecord("demo-record-1")],
  ]);
  private readonly replays = new Map<
    string,
    AttributionActionApplyResultV1
  >();

  async load(
    householdId: string,
    sourceRef: string
  ): Promise<AttributionActionRecordV1 | null> {
    if (householdId !== HOMELAB_HOUSEHOLD_ID) return null;
    const record = this.records.get(sourceRef);
    return record ? structuredClone(record) : null;
  }

  async loadReplay(
    householdId: string,
    _sourceRef: string,
    idempotencyKey: string
  ): Promise<AttributionActionApplyResultV1 | null> {
    if (householdId !== HOMELAB_HOUSEHOLD_ID) return null;
    const replay = this.replays.get(idempotencyKey);
    return replay ? { ...structuredClone(replay), replayed: true } : null;
  }

  async applyIfCurrent(
    householdId: string,
    mutation: AttributionActionMutationV1
  ): Promise<AttributionActionApplyResultV1 | null> {
    if (householdId !== HOMELAB_HOUSEHOLD_ID) return null;
    const replay = this.replays.get(mutation.request.idempotencyKey);
    if (replay) return { ...structuredClone(replay), replayed: true };
    const current = this.records.get(mutation.request.sourceRef);
    if (
      !current ||
      current.stateVersion !== mutation.request.expectedStateVersion
    ) {
      return null;
    }
    const stateVersion = current.stateVersion + 1;
    const record: AttributionActionRecordV1 = {
      input: structuredClone(mutation.input),
      attribution: structuredClone(mutation.attribution),
      stateVersion,
      exception: structuredClone(mutation.exception),
      lastAction: {
        ...structuredClone(mutation.audit),
        outcome: "applied",
        stateVersion,
      },
    };
    this.records.set(mutation.request.sourceRef, record);
    const result = {
      record: structuredClone(record),
      replayed: false,
      requestFingerprint: mutation.requestFingerprint,
    };
    this.replays.set(mutation.request.idempotencyKey, structuredClone(result));
    return result;
  }
}

class HttpAttributionActionRepository implements AttributionActionRepository {
  constructor(private readonly client: AttributionStateIntegrationClient) {}

  async load(
    householdId: string,
    sourceRef: string
  ): Promise<AttributionActionRecordV1 | null> {
    const value = exactObject(
      await this.client.request("v1/attribution-actions/records:resolve", {
        householdId,
        sourceRef,
      }),
      ["record"]
    );
    if (value.record === null) return null;
    try {
      return parseAttributionActionRecordV1(value.record);
    } catch {
      throw new ReattributionIntegrationError();
    }
  }

  async loadReplay(
    householdId: string,
    sourceRef: string,
    idempotencyKey: string
  ): Promise<AttributionActionApplyResultV1 | null> {
    const value = exactObject(
      await this.client.request("v1/attribution-actions/actions:resolve", {
        householdId,
        sourceRef,
        idempotencyKey,
      }),
      ["result"]
    );
    return parseAttributionActionApplyResult(value.result);
  }

  async applyIfCurrent(
    householdId: string,
    mutation: AttributionActionMutationV1
  ): Promise<AttributionActionApplyResultV1 | null> {
    const value = exactObject(
      await this.client.request("v1/attribution-actions/actions:apply", {
        householdId,
        mutation,
      }),
      ["result"]
    );
    return parseAttributionActionApplyResult(value.result);
  }
}

function demoRecord(
  sourceRef: string,
  current: AttributionResultV1 | null
): ReattributionRecordV1 {
  const input = parseAttributionInputV1({
    contractVersion: "2.0",
    householdId: HOMELAB_HOUSEHOLD_ID,
    source: {
      system: "monarch-bridge",
      recordRef: sourceRef,
      observedAt: "2026-01-01T00:00:00.000Z",
    },
    transaction: {
      merchantName: "Synthetic Store",
      accountRef: "account-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      occurredOn: "2026-01-01",
    },
    historicalAttributions: [],
    existingManualDecision:
      sourceRef === "demo-record-manual"
        ? {
            action: "assign-kid",
            kidId: "demo-kid",
            actorId: "demo-operator",
            decidedAt: "2026-01-01T00:00:00.000Z",
            explanation: "Synthetic demo decision.",
          }
        : null,
  });
  return {
    input,
    current:
      current ??
      parseAttributionResultV1({
        contractVersion: "2.0",
        sourceRef,
        status: "unassigned",
        kidId: null,
        confidence: "none",
        method: "unassigned",
        explanation: "No deterministic attribution was available.",
        review: { status: "pending", reasons: ["no-match"] },
        provenance: {
          decisionSource: "fallback",
          policyVersion: null,
          engineVersion: "2.0.0",
          ruleIds: [],
          evaluatedAt: "2026-01-01T00:00:00.000Z",
        },
      }),
  };
}

function demoActionRecord(sourceRef: string): AttributionActionRecordV1 {
  const record = demoRecord(sourceRef, null);
  return {
    input: record.input,
    attribution: record.current,
    stateVersion: 1,
    exception: {
      status: "open",
      reasons: structuredClone(record.current.review.reasons),
      deferredUntil: null,
      updatedAt: record.current.provenance.evaluatedAt,
    },
    lastAction: null,
  };
}

function summarizePreview(
  preview: ReattributionPreviewV1
): ReattributionApplyCountsV1 {
  return preview.items.reduce<ReattributionApplyCountsV1>(
    (counts, item) => {
      if (item.disposition === "would-update") counts.applied += 1;
      if (item.disposition === "unchanged") counts.unchanged += 1;
      if (item.disposition === "manual-preserved") counts.manualPreserved += 1;
      if (item.disposition === "pending-review") counts.pendingReview += 1;
      return counts;
    },
    { applied: 0, unchanged: 0, manualPreserved: 0, pendingReview: 0 }
  );
}

function exactObject(
  value: unknown,
  keys: readonly string[]
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ReattributionIntegrationError();
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(keys);
  if (
    Object.keys(record).some((key) => !allowed.has(key)) ||
    keys.some((key) => !(key in record))
  ) {
    throw new ReattributionIntegrationError();
  }
  return record;
}

function parseAttributionActionApplyResult(
  value: unknown
): AttributionActionApplyResultV1 | null {
  if (value === null) return null;
  const result = exactObject(value, [
    "record",
    "replayed",
    "requestFingerprint",
  ]);
  if (
    typeof result.replayed !== "boolean" ||
    typeof result.requestFingerprint !== "string"
  ) {
    throw new ReattributionIntegrationError();
  }
  try {
    return {
      record: parseAttributionActionRecordV1(result.record),
      replayed: result.replayed,
      requestFingerprint: result.requestFingerprint,
    };
  } catch {
    throw new ReattributionIntegrationError();
  }
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ReattributionIntegrationError();
  }
  return value as number;
}
