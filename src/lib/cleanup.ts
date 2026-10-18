import fs from "fs/promises";
import path from "path";
import {
  batchFiles,
  batchesForCleanup,
  deleteExpiredSessions,
  getSetting,
  markBatchFilesDeleted,
  setSetting,
} from "./db";
import { COMPOSITE_DIR, PAGE_DIR, UPLOAD_DIR } from "./paths";

export function retentionDays() {
  return Number(process.env.RETENTION_DAYS || 10);
}

export async function runCleanup(days = retentionDays()) {
  const batches = await batchesForCleanup(days);
  let deletedFiles = 0;

  for (const batch of batches) {
    try {
      if (batch.stored_path) {
        await fs
          .rm(path.join(UPLOAD_DIR, path.basename(batch.stored_path)), {
            force: true,
          })
          .catch(() => undefined);
        deletedFiles += 1;
      }
      await fs
        .rm(path.join(PAGE_DIR, `batch-${batch.id}`), {
          recursive: true,
          force: true,
        })
        .catch(() => undefined);
      for (const filePath of await batchFiles(batch.id)) {
        await fs
          .rm(path.join(COMPOSITE_DIR, filePath), { force: true })
          .catch(() => undefined);
        deletedFiles += 1;
      }
      await markBatchFilesDeleted(batch.id);
    } catch (error) {
      console.error(`[cleanup] batch ${batch.id} failed:`, error);
    }
  }

  const sessions = await deleteExpiredSessions().catch(() => 0);
  await setSetting("last_cleanup_at", new Date().toISOString());
  return { batches: batches.length, deletedFiles, sessions };
}

export async function lastCleanupAt() {
  return getSetting("last_cleanup_at");
}
