import "./preload-env";
import fs from "fs/promises";
import path from "path";
import { PAGES_PER_COMPOSITE, extractPagesPerRun } from "../src/lib/constants";
import {
  existingPageNumbers,
  findBatchByStatus,
  getPool,
  initSchema,
  insertPage,
  updateBatch,
} from "../src/lib/db";
import { withCronLock } from "../src/lib/lock";
import { PAGE_DIR, UPLOAD_DIR } from "../src/lib/paths";
import { openPdf } from "../src/lib/pdf";

async function run() {
  await initSchema();
  const batch = await findBatchByStatus(["uploaded", "extracting_pages"]);
  if (!batch) {
    console.log("No PDF waiting for page split");
    return;
  }

  const pdfPath = path.isAbsolute(batch.stored_path)
    ? batch.stored_path
    : path.join(UPLOAD_DIR, path.basename(batch.stored_path));

  try {
    await fs.access(pdfPath);
  } catch {
    await updateBatch(batch.id, {
      status: "error",
      error_message: `PDF missing on server: ${pdfPath}`,
    });
    return;
  }

  await updateBatch(batch.id, { status: "extracting_pages", error_message: null });
  const buffer = await fs.readFile(pdfPath);
  const pdf = await openPdf(buffer);
  await updateBatch(batch.id, { total_pages: pdf.numPages });

  const done = await existingPageNumbers(batch.id);
  const folder = path.join(PAGE_DIR, `batch-${batch.id}`);
  await fs.mkdir(folder, { recursive: true });

  let rendered = 0;
  const limit = extractPagesPerRun();
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    if (done.has(pageNumber)) continue;
    const relative = path.join(`batch-${batch.id}`, `${String(pageNumber).padStart(4, "0")}.jpg`);
    const dest = path.join(PAGE_DIR, relative);
    const image = await pdf.renderPage(pageNumber);
    await fs.writeFile(dest, image);
    await insertPage(batch.id, pageNumber, relative);
    rendered += 1;
    console.log(`Batch ${batch.id}: saved page ${pageNumber}/${pdf.numPages}`);
    if (rendered >= limit) break;
  }

  const after = await existingPageNumbers(batch.id);
  if (after.size >= pdf.numPages) {
    await updateBatch(batch.id, { status: "pages_ready", error_message: null });
    console.log(
      `Batch ${batch.id}: all ${pdf.numPages} pages ready (${PAGES_PER_COMPOSITE}-up is next)`
    );
    return;
  }

  console.log(
    `Batch ${batch.id}: ${after.size}/${pdf.numPages} pages extracted this cycle +${rendered}`
  );
}

async function main() {
  try {
    await withCronLock("extract-pages", run);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await getPool().end().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main();
