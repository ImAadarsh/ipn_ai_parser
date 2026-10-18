import { NextResponse } from "next/server";
import { initSchema, listStudents } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId");
  try {
    await initSchema();
    const students = await listStudents(batchId ? Number(batchId) : undefined);
    return NextResponse.json({ students });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 500 }
    );
  }
}
