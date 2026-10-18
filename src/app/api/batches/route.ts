import { NextResponse } from "next/server";
import { initSchema, listBatches } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
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
