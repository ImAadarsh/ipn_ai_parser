import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { lastCleanupAt, retentionDays } from "@/lib/cleanup";
import {
  gradeBreakdown,
  initSchema,
  pipelineHasWork,
  pipelineSummary,
  schoolBreakdown,
  studentStats,
  usageSummary,
  workerPaused,
} from "@/lib/db";
import { usdInrRate, usdToInr } from "@/lib/pricing";
import { workerState } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  await initSchema();

  const [summary, usage, paused, hasWork, students, schools, grades, cleaned] =
    await Promise.all([
      pipelineSummary(),
      usageSummary(),
      workerPaused(),
      pipelineHasWork(),
      studentStats(),
      schoolBreakdown(),
      gradeBreakdown(),
      lastCleanupAt(),
    ]);

  const costUsd = Number(usage.cost_usd) || 0;

  return NextResponse.json({
    paused,
    hasWork,
    worker: workerState(),
    rate: usdInrRate(),
    retentionDays: retentionDays(),
    lastCleanupAt: cleaned,
    calls: Number(usage.calls) || 0,
    totalTokens: Number(usage.total_tokens) || 0,
    chargesInr: usdToInr(costUsd),
    unmeteredImages: Math.max(
      0,
      (Number(summary.images_processed) || 0) - (Number(usage.calls) || 0)
    ),
    pipelines: {
      pagesDone: Number(summary.pages_done) || 0,
      pagesTotal: Number(summary.pages_total) || 0,
      imagesDone: Number(summary.images_done) || 0,
      imagesProcessed: Number(summary.images_processed) || 0,
      imagesOk: Number(summary.images_ok) || 0,
      imagesReview: Number(summary.images_review) || 0,
      students: Number(summary.students) || 0,
      batches: Number(summary.batches) || 0,
    },
    students: {
      total: Number(students.total) || 0,
      named: Number(students.named) || 0,
      withEmail: Number(students.with_email) || 0,
      validEmails: Number(students.valid_emails) || 0,
      duplicates: Number(students.duplicates) || 0,
      invalidEmails: Number(students.invalid_emails) || 0,
      withGrade: Number(students.with_grade) || 0,
      withSchool: Number(students.with_school) || 0,
      schools: Number(students.schools) || 0,
      grades: Number(students.grades) || 0,
    },
    schools,
    grades,
  });
}
