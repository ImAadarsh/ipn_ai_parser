import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { retentionDays, runCleanup } from "@/lib/cleanup";
import {
  getPool,
  initSchema,
  pipelineHasWork,
  releaseStaleProcessing,
  setSetting,
  workerPaused,
} from "@/lib/db";
import { runPipelineOnce } from "@/lib/pipeline";
import { startWorker, workerState } from "@/lib/worker";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  await initSchema();
  return NextResponse.json({
    paused: await workerPaused(),
    hasWork: await pipelineHasWork(),
    worker: workerState(),
  });
}

export async function POST(request: Request) {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
  };
  await initSchema();

  switch (body.action) {
    case "start": {
      await setSetting("worker_paused", "false");
      await releaseStaleProcessing(20);
      const result = await startWorker();
      return NextResponse.json({
        ok: true,
        paused: false,
        ...result,
        worker: workerState(),
      });
    }
    case "pause":
      await setSetting("worker_paused", "true");
      return NextResponse.json({ ok: true, paused: true });
    case "run":
      await setSetting("worker_paused", "false");
      await runPipelineOnce();
      return NextResponse.json({ ok: true, ran: true });
    case "retry-review":
      await getPool().query(
        `UPDATE composites SET status = 'pending', error_message = NULL WHERE status = 'review'`
      );
      await setSetting("worker_paused", "false");
      return NextResponse.json({ ok: true });
    case "recover": {
      const recovered = await releaseStaleProcessing(10);
      return NextResponse.json({ ok: true, recovered });
    }
    case "cleanup": {
      const result = await runCleanup(retentionDays());
      return NextResponse.json({ ok: true, ...result });
    }
    default:
      return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }
}
