import "./preload-env";
import fs from "fs/promises";
import path from "path";
import { geminiPerRun } from "../src/lib/constants";
import {
  claimPendingComposite,
  finishComposite,
  getPool,
  initSchema,
  insertStudents,
  syncBatchAfterGemini,
  updateBatch,
} from "../src/lib/db";
import { extractStudentsFromComposite } from "../src/lib/extract";
import { withCronLock } from "../src/lib/lock";
import { COMPOSITE_DIR } from "../src/lib/paths";

async function run() {
  await initSchema();
  const limit = geminiPerRun();
  let processed = 0;

  while (processed < limit) {
    const composite = await claimPendingComposite();
    if (!composite) {
      if (processed === 0) console.log("No six-up image waiting for Gemini");
      break;
    }

    await updateBatch(composite.batch_id, { status: "parsing" });
    const imagePath = path.join(COMPOSITE_DIR, composite.file_path);

    try {
      const jpeg = await fs.readFile(imagePath);
      const pagesInGroup = composite.end_page - composite.start_page + 1;
      const { students, raw } = await extractStudentsFromComposite(
        jpeg,
        composite.start_page,
        pagesInGroup
      );
      await insertStudents(
        composite.batch_id,
        students,
        composite.file_path,
        raw
      );
      await finishComposite(composite.id, "done");
      console.log(
        `Composite ${composite.id}: saved ${students.length} students (pages ${composite.start_page}-${composite.end_page})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await finishComposite(composite.id, "error", message);
      console.error(`Composite ${composite.id} failed: ${message}`);
    }

    await syncBatchAfterGemini(composite.batch_id);
    processed += 1;
  }
}

async function main() {
  try {
    await withCronLock("gemini", run);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await getPool().end().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main();
