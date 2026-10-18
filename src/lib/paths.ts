import path from "path";

export const ROOT = process.cwd();
export const DATA_DIR = path.join(ROOT, "data");
export const COMPOSITE_DIR = path.join(DATA_DIR, "composites");
export const PAGE_DIR = path.join(DATA_DIR, "pages");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
export const LOCK_DIR = path.join(DATA_DIR, "locks");
export const LOG_DIR = path.join(DATA_DIR, "logs");
