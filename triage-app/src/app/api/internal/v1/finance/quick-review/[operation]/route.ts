import { NextRequest } from "next/server";
import { handleQuickReviewRequest } from "@/lib/quick-review-http";

type QuickReviewRouteContext =
  RouteContext<"/api/internal/v1/finance/quick-review/[operation]">;

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  context: QuickReviewRouteContext
) {
  const { operation } = await context.params;
  return handleQuickReviewRequest(request, operation);
}
