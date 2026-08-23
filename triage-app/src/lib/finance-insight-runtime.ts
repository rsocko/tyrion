import { isAbsolute, relative, resolve } from "node:path";
import {
  createCandidatePolicySnapshotV1,
  FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
  FinanceAutomationJobServiceV1,
  FinanceAutomationSqliteStoreV1,
  FinanceInsightEvaluationOrchestratorV1,
  FinanceInsightLifecycleServiceV1,
  FinanceInsightSqliteStoreV1,
  type FinanceInsightTelemetryEventV1,
  type FinanceAutomationTelemetryEventV1,
  type FinanceAutomationJobRequestV1,
  type FinanceAutomationJobResultV1,
  type FinanceAutomationDeliveryAckRequestV1,
  type FinanceAutomationDeliveryAckResultV1,
} from "@rsocko/tyrion-finance-insights";

const HOUSEHOLD_SCOPE = "homelab-household";
const DEFAULT_POLICY_CURRENCY = "USD";
const DEFAULT_POLICY_TIMEZONE = "America/New_York";
const DEFAULT_POLICY_EFFECTIVE_AT = [
  "1970-01-01T00:00:00.000Z",
  "1970-01-02T00:00:00.000Z",
] as const;
const RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const FINANCE_INSIGHT_IDENTITY_NAMESPACE = new TextEncoder().encode(
  "tyrion/finance-insight/identity/v1"
);
const FINANCE_INSIGHT_CURSOR_CHECKSUM_NAMESPACE = new TextEncoder().encode(
  "tyrion/finance-insight/cursor-checksum/v1"
);

export interface FinanceInsightRuntimeGates {
  evaluationWrite: boolean;
  read: boolean;
  actions: boolean;
  automationWrite: boolean;
}

export interface FinanceInsightRuntime {
  store: FinanceInsightSqliteStoreV1;
  identityNamespace: Uint8Array;
  lifecycle: FinanceInsightLifecycleServiceV1;
  orchestrator: FinanceInsightEvaluationOrchestratorV1;
  runAutomation(
    request: FinanceAutomationJobRequestV1
  ): Promise<FinanceAutomationJobResultV1>;
  acknowledgeAutomationDeliveries(
    request: FinanceAutomationDeliveryAckRequestV1
  ): Promise<FinanceAutomationDeliveryAckResultV1>;
  gates: FinanceInsightRuntimeGates;
  telemetry: MetadataOnlyFinanceInsightTelemetry;
}

export class FinanceInsightRuntimeConfigurationError extends Error {
  constructor() {
    super("Finance insight runtime is not configured");
    this.name = "FinanceInsightRuntimeConfigurationError";
  }
}

export class MetadataOnlyFinanceInsightTelemetry {
  private started = 0;
  private completed = 0;
  private failed = 0;
  private automationStarted = 0;
  private automationCompleted = 0;
  private automationRejected = 0;
  private automationFailed = 0;

  emit(
    event: FinanceInsightTelemetryEventV1 | FinanceAutomationTelemetryEventV1
  ): void {
    if (event.name === "evaluation_started") this.started += 1;
    else if (event.name === "evaluation_completed") this.completed += 1;
    else if (event.name === "evaluation_failed") this.failed += 1;
    else if (event.name === "automation_job_started") this.automationStarted += 1;
    else if (event.name === "automation_job_completed") this.automationCompleted += 1;
    else if (event.name === "automation_job_rejected") this.automationRejected += 1;
    else this.automationFailed += 1;
  }

  snapshot(): Readonly<{
    evaluationStartedCount: number;
    evaluationCompletedCount: number;
    evaluationFailedCount: number;
    automationStartedCount: number;
    automationCompletedCount: number;
    automationRejectedCount: number;
    automationFailedCount: number;
  }> {
    return {
      evaluationStartedCount: this.started,
      evaluationCompletedCount: this.completed,
      evaluationFailedCount: this.failed,
      automationStartedCount: this.automationStarted,
      automationCompletedCount: this.automationCompleted,
      automationRejectedCount: this.automationRejected,
      automationFailedCount: this.automationFailed,
    };
  }
}

let cachedRuntime: Promise<FinanceInsightRuntime> | undefined;
const runtimeMaintenance = new WeakMap<
  FinanceInsightRuntime,
  FinanceInsightRuntimeMaintenance
>();

export async function getFinanceInsightRuntime(
  environment: NodeJS.ProcessEnv = process.env
): Promise<FinanceInsightRuntime> {
  cachedRuntime ??= createFinanceInsightRuntime(environment).catch((error) => {
    cachedRuntime = undefined;
    throw error;
  });
  const runtime = await cachedRuntime;
  await runtimeMaintenance.get(runtime)?.runIfDue();
  return runtime;
}

export async function createFinanceInsightRuntime(
  environment: NodeJS.ProcessEnv
): Promise<FinanceInsightRuntime> {
  try {
    const testClock = financeInsightTestClock(environment);
    const storePath = requireExternalAbsolutePath(
      environment.TYRION_FINANCE_INSIGHT_STORE_PATH
    );
    const identityNamespace = FINANCE_INSIGHT_IDENTITY_NAMESPACE;
    const store = new FinanceInsightSqliteStoreV1({
      path: storePath,
      cursorChecksumNamespace: FINANCE_INSIGHT_CURSOR_CHECKSUM_NAMESPACE,
      ...(testClock ? { clock: testClock } : {}),
    });
    const maintenance = new FinanceInsightRuntimeMaintenance(store);
    try {
      await initializeDefaultPolicies(store);
      await maintenance.runIfDue();
    } catch (error) {
      store.close();
      throw error;
    }
    const lifecycle = new FinanceInsightLifecycleServiceV1({
      store,
      householdScope: HOUSEHOLD_SCOPE,
      detectorSetVersion: FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
    });
    const telemetry = new MetadataOnlyFinanceInsightTelemetry();
    const withAutomationStore = async <T>(
      operation: (service: FinanceAutomationJobServiceV1) => Promise<T>
    ): Promise<T> => {
      const automationStore = new FinanceAutomationSqliteStoreV1({
        path: storePath,
      });
      try {
        return await operation(
          new FinanceAutomationJobServiceV1({
            store: automationStore,
            identityNamespace,
            telemetry,
          })
        );
      } finally {
        automationStore.close();
      }
    };
    const runtime = {
      store,
      identityNamespace: Uint8Array.from(identityNamespace),
      lifecycle,
      orchestrator: new FinanceInsightEvaluationOrchestratorV1({
        store,
        lifecycle,
        identityNamespace,
        telemetry,
        ...(testClock ? { clock: testClock } : {}),
      }),
      runAutomation: (request: FinanceAutomationJobRequestV1) =>
        withAutomationStore((service) => service.run(request)),
      acknowledgeAutomationDeliveries: (
        request: FinanceAutomationDeliveryAckRequestV1
      ) =>
        withAutomationStore((service) =>
          service.acknowledgeDeliveries(request)
        ),
      gates: {
        evaluationWrite:
          environment.TYRION_FINANCE_INSIGHT_EVALUATION_WRITE_ENABLED === "true",
        read: environment.TYRION_FINANCE_INSIGHT_READ_ENABLED === "true",
        actions: environment.TYRION_FINANCE_INSIGHT_ACTIONS_ENABLED === "true",
        automationWrite:
          environment.TYRION_FINANCE_AUTOMATION_WRITE_ENABLED === "true",
      },
      telemetry,
    };
    runtimeMaintenance.set(runtime, maintenance);
    return runtime;
  } catch {
    throw new FinanceInsightRuntimeConfigurationError();
  }
}

function financeInsightTestClock(
  environment: NodeJS.ProcessEnv
): (() => string) | undefined {
  const value = environment.TYRION_FINANCE_INSIGHT_TEST_ONLY_NOW;
  if (value === undefined) return undefined;
  if (environment.NODE_TEST_CONTEXT === undefined) {
    throw new FinanceInsightRuntimeConfigurationError();
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new FinanceInsightRuntimeConfigurationError();
  }
  const timestamp = new Date(parsed).toISOString();
  return () => timestamp;
}

class FinanceInsightRuntimeMaintenance {
  private nextCleanupAt = 0;
  private cleanupInFlight: Promise<void> | undefined;

  constructor(
    private readonly store: FinanceInsightSqliteStoreV1,
    private readonly now: () => number = Date.now
  ) {}

  async runIfDue(): Promise<void> {
    if (this.cleanupInFlight) {
      return this.cleanupInFlight;
    }
    if (this.now() < this.nextCleanupAt) {
      return;
    }
    const cleanup = this.store.cleanup().then(() => {
      this.nextCleanupAt = this.now() + RETENTION_CLEANUP_INTERVAL_MS;
    });
    this.cleanupInFlight = cleanup;
    try {
      await cleanup;
    } finally {
      if (this.cleanupInFlight === cleanup) {
        this.cleanupInFlight = undefined;
      }
    }
  }
}

export async function financeInsightHealth(): Promise<{
  status: "ready" | "disabled" | "unavailable";
  telemetry?: ReturnType<MetadataOnlyFinanceInsightTelemetry["snapshot"]>;
}> {
  try {
    const runtime = await getFinanceInsightRuntime();
    const enabled =
      runtime.gates.evaluationWrite ||
      runtime.gates.read ||
      runtime.gates.actions ||
      runtime.gates.automationWrite;
    return {
      status: enabled ? "ready" : "disabled",
      telemetry: runtime.telemetry.snapshot(),
    };
  } catch {
    return { status: "unavailable" };
  }
}

function requireExternalAbsolutePath(value: string | undefined): string {
  if (!value || !isAbsolute(value)) {
    throw new FinanceInsightRuntimeConfigurationError();
  }
  const path = resolve(value);
  const imageRoot = resolve(process.cwd(), "..");
  const pathFromImage = relative(imageRoot, path);
  if (
    pathFromImage === "" ||
    (!pathFromImage.startsWith("..") && !isAbsolute(pathFromImage))
  ) {
    throw new FinanceInsightRuntimeConfigurationError();
  }
  return path;
}

async function initializeDefaultPolicies(
  store: FinanceInsightSqliteStoreV1
): Promise<void> {
  try {
    await store.transaction(async () => {
      if (await store.policies.latest()) return;
      for (const [index, effectiveAt] of DEFAULT_POLICY_EFFECTIVE_AT.entries()) {
        await store.policies.append(
          createCandidatePolicySnapshotV1({
            policyVersion: index + 1,
            effectiveAt,
            currency: DEFAULT_POLICY_CURRENCY,
            timezone: DEFAULT_POLICY_TIMEZONE,
          })
        );
      }
    });
  } catch {
    throw new FinanceInsightRuntimeConfigurationError();
  }
}
