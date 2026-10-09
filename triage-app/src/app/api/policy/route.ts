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
import {
  AccountCatalogServerError,
  loadAccountCatalogServer,
} from "@/lib/account-catalog-server";

export const dynamic = "force-dynamic";

export async function GET() {
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
    const draft = parsePolicyDraftV1(body.policy);
    const current = await runtime.policyService.getPolicy(
      actor,
      actor.householdId
    );
    if (
      JSON.stringify(current?.accountDefaults ?? []) !==
      JSON.stringify(draft.accountDefaults)
    ) {
      let accountRefs: Set<string>;
      try {
        accountRefs = new Set(
          (await loadAccountCatalogServer()).map((account) => account.accountRef)
        );
      } catch (caught) {
        if (caught instanceof AccountCatalogServerError) {
          throw new PolicyRequestError(
            "account_catalog_unavailable",
            503,
            "Account defaults cannot be changed while the account catalog is unavailable"
          );
        }
        throw caught;
      }
      const currentDefaults = new Map(
        (current?.accountDefaults ?? []).map((accountDefault) => [
          accountDefault.accountRef,
          accountDefault,
        ])
      );
      for (const accountDefault of draft.accountDefaults) {
        const existing = currentDefaults.get(accountDefault.accountRef);
        const unchangedStale =
          existing !== undefined &&
          JSON.stringify(existing) === JSON.stringify(accountDefault);
        if (!accountRefs.has(accountDefault.accountRef) && !unchangedStale) {
          throw new PolicyRequestError(
            "account_reference_not_found",
            422,
            "Account default must reference an account in the current Bridge catalog"
          );
        }
      }
    }
    const policy = await runtime.policyService.replacePolicy(
      actor,
      actor.householdId,
      {
        expectedPolicyVersion,
        policy: draft,
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
