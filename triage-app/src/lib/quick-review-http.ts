import { NextRequest, NextResponse } from "next/server";
import {
  QuickReviewValidationError,
  prepareVendorResearchV1,
  rankQuickReviewV1,
  suggestMerchantRuleV1,
} from "@rsocko/tyrion-kid-engine";
import {
  AttributionAuthError,
  resolveAttributionServiceActor,
} from "@/lib/attribution-auth";
import {
  AttributionRequestError,
  parseAttributionJson,
  readAttributionBody,
} from "@/lib/attribution-http";
import { getPolicyRuntime } from "@/lib/policy-runtime";

export type QuickReviewOperation = "rank" | "research" | "rule-suggestion";

export async function handleQuickReviewRequest(
  request: NextRequest,
  operation: string
) {
  try {
    const actor = resolveAttributionServiceActor(request);
    const body = parseAttributionJson(await readAttributionBody(request));
    const response =
      operation === "rank"
        ? rankQuickReviewV1(body)
        : operation === "research"
          ? prepareVendorResearchV1(body)
          : operation === "rule-suggestion"
            ? {
                ...suggestMerchantRuleV1(body),
                policyVersion: (
                  await getPolicyRuntime().attributionPolicyService.discover(actor)
                ).policyVersion,
              }
            : null;
    if (response === null) {
      return jsonError(
        404,
        "quick_review_route_not_available",
        "Quick Review operation is not available"
      );
    }
    return NextResponse.json(response, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (
      error instanceof AttributionRequestError ||
      error instanceof AttributionAuthError
    ) {
      return jsonError(error.status, error.code, error.message);
    }
    if (error instanceof QuickReviewValidationError) {
      const status =
        error.code === "batch_too_large"
          ? 413
          : error.code === "research_disclosure_required"
            ? 422
            : 400;
      return jsonError(status, error.code, error.message);
    }
    return jsonError(
      500,
      "quick_review_operation_failed",
      "Quick Review operation failed"
    );
  }
}

function jsonError(status: number, code: string, message: string) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}
