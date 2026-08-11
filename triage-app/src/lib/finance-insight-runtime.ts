import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  FINANCE_INSIGHT_DETECTOR_SET_VERSION_V1,
  FinanceInsightEvaluationOrchestratorV1,
  FinanceInsightLifecycleServiceV1,
  FinanceInsightSqliteStoreV1,
  parseFinanceInsightPolicySnapshotV1,
  type FinanceInsightPolicySnapshotV1,
  type FinanceInsightTelemetryEventV1,
} from "@rsocko/tyrion-finance-insights";

const HOUSEHOLD_SCOPE = "homelab-household";

export interface FinanceInsightRuntimeGates {
  evaluationWrite: boolean;
  read: boolean;
  actions: boolean;
}

export interface FinanceInsightRuntime {
  store: FinanceInsightSqliteStoreV1;
  lifecycle: FinanceInsightLifecycleServiceV1;
  orchestrator: FinanceInsightEvaluationOrchestratorV1;
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

  emit(event: FinanceInsightTelemetryEventV1): void {
    if (event.name === "evaluation_started") this.started += 1;
    else if (event.name === "evaluation_completed") this.completed += 1;
    else this.failed += 1;
  }

  snapshot(): Readonly<{
    evaluationStartedCount: number;
    evaluationCompletedCount: number;
    evaluationFailedCount: number;
  }> {
    return {
      evaluationStartedCount: this.started,
      evaluationCompletedCount: this.completed,
      evaluationFailedCount: this.failed,
    };
  }
}

let cachedRuntime: Promise<FinanceInsightRuntime> | undefined;

export function getFinanceInsightRuntime(
  environment: NodeJS.ProcessEnv = process.env
): Promise<FinanceInsightRuntime> {
  cachedRuntime ??= createFinanceInsightRuntime(environment).catch((error) => {
    cachedRuntime = undefined;
    throw error;
  });
  return cachedRuntime;
}

export async function createFinanceInsightRuntime(
  environment: NodeJS.ProcessEnv
): Promise<FinanceInsightRuntime> {
  try {
    const storePath = requireExternalAbsolutePath(
      environment.TYRION_FINANCE_INSIGHT_STORE_PATH
    );
    const policyPath = requireExternalAbsolutePath(
      environment.TYRION_FINANCE_INSIGHT_POLICY_PATH
    );
    const cursorKey = requireKey(environment.TYRION_FINANCE_INSIGHT_CURSOR_KEY);
    const identityKey = requireKey(
      environment.TYRION_FINANCE_INSIGHT_IDENTITY_KEY
    );
    const policy = loadPolicy(policyPath);
    const store = new FinanceInsightSqliteStoreV1({
      path: storePath,
      cursorKey,
    });
    try {
      await installPolicy(store, policy);
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
    return {
      store,
      lifecycle,
      orchestrator: new FinanceInsightEvaluationOrchestratorV1({
        store,
        lifecycle,
        identityKey,
        telemetry,
      }),
      gates: {
        evaluationWrite:
          environment.TYRION_FINANCE_INSIGHT_EVALUATION_WRITE_ENABLED === "true",
        read: environment.TYRION_FINANCE_INSIGHT_READ_ENABLED === "true",
        actions: environment.TYRION_FINANCE_INSIGHT_ACTIONS_ENABLED === "true",
      },
      telemetry,
    };
  } catch {
    throw new FinanceInsightRuntimeConfigurationError();
  }
}

export async function financeInsightHealth(): Promise<{
  status: "ready" | "disabled" | "unavailable";
  telemetry?: ReturnType<MetadataOnlyFinanceInsightTelemetry["snapshot"]>;
}> {
  try {
    const runtime = await getFinanceInsightRuntime();
    const enabled =
      runtime.gates.evaluationWrite || runtime.gates.read || runtime.gates.actions;
    return {
      status: enabled ? "ready" : "disabled",
      telemetry: runtime.telemetry.snapshot(),
    };
  } catch {
    return { status: "unavailable" };
  }
}

function requireKey(value: string | undefined): Uint8Array {
  if (!value) throw new FinanceInsightRuntimeConfigurationError();
  const key = Buffer.from(value, "utf8");
  if (key.byteLength < 32) throw new FinanceInsightRuntimeConfigurationError();
  return key;
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

function loadPolicy(path: string): FinanceInsightPolicySnapshotV1 {
  try {
    return parseFinanceInsightPolicySnapshotV1(
      JSON.parse(readFileSync(path, "utf8"))
    );
  } catch {
    throw new FinanceInsightRuntimeConfigurationError();
  }
}

async function installPolicy(
  store: FinanceInsightSqliteStoreV1,
  policy: FinanceInsightPolicySnapshotV1
): Promise<void> {
  try {
    await store.policies.append(policy);
  } catch {
    throw new FinanceInsightRuntimeConfigurationError();
  }
}
