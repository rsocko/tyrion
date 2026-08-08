import type {
  PolicyDraftV1,
  PolicySnapshotV1,
  ReattributionApplyResultV1,
} from "@rsocko/tyrion-kid-engine/contracts/v1";

export interface PolicyCapabilities {
  write: boolean;
  previewReattribution: boolean;
  applyReattribution: boolean;
}

export interface PolicyLoadResult {
  mode: "demo" | "production";
  policy: PolicySnapshotV1 | null;
  draft: PolicyDraftV1;
  capabilities: PolicyCapabilities;
}

export interface ReattributionPreviewSummary {
  previewId: string;
  policyVersion: number;
  createdAt: string;
  expiresAt: string;
  selectedCount: number;
  summary: {
    unchanged: number;
    "would-update": number;
    "manual-preserved": number;
    "pending-review": number;
  };
}

export class PolicyApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "PolicyApiError";
  }
}

export function loadPolicy(): Promise<PolicyLoadResult> {
  return request("/api/policy");
}

export function savePolicy(
  expectedPolicyVersion: number | null,
  policy: PolicyDraftV1
): Promise<{ policy: PolicySnapshotV1 }> {
  return request("/api/policy", {
    method: "PUT",
    body: JSON.stringify({ expectedPolicyVersion, policy }),
  });
}

export function fingerprintInstrument(
  instrumentReference: string
): Promise<{ instrumentFingerprint: string }> {
  return request("/api/policy/instruments/fingerprint", {
    method: "POST",
    body: JSON.stringify({ instrumentReference }),
  });
}

export function previewReattribution(
  expectedPolicyVersion: number,
  sourceRefs: string[]
): Promise<{ preview: ReattributionPreviewSummary }> {
  return request("/api/policy/reattribution/preview", {
    method: "POST",
    body: JSON.stringify({ expectedPolicyVersion, sourceRefs }),
  });
}

export function applyReattribution(
  previewId: string,
  expectedPolicyVersion: number
): Promise<{ result: ReattributionApplyResultV1 }> {
  return request("/api/policy/reattribution/apply", {
    method: "POST",
    body: JSON.stringify({
      previewId,
      expectedPolicyVersion,
      confirm: true,
    }),
  });
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      cache: "no-store",
      credentials: "same-origin",
      headers: init.body
        ? { Accept: "application/json", "Content-Type": "application/json" }
        : { Accept: "application/json" },
    });
  } catch {
    throw new PolicyApiError(
      0,
      "policy_api_unavailable",
      "Tyrion policy configuration is unavailable"
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PolicyApiError(
      response.status,
      "invalid_policy_response",
      "Tyrion returned an invalid policy response"
    );
  }
  if (!response.ok) {
    const error = readError(payload);
    throw new PolicyApiError(response.status, error.code, error.message);
  }
  return payload as T;
}

function readError(value: unknown): { code: string; message: string } {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "code" in value.error &&
    "message" in value.error &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  ) {
    return { code: value.error.code, message: value.error.message };
  }
  return {
    code: "policy_operation_failed",
    message: "Policy operation failed",
  };
}
