import { NextRequest } from "next/server";
import { TYRION_DOMAIN_CONTRACT_VERSION } from "@rsocko/tyrion-kid-engine/contracts/v1";
import { resolvePolicyActor } from "@/lib/policy-auth";
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

export async function POST(request: NextRequest) {
  try {
    validatePolicyMutationOrigin(request);
    const actor = resolvePolicyActor(request);
    const body = strictObject(await readPolicyJson(request), [
      "previewId",
      "expectedPolicyVersion",
      "confirm",
    ]);
    if (body.confirm !== true) throw new InvalidApplyRequestError();
    const result = await getPolicyRuntime().getReattributionService().apply(actor, {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      householdId: actor.householdId,
      previewId: text(body.previewId),
      expectedPolicyVersion: positiveInteger(body.expectedPolicyVersion),
      confirm: body.confirm,
    });
    return policyJson({ result });
  } catch (error) {
    return handlePolicyRouteError(error);
  }
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new InvalidApplyRequestError();
  return value;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new InvalidApplyRequestError();
  }
  return value as number;
}

class InvalidApplyRequestError extends PolicyRequestError {
  constructor() {
    super(
      "invalid_reattribution_apply",
      422,
      "Re-attribution apply request is invalid"
    );
    this.name = "InvalidApplyRequestError";
  }
}
