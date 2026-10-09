import { NextRequest } from "next/server";
import { resolveAttributionServiceActor } from "@/lib/attribution-auth";
import {
  attributionJson,
  handleAttributionError,
} from "@/lib/attribution-http";
import { getPolicyRuntime } from "@/lib/policy-runtime";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const actor = resolveAttributionServiceActor(request);
    const response =
      await getPolicyRuntime().attributionPolicyService.discover(actor);
    return attributionJson(response);
  } catch (error) {
    return handleAttributionError(error);
  }
}
