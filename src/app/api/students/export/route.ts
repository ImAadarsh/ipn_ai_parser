import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { initSchema, listStudents } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function csvCell(value: unknown) {
  const text = value == null ? "" : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function GET(request: Request) {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  const { searchParams } = new URL(request.url);
  const batchId = searchParams.get("batchId");

  await initSchema();
  const students = await listStudents({
    batchId: batchId ? Number(batchId) : undefined,
    query: searchParams.get("q") || undefined,
    flag: searchParams.get("flag") || undefined,
    limit: 2000,
  });

  const header = [
    "batch_id",
    "source_page",
    "slot",
    "name",
    "email",
    "grade",
    "school_name",
    "issues",
    "is_duplicate",
    "valid_email",
  ];
  const lines = [header.join(",")];
  for (const row of students) {
    lines.push(
      header
        .map((key) => csvCell((row as Record<string, unknown>)[key]))
        .join(",")
    );
  }

  const name = batchId ? `students-batch-${batchId}.csv` : "students-all.csv";
  return new NextResponse(`\uFEFF${lines.join("\n")}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${name}"`,
    },
  });
}
