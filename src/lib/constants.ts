// One sheet per image unit: full resolution per page = accurate handwriting
// reading. Multi-page grids shrink each sheet below the legibility limit.
export const PAGES_PER_COMPOSITE = 1;

export function maxPdfMb() {
  return Number(process.env.MAX_PDF_MB || 200);
}

export function chunkPdfMb() {
  return Number(process.env.CHUNK_PDF_MB || 50);
}

export function maxPdfBytes() {
  return maxPdfMb() * 1024 * 1024;
}

export function extractPagesPerRun() {
  return Number(process.env.EXTRACT_PAGES_PER_RUN || 25);
}

export function compositesPerRun() {
  return Number(process.env.COMPOSITES_PER_RUN || 40);
}

export function geminiPerRun() {
  return Number(process.env.GEMINI_PER_RUN || 6);
}
