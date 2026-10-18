import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { initSchema, listBatches } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  try {
    await initSchema();
    const batches = await listBatches();
    return NextResponse.json({ batches });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 500 }
    );
  }
}
