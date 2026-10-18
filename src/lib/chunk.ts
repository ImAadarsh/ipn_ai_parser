import { PDFDocument } from "pdf-lib";

export type PdfChunk = {
  index: number;
  startPage: number;
  endPage: number;
  pageCount: number;
  bytes: Uint8Array;
};

export type SplitOptions = {
  targetBytes: number;
  sampleSize?: number;
  onChunk?: (chunk: PdfChunk) => Promise<void> | void;
};

async function renderChunk(
  src: PDFDocument,
  start: number,
  count: number
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const indices = Array.from({ length: count }, (_, i) => start + i);
  const pages = await doc.copyPages(src, indices);
  pages.forEach((page) => doc.addPage(page));
  return doc.save();
}

async function estimatePageBytes(
  src: PDFDocument,
  total: number,
  sampleSize: number
): Promise<number> {
  const step = Math.max(1, Math.floor(total / sampleSize));
  let largest = 0;
  for (let page = 0; page < total; page += step) {
    const single = await renderChunk(src, page, 1);
    if (single.length > largest) largest = single.length;
  }
  return Math.max(1, largest);
}

/**
 * Splits a PDF into chunks that each stay at or below `targetBytes`.
 * Pages are grouped in order and copied into standalone PDFs, so every
 * produced chunk is a valid, independently openable PDF.
 */
export async function splitPdfBySize(
  buffer: Uint8Array,
  { targetBytes, sampleSize = 8, onChunk }: SplitOptions
): Promise<PdfChunk[]> {
  if (targetBytes <= 0) throw new Error("targetBytes must be > 0");

  const src = await PDFDocument.load(buffer, { ignoreEncryption: true });
  const total = src.getPageCount();
  if (total === 0) return [];

  const pageBytes = await estimatePageBytes(src, total, sampleSize);
  const maxPagesPerChunk = Math.max(1, Math.floor(targetBytes / pageBytes));

  const chunks: PdfChunk[] = [];
  let start = 0;
  while (start < total) {
    const remaining = total - start;
    let hi = Math.min(remaining, maxPagesPerChunk);

    let bestCount = 1;
    let bestBytes = await renderChunk(src, start, 1);
    if (bestBytes.length <= targetBytes) {
      let lo = 2;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const candidate = await renderChunk(src, start, mid);
        if (candidate.length <= targetBytes) {
          bestCount = mid;
          bestBytes = candidate;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }

    const chunk: PdfChunk = {
      index: chunks.length + 1,
      startPage: start + 1,
      endPage: start + bestCount,
      pageCount: bestCount,
      bytes: bestBytes,
    };
    chunks.push(chunk);
    if (onChunk) await onChunk(chunk);
    start += bestCount;
  }

  return chunks;
}
