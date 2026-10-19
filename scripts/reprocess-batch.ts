import "./preload-env";
import { PAGES_PER_COMPOSITE } from "../src/lib/constants";
import { getPool, initSchema } from "../src/lib/db";
import { aiModel, aiProvider } from "../src/lib/extract";
import { runCompose, runGemini } from "../src/lib/pipeline";

async function main() {
  const batchId = Number(process.argv[2]);
  if (!Number.isFinite(batchId) || batchId <= 0) {
    throw new Error("usage: tsx scripts/reprocess-batch.ts <batchId>");
  }

  await initSchema();
  const db = getPool();

  const [batchRows] = await db.query(
    `SELECT id, filename, status, total_pages FROM batches WHERE id = ?`,
    [batchId]
  );
  const batch = (
    batchRows as Array<{
      id: number;
      filename: string;
      status: string;
      total_pages: number;
    }>
  )[0];
  if (!batch) throw new Error(`batch ${batchId} not found`);

  console.log(
    `testing batch ${batch.id} "${batch.filename}" (${batch.total_pages} pages) with provider=${aiProvider()} model=${aiModel()}`
  );

  const [countRows] = await db.query(
    `SELECT
       (SELECT COUNT(*) FROM pages WHERE batch_id = ?) AS pages_total,
       (SELECT COUNT(*) FROM composites WHERE batch_id = ?) AS comps_total`,
    [batchId, batchId]
  );
  const counts = countsOf(countRows);
  const needed = Math.ceil(counts.pagesTotal / PAGES_PER_COMPOSITE);
  if (counts.compsTotal < needed) {
    console.log(
      `composing missing images (${counts.compsTotal}/${needed}) before AI pass`
    );
    await db.query(`UPDATE batches SET status = 'pages_ready' WHERE id = ?`, [
      batchId,
    ]);
    for (let i = 0; i < 60; i += 1) {
      await runCompose({ ignorePause: true });
      const [afterRows] = await db.query(
        `SELECT COUNT(*) AS comps_total FROM composites WHERE batch_id = ?`,
        [batchId]
      );
      const after = countsOf(afterRows);
      if (after.compsTotal >= needed) break;
    }
  }

  await db.query(
    `UPDATE composites SET status = 'pending', error_message = NULL WHERE batch_id = ?`,
    [batchId]
  );

  const processed = await runGemini({ ignorePause: true, batchId, limit: 1000 });
  void processed;

  const [composites] = await db.query(
    `SELECT id, start_page, end_page, status, error_message,
            prompt_tokens, completion_tokens, total_tokens
     FROM composites WHERE batch_id = ? ORDER BY start_page ASC`,
    [batchId]
  );
  const [students] = await db.query(
    `SELECT source_page, slot, name, email, grade, grade_number, school_name, issues
     FROM students WHERE batch_id = ? ORDER BY source_page ASC`,
    [batchId]
  );
  const [distorted] = await db.query(
    `SELECT page_number, reason, model FROM distorted_images
     WHERE batch_id = ? ORDER BY page_number ASC`,
    [batchId]
  );
  const [usage] = await db.query(
    `SELECT COALESCE(SUM(prompt_tokens),0) AS prompt_tokens,
            COALESCE(SUM(completion_tokens),0) AS completion_tokens,
            COALESCE(SUM(total_tokens),0) AS total_tokens
     FROM composites WHERE batch_id = ?`,
    [batchId]
  );

  console.log("\n=== composites ===");
  console.table(composites);
  console.log("\n=== students ===");
  console.table(students);
  console.log("\n=== distorted pages ===");
  console.table(distorted);
  console.log("\n=== tokens ===");
  console.table(usage);

  await db.end();
}

function countsOf(rows: unknown) {
  const row = (rows as Array<Record<string, number>>)[0] ?? {};
  return {
    pagesTotal: Number(row.pages_total || 0),
    compsTotal: Number(row.comps_total || 0),
  };
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
