export const PAGES_PER_COMPOSITE = 6;

export function maxPdfMb() {
  return Number(process.env.MAX_PDF_MB || 50);
}

export function maxPdfBytes() {
  return maxPdfMb() * 1024 * 1024;
}

export function extractPagesPerRun() {
  return Number(process.env.EXTRACT_PAGES_PER_RUN || 25);
}

export function compositesPerRun() {
  return Number(process.env.COMPOSITES_PER_RUN || 8);
}

export function geminiPerRun() {
  return Number(process.env.GEMINI_PER_RUN || 2);
}
