import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { lastCleanupAt, retentionDays } from "@/lib/cleanup";
import {
  distortedCount,
  gradeBreakdown,
  initSchema,
  pipelineHasWork,
  pipelineSummary,
  schoolBreakdown,
  studentStats,
  usageSummary,
  workerPaused,
} from "@/lib/db";
import { workerState } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  await initSchema();

  const [
    summary,
    usage,
    paused,
    hasWork,
    students,
    schools,
    grades,
    cleaned,
    distorted,
  ] = await Promise.all([
    pipelineSummary(),
    usageSummary(),
    workerPaused(),
    pipelineHasWork(),
    studentStats(),
    schoolBreakdown(),
    gradeBreakdown(),
    lastCleanupAt(),
    distortedCount(),
  ]);

  return NextResponse.json({
    paused,
    hasWork,
    worker: workerState(),
    retentionDays: retentionDays(),
    lastCleanupAt: cleaned,
    pipelines: {
      pagesDone: Number(summary.pages_done) || 0,
      pagesTotal: Number(summary.pages_total) || 0,
      imagesDone: Number(summary.images_done) || 0,
      imagesProcessed: Number(summary.images_processed) || 0,
      imagesOk: Number(summary.images_ok) || 0,
      imagesReview: Number(summary.images_review) || 0,
      students: Number(summary.students) || 0,
      batches: Number(summary.batches) || 0,
      distortedImages: distorted,
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
