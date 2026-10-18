import "./preload-env";
import fs from "fs/promises";
import path from "path";
import { PAGES_PER_COMPOSITE, compositesPerRun } from "../src/lib/constants";
import {
  findBatchByStatus,
  getPool,
  initSchema,
  insertComposite,
  listComposites,
  listPages,
  updateBatch,
} from "../src/lib/db";
import { withCronLock } from "../src/lib/lock";
import { COMPOSITE_DIR, PAGE_DIR } from "../src/lib/paths";
import { composeGrid } from "../src/lib/pdf";

async function run() {
  await initSchema();
  const batch = await findBatchByStatus(["pages_ready", "composing"]);
  if (!batch) {
    console.log("No page set waiting for 6-up compose");
    return;
  }

  await updateBatch(batch.id, { status: "composing", error_message: null });
  await fs.mkdir(COMPOSITE_DIR, { recursive: true });

  const pages = await listPages(batch.id);
  const existing = new Set(
    (await listComposites(batch.id)).map((row) => row.start_page)
  );

  let made = 0;
  const limit = compositesPerRun();
  for (let i = 0; i < pages.length; i += PAGES_PER_COMPOSITE) {
    const group = pages.slice(i, i + PAGES_PER_COMPOSITE);
    const startPage = group[0].page_number;
    const endPage = group[group.length - 1].page_number;
    if (existing.has(startPage)) continue;

    const images = await Promise.all(
      group.map(async (page) => ({
        pageNumber: page.page_number,
        image: await fs.readFile(path.join(PAGE_DIR, page.file_path)),
      }))
    );
    const jpeg = await composeGrid(images, PAGES_PER_COMPOSITE);
    const filename = `batch-${batch.id}-p${String(startPage).padStart(4, "0")}-p${String(endPage).padStart(4, "0")}.jpg`;
    await fs.writeFile(path.join(COMPOSITE_DIR, filename), jpeg);
    await insertComposite({
      batchId: batch.id,
      startPage,
      endPage,
      filePath: filename,
    });
    made += 1;
    console.log(`Batch ${batch.id}: composed pages ${startPage}-${endPage}`);
    if (made >= limit) break;
  }

  const needed = Math.ceil(pages.length / PAGES_PER_COMPOSITE);
  const have = (await listComposites(batch.id)).length;
  if (have >= needed && needed > 0) {
    await updateBatch(batch.id, { status: "composites_ready", error_message: null });
    console.log(`Batch ${batch.id}: ${have} six-up images ready for Gemini`);
    return;
  }

  console.log(`Batch ${batch.id}: ${have}/${needed} six-up images, +${made} this cycle`);
}

async function main() {
  try {
    await withCronLock("compose-six", run);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await getPool().end().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main();
