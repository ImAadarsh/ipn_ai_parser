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
    if (Date.now() - stat.mtimeMs < STALE_MS) {
      console.log(`[${name}] skipped, already running`);
      return null;
    }
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
