import "./preload-env";
import { runCleanup } from "../src/lib/cleanup";
import {
  getPool,
  releaseStaleProcessing,
  workerLeaseHeld,
  workerPaused,
} from "../src/lib/db";
import { runPipelineOnce } from "../src/lib/pipeline";

const intervalMs = Number(process.env.CRON_INTERVAL_MS || 15000);
const cleanupEveryMs = Number(
  process.env.CLEANUP_INTERVAL_MS || 60 * 60 * 1000
);

let lastCleanup = 0;

async function cleanupIfDue() {
  if (Date.now() - lastCleanup < cleanupEveryMs) return;
  lastCleanup = Date.now();
  try {
    const result = await runCleanup();
    if (result.batches || result.deletedFiles) {
      console.log(
        `[cleanup] batches ${result.batches}, files ${result.deletedFiles}, sessions ${result.sessions}`
      );
    }
  } catch (error) {
    console.error("[cleanup] failed:", error);
  }
}

async function tick() {
  try {
    await cleanupIfDue();
    if (await workerLeaseHeld()) return;
    if (await workerPaused()) return;
    await runPipelineOnce();
  } catch (error) {
    console.error("[cron] tick failed:", error);
  }
}

async function main() {
  console.log(`[cron] application worker started (every ${intervalMs}ms)`);
  await releaseStaleProcessing(30).catch(() => 0);
  await tick();
  setInterval(tick, intervalMs);
}

main().catch(async (error) => {
  console.error(error);
  await getPool().end().catch(() => undefined);
  process.exit(1);
});
