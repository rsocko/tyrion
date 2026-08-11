import { NextRequest } from "next/server";
import { handleFinanceInsightRequest } from "@/lib/finance-insight-service";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ path: string[] }>;
}

async function handle(request: NextRequest, context: RouteContext) {
  const { path } = await context.params;
  return handleFinanceInsightRequest(request, path);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
