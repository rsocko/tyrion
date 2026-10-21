import {
  FilePolicyRepository,
  FileAttributionRepositoryV1,
  DurableAttributionServiceV1,
  AttributionStoreError,
  AttributionActionService,
  AttributionBatchService,
  AttributionPolicyService,
  MerchantRuleCreationService,
  PolicyService,
  PolicyVersionConflictError,
  ReattributionService,
  TagProjectionError,
  TagProjectionServiceV1,
  parseAttributionInputV1,
  parseAttributionResultV1,
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
  type ParentTagMappingV1,
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
  merchantRuleCreationService: MerchantRuleCreationService;
  getAttributionActionService(): Pick<AttributionActionService, "act">;
  getDurableAttributionService(): DurableAttributionServiceV1;
  getReattributionService(): Pick<ReattributionService, "preview" | "apply">;
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
  const durable = !demo || Boolean(environment.TYRION_ATTRIBUTION_STORE_PATH);
  if (demo && environment.NODE_ENV === "production") {
    throw new PolicyRuntimeConfigurationError();
  }

  const policyRepository: PolicyRepository = demo
    ? new MemoryPolicyRepository()
    : createFilePolicyRepository(environment);
  let reattributionService: ReattributionService | undefined;
  let attributionActionService: AttributionActionService | undefined;
  let tagProjectionService: TagProjectionServiceV1 | undefined;
  let durableStore: FileAttributionRepositoryV1 | undefined;
  let durableService: DurableAttributionServiceV1 | undefined;
  const getDurableStore = () => {
    if (!environment.TYRION_ATTRIBUTION_STORE_PATH) {
      throw new PolicyRuntimeConfigurationError();
    }
    durableStore ??= new FileAttributionRepositoryV1(environment.TYRION_ATTRIBUTION_STORE_PATH);
    return durableStore;
  };
  const getDurableService = () => {
    durableService ??= new DurableAttributionServiceV1(
      policyRepository, getDurableStore(), getTagProjectionService()
    );
    return durableService;
  };
  const getTagProjectionService = () => {
    tagProjectionService ??= new TagProjectionServiceV1(
          durable ? getDurableStore() : new DemoTagProjectionRepository(),
          demo ? new DemoMonarchTagProjectionBridge() : new HttpMonarchTagProjectionBridge(
            environment,
            (sourceRef) => getDurableStore().transactionId(HOMELAB_HOUSEHOLD_ID, sourceRef)
          )
        );
    return tagProjectionService;
  };
  cachedRuntime = {
    mode: demo ? "demo" : "production",
    policyService: new PolicyService(policyRepository),
    attributionPolicyService: new AttributionPolicyService(policyRepository),
    attributionBatchService: new AttributionBatchService(policyRepository),
    merchantRuleCreationService: new MerchantRuleCreationService(policyRepository),
    getAttributionActionService() {
      if (durable) return getDurableService();
      if (!attributionActionService) {
        const repository = new DemoAttributionActionRepository();
        attributionActionService = new AttributionActionService(
          policyRepository,
          repository,
          { tagProjector: getTagProjectionService() }
        );
      }
      return attributionActionService;
    },
    getDurableAttributionService() {
      return getDurableService();
    },
    getReattributionService() {
      if (!reattributionService) {
        const repository: ReattributionRepository = durable
          ? getDurableStore() : new DemoReattributionRepository();
        reattributionService = new ReattributionService(
          policyRepository,
          repository,
          { tagProjector: !durable ? getTagProjectionService() : {
            async projectConfirmed(input) {
              const projection = await getDurableService().projectCurrent(
                input.householdId, input.sourceRef
              );
              if (!projection) throw new AttributionStoreError();
              if (projection.status !== "projected") {
                throw new TagProjectionError(
                  projection.errorCode ?? "tag_projection_unavailable",
                  "Attribution is saved but Monarch tag projection requires recovery"
                );
              }
              return projection;
            },
          } }
        );
      }
      const service = reattributionService;
      return !durable ? service : {
        preview: (actor, request) => getDurableStore().withProjectionLease(
          () => service.preview(actor, request)
        ),
        apply: (actor, request) => getDurableStore().withProjectionLease(
          () => service.apply(actor, request)
        ),
      };
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
        contractVersion: "2.1",
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
          engineVersion: "2.1.0",
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

    class DemoTagProjectionRepository implements TagProjectionRepositoryV1 {
      private readonly mappings = new Map<string, KidTagMappingV1>();
      private parentMapping: ParentTagMappingV1 | null = null;
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

      async loadParentMapping(): Promise<ParentTagMappingV1 | null> {
        return this.parentMapping ? structuredClone(this.parentMapping) : null;
      }

      async saveParentMapping(
        _householdId: string,
        mapping: ParentTagMappingV1
      ): Promise<void> {
        this.parentMapping = structuredClone(mapping);
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
          id: `demo-managed-tag-${this.tags.length}`,
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

    class HttpMonarchTagProjectionBridge implements MonarchTagProjectionBridgeV1 {
      private readonly baseUrl: URL;
      private readonly token: string;

      constructor(
        environment: NodeJS.ProcessEnv,
        private readonly resolveTransactionId: (sourceRef: string) => Promise<string>
      ) {
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
        const transactionId = await this.resolveTransactionId(sourceRef);
        const value = exactObject(
          await this.request(
            "GET",
            `transactions/${encodeURIComponent(transactionId)}`
          ),
          ["contractVersion", "provenance", "transaction"]
        );
        const transaction = exactObject(value.transaction, [
          "id",
          "date",
          "amount",
          "merchant",
          "businessContext",
          "category",
          "account",
          "isPending",
          "isRecurring",
          "reviewStatus",
          "reviewAssignee",
          "statementDescriptors",
          "notes",
          "tags",
          "tagReferences",
        ]);
        if (transaction.id !== transactionId) throw new ReattributionIntegrationError();
        parseBridgeBusinessContext(transaction.businessContext);
        parseBridgeStatementDescriptors(transaction.statementDescriptors);
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
        const transactionId = await this.resolveTransactionId(sourceRef);
        let value: unknown;
        try {
          value = await this.request(
            "PATCH",
            `transactions/${encodeURIComponent(transactionId)}/tags`,
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
          response.transactionId !== transactionId ||
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
            redirect: "error",
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
          const reader = response.body?.getReader();
          if (!reader) throw new ReattributionIntegrationError();
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_INTEGRATION_RESPONSE_BYTES) {
              await reader.cancel();
              throw new ReattributionIntegrationError();
            }
            chunks.push(value);
          }
          return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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

function parseBridgeStatementDescriptors(value: unknown): void {
  if (!Array.isArray(value) || value.length > 2) {
    throw new ReattributionIntegrationError();
  }
  const kinds = value.map((item) => {
    const descriptor = exactObject(item, ["kind", "text", "source"]);
    const source = exactObject(descriptor.source, ["system", "field"]);
    if (
      typeof descriptor.text !== "string" ||
      descriptor.text.length === 0 ||
      new TextEncoder().encode(descriptor.text).byteLength > 2_048 ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(
        descriptor.text
      ) ||
      source.system !== "monarch" ||
      !(
        (descriptor.kind === "statement" && source.field === "plaidName") ||
        (descriptor.kind === "provider-description" &&
          source.field === "dataProviderDescription")
      )
    ) {
      throw new ReattributionIntegrationError();
    }
    return descriptor.kind;
  });
  if (new Set(kinds).size !== kinds.length) {
    throw new ReattributionIntegrationError();
  }
}

function parseBridgeBusinessContext(value: unknown): void {
  if (value === null) return;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 120 ||
    value !== value.split(/\s+/u).join(" ") ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value)
  ) {
    throw new ReattributionIntegrationError();
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}
