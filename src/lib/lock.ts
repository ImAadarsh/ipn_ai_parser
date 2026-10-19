import fs from "fs/promises";
import path from "path";
import { LOCK_DIR } from "./paths";

const STALE_MS = 2 * 60 * 60 * 1000;

export async function withCronLock<T>(
  name: string,
  fn: () => Promise<T>
): Promise<T | null> {
  await fs.mkdir(LOCK_DIR, { recursive: true });
  const lockPath = path.join(LOCK_DIR, `${name}.lock`);

  try {
    const stat = await fs.stat(lockPath);
    const content = await fs.readFile(lockPath, "utf8").catch(() => "");
    const pid = Number(content.trim().split(/\s+/)[0]);
    let alive = false;
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    const stale = Date.now() - stat.mtimeMs > STALE_MS;
    // A lock owned by a dead process must never block the pipeline after a
    // restart/kill — only honour locks from live processes.
    if (alive && !stale) {
      console.log(`[${name}] skipped, already running`);
      return null;
    }
    console.log(`[${name}] stealing stale lock (pid ${pid || "?"})`);
    await fs.unlink(lockPath);
  } catch {
    // no lock
  }

  await fs.writeFile(lockPath, `${process.pid} ${new Date().toISOString()}`);
  try {
    return await fn();
  } finally {
    await fs.unlink(lockPath).catch(() => undefined);
  }
}
