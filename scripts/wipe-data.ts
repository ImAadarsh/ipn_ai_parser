import "./preload-env";
import { getPool, initSchema, setSetting } from "../src/lib/db";
import { PAGES_PER_COMPOSITE } from "../src/lib/constants";

async function main() {
  await initSchema();
  const db = getPool();

  await setSetting("worker_paused", "true");
  console.log("worker paused");

  const [students] = await db.query(`DELETE FROM students`);
  console.log(
    `deleted students: ${(students as { affectedRows: number }).affectedRows}`
  );

  const [distorted] = await db.query(`DELETE FROM distorted_images`);
  console.log(
    `deleted distorted records: ${(distorted as { affectedRows: number }).affectedRows}`
  );

  const [comps] = await db.query(
    `UPDATE composites
     SET status = 'pending', error_message = NULL,
         prompt_tokens = 0, completion_tokens = 0, total_tokens = 0, cost_usd = 0`
  );
  console.log(
    `reset composites to pending: ${(comps as { affectedRows: number }).affectedRows}`
  );

  const [batchRows] = await db.query(
    `SELECT b.id,
            (SELECT COUNT(*) FROM pages p WHERE p.batch_id = b.id) AS pages_total,
            (SELECT COUNT(*) FROM composites c WHERE c.batch_id = b.id) AS comps_total
     FROM batches b`
  );
  const batches = batchRows as Array<{
    id: number;
    pages_total: number;
    comps_total: number;
  }>;
  for (const batch of batches) {
    const needed = Math.ceil(Number(batch.pages_total) / PAGES_PER_COMPOSITE);
    const complete = needed > 0 && Number(batch.comps_total) >= needed;
    await db.query(`UPDATE batches SET status = ?, error_message = NULL WHERE id = ?`, [
      complete ? "composites_ready" : "pages_ready",
      batch.id,
    ]);
  }
  console.table(
    batches.map((batch) => ({
      batch: batch.id,
      pages: batch.pages_total,
      composites: batch.comps_total,
    }))
  );

  console.log("wipe complete - worker is PAUSED, nothing will auto-process");
  await db.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
