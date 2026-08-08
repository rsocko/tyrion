import { NextRequest } from "next/server";
import { authorizePolicy } from "@rsocko/tyrion-kid-engine/policy";
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
    authorizePolicy(actor, actor.householdId, "write");
    const body = strictObject(await readPolicyJson(request), ["instrumentReference"]);
    if (typeof body.instrumentReference !== "string") {
      throw new PolicyRequestError(
        "invalid_instrument_reference",
        422,
        "Instrument reference must be a string"
      );
    }
    const instrumentFingerprint = getPolicyRuntime().fingerprintInstrument(
      actor.householdId,
      body.instrumentReference
    );
    return policyJson({ instrumentFingerprint });
  } catch (error) {
    return handlePolicyRouteError(error);
  }
}
