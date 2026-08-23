import { NextRequest } from "next/server";
import { resolveAttributionServiceActor } from "@/lib/attribution-auth";
import { attributionJson, handleAttributionError } from "@/lib/attribution-http";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = resolveAttributionServiceActor(request);
    void actor;
    return attributionJson(
      {
        error: {
          code: "contract_version_retired",
          message: "Attribution contract v1 is retired; use v2",
        },
      },
      410
    );
  } catch (error) {
    return handleAttributionError(error);
  }
}
