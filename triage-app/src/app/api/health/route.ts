import { NextResponse } from "next/server";
import { financeInsightHealth } from "@/lib/finance-insight-runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  const financeInsights = await financeInsightHealth();
  return NextResponse.json(
    { status: "ok", service: "tyrion-operations-ui", financeInsights },
    { headers: { "Cache-Control": "no-store" } }
  );
}
