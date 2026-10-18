import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { initSchema, listStudents } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId");
  try {
    await initSchema();
    const grade = searchParams.get("grade");
    const students = await listStudents({
      batchId: batchId ? Number(batchId) : undefined,
      query: searchParams.get("q") || undefined,
      flag: searchParams.get("flag") || undefined,
      gradeNumber: grade ? Number(grade) : undefined,
      limit: searchParams.get("limit")
        ? Number(searchParams.get("limit"))
        : undefined,
    });
    return NextResponse.json({ students });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Database error" },
      { status: 500 }
    );
  }
}
