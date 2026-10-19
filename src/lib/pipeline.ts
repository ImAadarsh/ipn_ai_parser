import fs from "fs/promises";
import path from "path";
import {
  PAGES_PER_COMPOSITE,
  compositesPerRun,
  extractPagesPerRun,
  geminiPerRun,
} from "./constants";
import {
  claimPendingComposite,
  existingPageNumbers,
  findBatchByStatus,
  finishComposite,
  getBatch,
  initSchema,
  insertComposite,
  insertDistortedImage,
  insertPage,
  insertStudents,
  listComposites,
  listPages,
  recordUsage,
  syncBatchAfterGemini,
  updateBatch,
  workerPaused,
} from "./db";
import {
  ExtractionError,
  aiModel,
  extractStudentsFromComposite,
} from "./extract";
import { usageCostUsd } from "./pricing";
import { withCronLock } from "./lock";
import { COMPOSITE_DIR, PAGE_DIR, UPLOAD_DIR } from "./paths";
import { composeGrid, openPdf } from "./pdf";
import type { StudentRecord } from "./types";

function cannotExtractReason(entry: StudentRecord) {
  if (entry.quality === "BLANK") {
    return "Fully blurred / cannot extract: page blank";
  }
  if (entry.quality === "CUT_OFF") {
    return "Fully blurred / cannot extract: sheet partially outside photo (cut off)";
  }
  switch (entry.nameStatus) {
    case "BLURRED":
      return "Fully blurred / cannot extract: name blurred or illegible";
    case "NO_DATA":
      return "Fully blurred / cannot extract: name blank / no data";
    case "AMBIGUOUS":
      return "Fully blurred / cannot extract: name ambiguous (two independent reads disagree)";
    case "UNCONFIRMED":
      return "Fully blurred / cannot extract: name read by only one pass (not confirmed)";
    default:
      return `Fully blurred / cannot extract: name ${entry.nameStatus}`;
  }
}

export async function runExtractPages() {
  return withCronLock("extract-pages", async () => {
    await initSchema();
    if (await workerPaused()) return;
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

    await updateBatch(batch.id, {
      status: "extracting_pages",
      error_message: null,
    });
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
      const relative = path.join(
        `batch-${batch.id}`,
        `${String(pageNumber).padStart(4, "0")}.jpg`
      );
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
      await updateBatch(batch.id, {
        status: "pages_ready",
        error_message: null,
      });
      console.log(
        `Batch ${batch.id}: all ${pdf.numPages} pages ready (${PAGES_PER_COMPOSITE}-up is next)`
      );
      return;
    }

    console.log(
      `Batch ${batch.id}: ${after.size}/${pdf.numPages} pages extracted this cycle +${rendered}`
    );
  });
}

export async function runCompose(
  opts: { ignorePause?: boolean; batchId?: number } = {}
) {
  return withCronLock("compose-six", async () => {
    await initSchema();
    if (!opts.ignorePause && (await workerPaused())) return;
    let batch = opts.batchId
      ? null
      : await findBatchByStatus(["pages_ready", "composing"]);
    if (opts.batchId) {
      const target = await getBatch(opts.batchId);
      if (
        target &&
        (target.status === "pages_ready" || target.status === "composing")
      ) {
        batch = target;
      }
    }
    if (!batch) {
      console.log("No page set waiting for image compose");
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
      await updateBatch(batch.id, {
        status: "composites_ready",
        error_message: null,
      });
      console.log(`Batch ${batch.id}: ${have} six-up images ready for AI`);
      return;
    }

    // Re-assert 'composing' so the next cycle picks this batch up again even
    // if Gemini moved it to another status while we were working.
    await updateBatch(batch.id, { status: "composing" });
    console.log(
      `Batch ${batch.id}: ${have}/${needed} six-up images, +${made} this cycle`
    );
  });
}

export async function runGemini(
  opts: { ignorePause?: boolean; batchId?: number; limit?: number } = {}
) {
  return withCronLock("gemini", async () => {
    await initSchema();
    if (!opts.ignorePause && (await workerPaused())) return;
    const limit = opts.limit ?? geminiPerRun();
    let processed = 0;

    while (processed < limit) {
      const composite = await claimPendingComposite(opts.batchId);
      if (!composite) {
        if (processed === 0) console.log("No six-up image waiting for AI");
        break;
      }

      await updateBatch(composite.batch_id, { status: "parsing" });
      const imagePath = path.join(COMPOSITE_DIR, composite.file_path);

      // Pre-flight: never spend an API call on an unreadable/empty image.
      let jpeg: Buffer;
      try {
        const stat = await fs.stat(imagePath);
        if (stat.size < 1024) {
          throw new Error(`Composite image is empty (${stat.size} bytes)`);
        }
        jpeg = await fs.readFile(imagePath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (
          let page = composite.start_page;
          page <= composite.end_page;
          page += 1
        ) {
          await insertDistortedImage({
            batchId: composite.batch_id,
            compositeId: composite.id,
            pageNumber: page,
            reason: `Completely distorted: composite image missing/corrupt (${message})`,
            model: null,
          });
        }
        await finishComposite(
          composite.id,
          "review",
          `Skipped (no API call): ${message}`
        );
        console.error(`Composite ${composite.id} skipped without API: ${message}`);
        await syncBatchAfterGemini(composite.batch_id);
        processed += 1;
        continue;
      }

      try {
        const pagesInGroup = composite.end_page - composite.start_page + 1;
        const { students, raw, usage } = await extractStudentsFromComposite(
          jpeg,
          composite.start_page,
          pagesInGroup
        );
        // 0-hallucination rule: a page becomes a student row ONLY when the
        // handwritten NAME was confirmed by BOTH independent reads.
        // Everything else is recorded as a cannot-extract entry.
        const named = students.filter((student) => student.name);
        const unreadable = students.filter((student) => !student.name);

        for (const entry of unreadable) {
          await insertDistortedImage({
            batchId: composite.batch_id,
            compositeId: composite.id,
            pageNumber: entry.sourcePage,
            reason: cannotExtractReason(entry),
            model: aiModel(),
          });
        }

        if (named.length > 0) {
          await insertStudents(
            composite.batch_id,
            named,
            composite.file_path,
            raw,
            composite.start_page,
            composite.end_page
          );
        }
        await recordUsage(composite.id, {
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.totalTokens,
          costUsd: usageCostUsd(usage),
        });
        if (named.length === 0) {
          await finishComposite(
            composite.id,
            "review",
            `Fully blurred / cannot extract: no readable name on page ${composite.start_page}`
          );
          console.log(
            `Composite ${composite.id}: cannot extract (pages ${composite.start_page}-${composite.end_page})`
          );
        } else {
          await finishComposite(composite.id, "done");
          console.log(
            `Composite ${composite.id}: saved ${named.length} named, ${unreadable.length} cannot-extract (pages ${composite.start_page}-${composite.end_page})`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A processed image is still billable, so keep its token usage even
        // when the response could not be parsed.
        if (error instanceof ExtractionError && error.usage) {
          await recordUsage(composite.id, {
            promptTokens: error.usage.promptTokens,
            completionTokens: error.usage.completionTokens,
            totalTokens: error.usage.totalTokens,
            costUsd: usageCostUsd(error.usage),
          });
        }
        await finishComposite(composite.id, "review", message);
        console.error(
          `Composite ${composite.id} needs review (no retry): ${message}`
        );
      }

      await syncBatchAfterGemini(composite.batch_id);
      processed += 1;
    }
  });
}

export async function runPipelineOnce() {
  await runExtractPages();
  await runCompose();
  await runGemini();
}
