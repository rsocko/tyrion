import { NextRequest } from "next/server";
import { resolveAttributionServiceActor } from "@/lib/attribution-auth";
import {
  attributionJson, handleAttributionError, parseAttributionJson, readAttributionBody,
} from "@/lib/attribution-http";
import { getPolicyRuntime } from "@/lib/policy-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = resolveAttributionServiceActor(request);
    const value = parseAttributionJson(await readAttributionBody(request));
    return attributionJson(await getPolicyRuntime().getDurableAttributionService().projection(actor, value));
  } catch (error) {
    return handleAttributionError(error);
  }
}
