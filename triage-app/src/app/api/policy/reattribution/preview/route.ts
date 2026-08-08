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

const MAX_PREVIEW_RECORDS = 100;

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    validatePolicyMutationOrigin(request);
    const actor = resolvePolicyActor(request);
    const body = strictObject(await readPolicyJson(request), [
      "expectedPolicyVersion",
      "sourceRefs",
    ]);
    if (
      !Array.isArray(body.sourceRefs) ||
      body.sourceRefs.length === 0 ||
      body.sourceRefs.length > MAX_PREVIEW_RECORDS
    ) {
      throw new PreviewSelectionError();
    }
    const sourceRefs = body.sourceRefs.map((sourceRef) => {
      if (typeof sourceRef !== "string") throw new PreviewSelectionError();
      return sourceRef;
    });
    const preview = await getPolicyRuntime().getReattributionService().preview(actor, {
      contractVersion: TYRION_DOMAIN_CONTRACT_VERSION,
      householdId: actor.householdId,
      expectedPolicyVersion: positiveInteger(body.expectedPolicyVersion),
      sourceRefs,
    });
    const summary = preview.items.reduce(
      (counts, item) => {
        counts[item.disposition] += 1;
        return counts;
      },
      {
        unchanged: 0,
        "would-update": 0,
        "manual-preserved": 0,
        "pending-review": 0,
      }
    );
    return policyJson({
      preview: {
        previewId: preview.previewId,
        policyVersion: preview.policyVersion,
        createdAt: preview.createdAt,
        expiresAt: preview.expiresAt,
        selectedCount: preview.items.length,
        summary,
      },
    });
  } catch (error) {
    return handlePolicyRouteError(error);
  }
}

class PreviewSelectionError extends PolicyRequestError {
  constructor() {
    super(
      "invalid_reattribution_selection",
      422,
      "Select between 1 and 100 opaque records"
    );
    this.name = "PreviewSelectionError";
  }
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PreviewSelectionError();
  }
  return value as number;
}
