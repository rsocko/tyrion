import { NextRequest } from "next/server";
import {
  createDefaultPolicyDraftV1,
  parsePolicyDraftV1,
  policyDraftFromSnapshotV1,
} from "@rsocko/tyrion-kid-engine/contracts/v2";
import { resolveHomelabPolicyActor } from "@/lib/homelab-identity";
import {
  handlePolicyRouteError,
  policyJson,
  PolicyRequestError,
  readPolicyJson,
  strictObject,
  validatePolicyMutationOrigin,
} from "@/lib/policy-http";
import { getPolicyRuntime } from "@/lib/policy-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const actor = resolveHomelabPolicyActor();
    const runtime = getPolicyRuntime();
    const policy = await runtime.policyService.getPolicy(actor, actor.householdId);
    return policyJson({
      mode: runtime.mode,
      policy,
      draft: policy
        ? policyDraftFromSnapshotV1(policy)
        : createDefaultPolicyDraftV1(),
      capabilities: {
        write: actor.permissions.includes("policy:write"),
        previewReattribution: actor.permissions.includes("reattribution:preview"),
        applyReattribution: actor.permissions.includes("reattribution:apply"),
      },
    });
  } catch (error) {
    return handlePolicyRouteError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    validatePolicyMutationOrigin(request);
    const actor = resolveHomelabPolicyActor();
    const runtime = getPolicyRuntime();
    const body = strictObject(await readPolicyJson(request), [
      "expectedPolicyVersion",
      "policy",
    ]);
    const expectedPolicyVersion =
      body.expectedPolicyVersion === null
        ? null
        : positiveInteger(body.expectedPolicyVersion, "expectedPolicyVersion");
    const policy = await runtime.policyService.replacePolicy(
      actor,
      actor.householdId,
      {
        expectedPolicyVersion,
        policy: parsePolicyDraftV1(body.policy),
      }
    );
    return policyJson({ policy });
  } catch (error) {
    return handlePolicyRouteError(error);
  }
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PolicyRequestError(
      "invalid_request",
      400,
      `${field} must be a positive integer`
    );
  }
  return value as number;
}
