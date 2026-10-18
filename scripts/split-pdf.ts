import "./preload-env";
import fs from "fs/promises";
import path from "path";
import { chunkPdfMb } from "../src/lib/constants";
import { splitPdfBySize } from "../src/lib/chunk";

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error(
      "Usage: npm run split-pdf -- <path/to/file.pdf> [chunkMB] [outputDir]"
    );
    process.exitCode = 1;
    return;
  }

  const chunkMb = Number(process.argv[3] || chunkPdfMb());
  const targetBytes = Math.floor(chunkMb * 1024 * 1024);

  const buffer = await fs.readFile(input);
  const base = path.basename(input, path.extname(input));
  const outDir =
    process.argv[4] || path.join(path.dirname(input), `${base}-chunks`);
  await fs.mkdir(outDir, { recursive: true });

  console.log(`Input:  ${input} (${mb(buffer.length)})`);
  console.log(`Target: ${chunkMb} MB per chunk -> ${outDir}`);

  const chunks = await splitPdfBySize(buffer, {
    targetBytes,
    onChunk: async (chunk) => {
      const name = `${base}-part-${String(chunk.index).padStart(2, "0")}.pdf`;
      await fs.writeFile(path.join(outDir, name), chunk.bytes);
      console.log(
        `  ${name}: pages ${chunk.startPage}-${chunk.endPage} (${chunk.pageCount} pages, ${mb(chunk.bytes.length)})`
      );
    },
  });

  const over = chunks.filter((c) => c.bytes.length > targetBytes);
  const totalPages = chunks.reduce((sum, c) => sum + c.pageCount, 0);
  console.log(
    `Done: ${chunks.length} chunks, ${totalPages} pages, all <= ${chunkMb} MB: ${over.length === 0}`
  );
  if (over.length) {
    console.warn(
      `Warning: ${over.length} chunk(s) exceed ${chunkMb} MB (single pages larger than the target).`
    );
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
