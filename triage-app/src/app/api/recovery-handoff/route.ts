import { NextResponse } from "next/server";
import { resolveMissionControlHandoff } from "@/lib/reconnect-handoff.mjs";

export const dynamic = "force-dynamic";

export function GET() {
  const handoff = resolveMissionControlHandoff(
    process.env.MISSION_CONTROL_RETURN_URL,
    process.env.MISSION_CONTROL_RETURN_ALLOWED_ORIGINS
  );
  return NextResponse.json(handoff, {
    headers: { "Cache-Control": "no-store" },
  });
}
