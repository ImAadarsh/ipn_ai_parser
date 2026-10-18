import {
  acquireWorkerLease,
  pipelineCounts,
  pipelineHasWork,
  releaseStaleProcessing,
  releaseWorkerLease,
  setSetting,
  workerPaused,
} from "./db";
import { runPipelineOnce } from "./pipeline";

const LEASE_MS = 90_000;
const REFRESH_MS = 30_000;
const MAX_STEPS = 5000;
const STALL_LIMIT = 3;
const IDLE_SLEEP_MS = Number(process.env.WORKER_INTERVAL_MS || 1200);

type WorkerState = {
  running: boolean;
  step: number;
  startedAt: number | null;
  lastError: string | null;
};

// Route handlers are bundled separately by Next.js, so keep the worker state
// on the process-wide global instead of module scope.
const globalRef = globalThis as unknown as {
  __ipnWorkerState?: WorkerState;
};

function getState(): WorkerState {
  if (!globalRef.__ipnWorkerState) {
    globalRef.__ipnWorkerState = {
      running: false,
      step: 0,
      startedAt: null,
      lastError: null,
    };
  }
  return globalRef.__ipnWorkerState;
}

export function workerState() {
  return { ...getState() };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function startWorker() {
  const state = getState();
  if (state.running) {
    return { started: false, reason: "already running" };
  }
  if (!(await acquireWorkerLease(LEASE_MS))) {
    return { started: false, reason: "another worker is active" };
  }

  state.running = true;
  state.step = 0;
  state.startedAt = Date.now();
  state.lastError = null;

  runLoop()
    .catch((error) => {
      state.lastError = error instanceof Error ? error.message : String(error);
      console.error("[worker] crashed:", state.lastError);
    })
    .finally(async () => {
      state.running = false;
      state.startedAt = null;
      await releaseWorkerLease().catch(() => undefined);
    });

  return { started: true };
}

async function runLoop() {
  const state = getState();
  await setSetting("worker_paused", "false");
  await releaseStaleProcessing(30).catch(() => 0);

  let lastSignature = "";
  let stalls = 0;
  let lastRefresh = Date.now();

  while (state.step < MAX_STEPS) {
    if (await workerPaused()) {
      console.log("[worker] paused by operator");
      break;
    }

    let error: string | null = null;
    try {
      await runPipelineOnce();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      state.lastError = error;
      console.error("[worker] step error:", error);
    }

    state.step += 1;

    if (Date.now() - lastRefresh > REFRESH_MS) {
      await acquireWorkerLease(LEASE_MS);
      lastRefresh = Date.now();
    }

    const counts = await pipelineCounts();
    const signature = `${counts.pages}|${counts.composites}|${counts.settled}|${counts.students}`;
    if (signature === lastSignature) {
      stalls += error ? 2 : 1;
      if (stalls >= STALL_LIMIT) {
        console.log(
          "[worker] stopping: no progress for",
          stalls,
          "steps (guard against loops)"
        );
        break;
      }
    } else {
      stalls = 0;
      lastSignature = signature;
    }

    if (!(await pipelineHasWork())) {
      console.log("[worker] queue is empty, stopping");
      break;
    }

    await sleep(IDLE_SLEEP_MS);
  }
}
