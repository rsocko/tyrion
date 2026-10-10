import {
  FilePolicyRepository,
  AttributionActionService,
  AttributionBatchService,
  AttributionPolicyService,
  PolicyService,
  PolicyVersionConflictError,
  ReattributionService,
  TagProjectionError,
  TagProjectionServiceV1,
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
  type ReattributionAppliedStateV1,
  type ReattributionPreviewV1,
  type ReattributionRecordV1,
  type ReattributionRepository,
  type KidTagMappingV1,
  type MonarchTagProjectionBridgeV1,
  type MonarchTagV1,
  type TagProjectionRecordV1,
  type TagProjectionRepositoryV1,
} from "@rsocko/tyrion-kid-engine";
import { HOMELAB_HOUSEHOLD_ID } from "@/lib/homelab-identity";

const MAX_INTEGRATION_RESPONSE_BYTES = 1_048_576;
const INTEGRATION_TIMEOUT_MS = 10_000;
export interface PolicyRuntime {
  mode: "demo" | "production";
  policyService: PolicyService;
  attributionPolicyService: AttributionPolicyService;
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
  let tagProjectionService: TagProjectionServiceV1 | undefined;
  const getIntegrationClient = () => {
    integrationClient ??= new AttributionStateIntegrationClient(environment);
    return integrationClient;
  };
  const getTagProjectionService = () => {
    tagProjectionService ??= demo
      ? new TagProjectionServiceV1(
          new DemoTagProjectionRepository(),
          new DemoMonarchTagProjectionBridge()
        )
      : new TagProjectionServiceV1(
          new HttpTagProjectionRepository(getIntegrationClient()),
          new HttpMonarchTagProjectionBridge(environment)
        );
    return tagProjectionService;
  };
  cachedRuntime = {
    mode: demo ? "demo" : "production",
    policyService: new PolicyService(policyRepository),
    attributionPolicyService: new AttributionPolicyService(policyRepository),
    attributionBatchService: new AttributionBatchService(policyRepository),
    getAttributionActionService() {
      if (!attributionActionService) {
        const repository: AttributionActionRepository = demo
          ? new DemoAttributionActionRepository()
          : new HttpAttributionActionRepository(getIntegrationClient());
        attributionActionService = new AttributionActionService(
          policyRepository,
          repository,
          { tagProjector: getTagProjectionService() }
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
          repository,
          { tagProjector: getTagProjectionService() }
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
  private readonly applied = new Map<string, ReattributionAppliedStateV1>();

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

  async loadAppliedState(
    householdId: string,
    previewId: string
  ): Promise<ReattributionAppliedStateV1 | null> {
    const preview = this.previews.get(previewId);
    const state = this.applied.get(previewId);
    return preview?.householdId === householdId && state
      ? structuredClone(state)
      : null;
  }

  async applyPreviewIfPolicyVersion(
    preview: ReattributionPreviewV1,
    _appliedAt: string,
    expectedPolicyVersion: number
  ): Promise<ReattributionApplyCountsV1 | null> {
    if (preview.policyVersion !== expectedPolicyVersion) return null;
    const counts = summarizePreview(preview);
    this.applied.set(preview.previewId, { counts, appliedAt: _appliedAt });
    return counts;
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

  async loadAppliedState(
    householdId: string,
    previewId: string
  ): Promise<ReattributionAppliedStateV1 | null> {
    const value = exactObject(
      await this.client.request("v1/reattribution/previews:applied", {
        householdId,
        previewId,
      }),
      ["applied"]
    );
    if (value.applied === null) return null;
    const applied = exactObject(value.applied, ["counts", "appliedAt"]);
    const counts = exactObject(applied.counts, [
      "applied",
      "unchanged",
      "manualPreserved",
      "pendingReview",
    ]);
    if (typeof applied.appliedAt !== "string") {
      throw new ReattributionIntegrationError();
    }
    return {
      counts: {
        applied: count(counts.applied),
        unchanged: count(counts.unchanged),
        manualPreserved: count(counts.manualPreserved),
        pendingReview: count(counts.pendingReview),
      },
      appliedAt: applied.appliedAt,
    };
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

    class DemoTagProjectionRepository implements TagProjectionRepositoryV1 {
      private readonly mappings = new Map<string, KidTagMappingV1>();
      private readonly projections = new Map<string, TagProjectionRecordV1>();

      async listMappings(): Promise<KidTagMappingV1[]> {
        return [...this.mappings.values()].map((mapping) => structuredClone(mapping));
      }

      async saveMapping(
        _householdId: string,
        mapping: KidTagMappingV1
      ): Promise<void> {
        this.mappings.set(mapping.kidId, structuredClone(mapping));
      }

      async loadProjection(
        _householdId: string,
        sourceRef: string
      ): Promise<TagProjectionRecordV1 | null> {
        const projection = this.projections.get(sourceRef);
        return projection ? structuredClone(projection) : null;
      }

      async saveProjection(
        _householdId: string,
        projection: TagProjectionRecordV1
      ): Promise<void> {
        this.projections.set(projection.sourceRef, structuredClone(projection));
      }
    }

    class DemoMonarchTagProjectionBridge implements MonarchTagProjectionBridgeV1 {
      private readonly tags: MonarchTagV1[] = [
        { id: "demo-household-tag", name: "Household", isActive: true },
      ];
      private readonly transactionTags = new Map<string, string[]>();

      async listTags(): Promise<MonarchTagV1[]> {
        return structuredClone(this.tags);
      }

      async createTag(name: string): Promise<MonarchTagV1> {
        const tag = {
          id: `demo-kid-tag-${this.tags.length}`,
          name,
          isActive: true,
        };
        this.tags.push(tag);
        return structuredClone(tag);
      }

      async readTransactionTagIds(sourceRef: string): Promise<string[]> {
        return [...(this.transactionTags.get(sourceRef) ?? ["demo-household-tag"])];
      }

      async replaceTransactionTags(
        sourceRef: string,
        tagIds: string[],
        expectedTagIds: string[]
      ): Promise<string[]> {
        const current = await this.readTransactionTagIds(sourceRef);
        if (!sameStringSet(current, expectedTagIds)) {
          throw new TagProjectionError(
            "transaction_tag_drift",
            "Managed Monarch tags changed; reconcile before retrying"
          );
        }
        this.transactionTags.set(sourceRef, [...tagIds]);
        return [...tagIds];
      }
    }

    class HttpTagProjectionRepository implements TagProjectionRepositoryV1 {
      constructor(private readonly client: AttributionStateIntegrationClient) {}

      async listMappings(householdId: string): Promise<KidTagMappingV1[]> {
        const value = exactObject(
          await this.client.request("v1/tag-projection/mappings:resolve", {
            householdId,
          }),
          ["mappings"]
        );
        if (!Array.isArray(value.mappings)) throw new ReattributionIntegrationError();
        return value.mappings.map(parseKidTagMapping);
      }

      async saveMapping(
        householdId: string,
        mapping: KidTagMappingV1
      ): Promise<void> {
        const value = exactObject(
          await this.client.request("v1/tag-projection/mappings:save", {
            householdId,
            mapping,
          }),
          ["stored"]
        );
        if (value.stored !== true) throw new ReattributionIntegrationError();
      }

      async loadProjection(
        householdId: string,
        sourceRef: string
      ): Promise<TagProjectionRecordV1 | null> {
        const value = exactObject(
          await this.client.request("v1/tag-projection/records:resolve", {
            householdId,
            sourceRef,
          }),
          ["projection"]
        );
        return value.projection === null
          ? null
          : parseTagProjectionRecord(value.projection);
      }

      async saveProjection(
        householdId: string,
        projection: TagProjectionRecordV1
      ): Promise<void> {
        const value = exactObject(
          await this.client.request("v1/tag-projection/records:save", {
            householdId,
            projection,
          }),
          ["stored"]
        );
        if (value.stored !== true) throw new ReattributionIntegrationError();
      }
    }

    class HttpMonarchTagProjectionBridge implements MonarchTagProjectionBridgeV1 {
      private readonly baseUrl: URL;
      private readonly token: string;

      constructor(environment: NodeJS.ProcessEnv) {
        const token = environment.BRIDGE_API_TOKEN;
        if (!token || token.length < 32) throw new ReattributionIntegrationError();
        this.token = token;
        try {
          this.baseUrl = new URL(environment.BRIDGE_URL ?? "");
        } catch {
          throw new ReattributionIntegrationError();
        }
        if (
          !["http:", "https:"].includes(this.baseUrl.protocol) ||
          this.baseUrl.username ||
          this.baseUrl.password ||
          (this.baseUrl.pathname !== "/" && this.baseUrl.pathname !== "") ||
          this.baseUrl.search ||
          this.baseUrl.hash
        ) {
          throw new ReattributionIntegrationError();
        }
      }

      async listTags(): Promise<MonarchTagV1[]> {
        const value = exactObject(await this.request("GET", "tags"), [
          "contractVersion",
          "provenance",
          "tags",
        ]);
        if (!Array.isArray(value.tags)) throw new ReattributionIntegrationError();
        return value.tags.map(parseMonarchTag);
      }

      async createTag(name: string, color: string): Promise<MonarchTagV1> {
        const value = exactObject(
          await this.request("POST", "tags", { name, color }),
          ["contractVersion", "status", "tag"]
        );
        if (value.status !== "created") throw new ReattributionIntegrationError();
        return parseMonarchTag(value.tag);
      }

      async readTransactionTagIds(sourceRef: string): Promise<string[]> {
        const value = exactObject(
          await this.request(
            "GET",
            `transactions/${encodeURIComponent(sourceRef)}`
          ),
          ["contractVersion", "provenance", "transaction"]
        );
        const transaction = exactObject(value.transaction, [
          "id",
          "date",
          "amount",
          "merchant",
          "category",
          "account",
          "isPending",
          "isRecurring",
          "reviewStatus",
          "reviewAssignee",
          "notes",
          "tags",
          "tagReferences",
        ]);
        if (!Array.isArray(transaction.tagReferences)) {
          throw new ReattributionIntegrationError();
        }
        return transaction.tagReferences.map((value) => {
          const tag = exactObject(value, ["id", "name"]);
          if (typeof tag.id !== "string" || typeof tag.name !== "string") {
            throw new ReattributionIntegrationError();
          }
          return tag.id;
        });
      }

      async replaceTransactionTags(
        sourceRef: string,
        tagIds: string[],
        expectedTagIds: string[]
      ): Promise<string[]> {
        let value: unknown;
        try {
          value = await this.request(
            "PATCH",
            `transactions/${encodeURIComponent(sourceRef)}/tags`,
            { tagIds, expectedTagIds }
          );
        } catch (error) {
          if (
            error instanceof BridgeProjectionRequestError &&
            error.status === 409
          ) {
            throw new TagProjectionError(
              "transaction_tag_drift",
              "Managed Monarch tags changed; reconcile before retrying"
            );
          }
          throw error;
        }
        const response = exactObject(value, [
          "contractVersion",
          "status",
          "transactionId",
          "tagReferences",
        ]);
        if (
          response.status !== "updated" ||
          response.transactionId !== sourceRef ||
          !Array.isArray(response.tagReferences)
        ) {
          throw new ReattributionIntegrationError();
        }
        return response.tagReferences.map((value) => {
          const tag = exactObject(value, ["id", "name"]);
          if (typeof tag.id !== "string" || typeof tag.name !== "string") {
            throw new ReattributionIntegrationError();
          }
          return tag.id;
        });
      }

      private async request(
        method: "GET" | "POST" | "PATCH",
        path: string,
        body?: unknown
      ): Promise<unknown> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), INTEGRATION_TIMEOUT_MS);
        try {
          const response = await fetch(new URL(path, this.baseUrl), {
            method,
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${this.token}`,
              ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            cache: "no-store",
            signal: controller.signal,
          });
          if (!response.ok) throw new BridgeProjectionRequestError(response.status);
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
          if (
            error instanceof ReattributionIntegrationError ||
            error instanceof BridgeProjectionRequestError
          ) {
            throw error;
          }
          throw new ReattributionIntegrationError();
        } finally {
          clearTimeout(timeout);
        }
      }
    }

    class BridgeProjectionRequestError extends Error {
      constructor(readonly status: number) {
        super("Monarch tag projection request failed");
        this.name = "BridgeProjectionRequestError";
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
      accountRef: "bridge-account-demo",
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

function parseKidTagMapping(value: unknown): KidTagMappingV1 {
  const mapping = exactObject(value, [
    "kidId",
    "tagId",
    "label",
    "retiredTagIds",
  ]);
  if (
    typeof mapping.kidId !== "string" ||
    typeof mapping.tagId !== "string" ||
    typeof mapping.label !== "string" ||
    !Array.isArray(mapping.retiredTagIds) ||
    !mapping.retiredTagIds.every((tagId) => typeof tagId === "string")
  ) {
    throw new ReattributionIntegrationError();
  }
  return {
    kidId: mapping.kidId,
    tagId: mapping.tagId,
    label: mapping.label,
    retiredTagIds: [...mapping.retiredTagIds] as string[],
  };
}

function parseTagProjectionRecord(value: unknown): TagProjectionRecordV1 {
  const projection = exactObject(value, [
    "sourceRef",
    "decisionVersion",
    "kidIds",
    "managedTagIds",
    "status",
    "errorCode",
    "updatedAt",
  ]);
  const statuses = new Set(["pending", "projected", "failed", "drift"]);
  const errorCodes = new Set([
    "kid_tag_collision",
    "kid_tag_mapping_deleted",
    "kid_not_projectable",
    "transaction_tag_drift",
    "tag_projection_unavailable",
    "tag_projection_unverified",
  ]);
  if (
    typeof projection.sourceRef !== "string" ||
    typeof projection.decisionVersion !== "string" ||
    !Array.isArray(projection.kidIds) ||
    !projection.kidIds.every((kidId) => typeof kidId === "string") ||
    !Array.isArray(projection.managedTagIds) ||
    !projection.managedTagIds.every((tagId) => typeof tagId === "string") ||
    typeof projection.status !== "string" ||
    !statuses.has(projection.status) ||
    (projection.errorCode !== null &&
      (typeof projection.errorCode !== "string" ||
        !errorCodes.has(projection.errorCode))) ||
    typeof projection.updatedAt !== "string"
  ) {
    throw new ReattributionIntegrationError();
  }
  return {
    sourceRef: projection.sourceRef,
    decisionVersion: projection.decisionVersion,
    kidIds: [...projection.kidIds],
    managedTagIds: [...projection.managedTagIds],
    status: projection.status,
    errorCode: projection.errorCode,
    updatedAt: projection.updatedAt,
  } as TagProjectionRecordV1;
}

function parseMonarchTag(value: unknown): MonarchTagV1 {
  const tag = exactObject(value, ["id", "name", "isActive"]);
  if (
    typeof tag.id !== "string" ||
    typeof tag.name !== "string" ||
    typeof tag.isActive !== "boolean"
  ) {
    throw new ReattributionIntegrationError();
  }
  return { id: tag.id, name: tag.name, isActive: tag.isActive };
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
