import { NextRequest } from "next/server";
import { resolveAttributionServiceActor } from "@/lib/attribution-auth";
import {
  attributionJson,
  handleAttributionError,
  parseAttributionJson,
  readAttributionBody,
} from "@/lib/attribution-http";
import { loadAccountCatalogServer } from "@/lib/account-catalog-server";
import { getPolicyRuntime } from "@/lib/policy-runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const actor = resolveAttributionServiceActor(request);
    const value = parseAttributionJson(await readAttributionBody(request));
    const runtime = getPolicyRuntime();
    const response = await runtime.merchantRuleCreationService.create(
      actor,
      value,
      async (accountRefs) => {
        const catalog = await loadAccountCatalogServer();
        const available = new Set(catalog.map((account) => account.accountRef));
        return accountRefs.every((accountRef) => available.has(accountRef));
      }
    );
    return attributionJson(response);
  } catch (error) {
    return handleAttributionError(error, {
      code: "merchant_rule_creation_failed",
      message: "Merchant rule creation failed",
    });
  }
}
