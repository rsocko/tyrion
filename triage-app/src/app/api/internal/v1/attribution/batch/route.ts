import { NextRequest } from "next/server";
import { resolveAttributionServiceActor } from "@/lib/attribution-auth";
import {
  attributionJson,
  handleAttributionError,
  parseAttributionJson,
  readAttributionBody,
} from "@/lib/attribution-http";
import { getPolicyRuntime } from "@/lib/policy-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = resolveAttributionServiceActor(request);
    const body = await readAttributionBody(request);
    const value = parseAttributionJson(body);
    const response = await getPolicyRuntime().attributionBatchService.attribute(
      actor,
      value
    );
    return attributionJson(response);
  } catch (error) {
    return handleAttributionError(error);
  }
}
