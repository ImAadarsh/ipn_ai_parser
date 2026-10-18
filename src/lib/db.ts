import mysql from "mysql2/promise";
import { PAGES_PER_COMPOSITE } from "./constants";
import type {
  BatchRow,
  CompositeRow,
  PageRow,
  StudentRecord,
} from "./types";

function createPool() {
  const ssl =
    process.env.MYSQL_SSL === "true"
      ? { rejectUnauthorized: false }
      : undefined;

  return mysql.createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 8,
    enableKeepAlive: true,
    ssl,
  });
}

let pool: mysql.Pool | null = null;

export function getPool() {
  if (!pool) pool = createPool();
  return pool;
}

async function columnExists(table: string, column: string) {
  const [rows] = await getPool().query(
    `SELECT COUNT(*) AS c
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return Number((rows as Array<{ c: number }>)[0].c) > 0;
}

export async function initSchema() {
  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS batches (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL,
      stored_path VARCHAR(500) NOT NULL DEFAULT '',
      file_size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
      total_pages INT UNSIGNED NOT NULL DEFAULT 0,
      pages_per_composite TINYINT UNSIGNED NOT NULL DEFAULT 6,
      status VARCHAR(32) NOT NULL DEFAULT 'uploaded',
      error_message TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  if (!(await columnExists("batches", "stored_path"))) {
    await db.query(
      `ALTER TABLE batches ADD COLUMN stored_path VARCHAR(500) NOT NULL DEFAULT '' AFTER filename`
    );
  }
  if (!(await columnExists("batches", "file_size_bytes"))) {
    await db.query(
      `ALTER TABLE batches ADD COLUMN file_size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER stored_path`
    );
  }

  await db.query(`
    ALTER TABLE batches
    MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'uploaded'
  `);
  await db.query(`
    UPDATE batches SET status = 'uploaded' WHERE status IN ('pending')
  `);
  await db.query(`
    UPDATE batches SET status = 'extracting_pages' WHERE status IN ('processing')
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS pages (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      batch_id INT UNSIGNED NOT NULL,
      page_number INT UNSIGNED NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_batch_page_number (batch_id, page_number),
      KEY idx_batch (batch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS composites (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      batch_id INT UNSIGNED NOT NULL,
      start_page INT UNSIGNED NOT NULL,
      end_page INT UNSIGNED NOT NULL,
      file_path VARCHAR(500) NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'pending',
      error_message TEXT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_batch_start (batch_id, start_page),
      KEY idx_status (status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS students (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      batch_id INT UNSIGNED NOT NULL,
      source_page INT UNSIGNED NOT NULL,
      slot TINYINT UNSIGNED NOT NULL,
      name VARCHAR(255) NULL,
      email VARCHAR(255) NULL,
      grade VARCHAR(100) NULL,
      school_name VARCHAR(255) NULL,
      composite_file VARCHAR(255) NULL,
      raw_json JSON NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_batch_page (batch_id, source_page),
      KEY idx_email (email),
      KEY idx_batch (batch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

export async function createUploadBatch(input: {
  filename: string;
  storedPath: string;
  fileSizeBytes: number;
}) {
  const [result] = await getPool().query(
    `INSERT INTO batches (filename, stored_path, file_size_bytes, pages_per_composite, status)
     VALUES (?, ?, ?, ?, 'uploaded')`,
    [input.filename, input.storedPath, input.fileSizeBytes, PAGES_PER_COMPOSITE]
  );
  return (result as mysql.ResultSetHeader).insertId;
}

export async function getBatch(id: number) {
  const [rows] = await getPool().query(`SELECT * FROM batches WHERE id = ?`, [
    id,
  ]);
  return ((rows as BatchRow[])[0] ?? null) as BatchRow | null;
}

export async function findBatchByStatus(statuses: string[]) {
  const [rows] = await getPool().query(
    `SELECT * FROM batches WHERE status IN (?) ORDER BY id ASC LIMIT 1`,
    [statuses]
  );
  return ((rows as BatchRow[])[0] ?? null) as BatchRow | null;
}

export async function updateBatch(
  id: number,
  fields: Partial<{
    total_pages: number;
    status: string;
    error_message: string | null;
    stored_path: string;
  }>
) {
  const entries = Object.entries(fields).filter(([, v]) => v !== undefined);
  if (!entries.length) return;
  await getPool().query(
    `UPDATE batches SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`,
    entries.map(([, v]) => v).concat(id)
  );
}

export async function insertPage(
  batchId: number,
  pageNumber: number,
  filePath: string
) {
  await getPool().query(
    `INSERT INTO pages (batch_id, page_number, file_path)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE file_path = VALUES(file_path)`,
    [batchId, pageNumber, filePath]
  );
}

export async function listPages(batchId: number) {
  const [rows] = await getPool().query(
    `SELECT * FROM pages WHERE batch_id = ? ORDER BY page_number ASC`,
    [batchId]
  );
  return rows as PageRow[];
}

export async function existingPageNumbers(batchId: number) {
  const pages = await listPages(batchId);
  return new Set(pages.map((p) => p.page_number));
}

export async function insertComposite(input: {
  batchId: number;
  startPage: number;
  endPage: number;
  filePath: string;
}) {
  await getPool().query(
    `INSERT INTO composites (batch_id, start_page, end_page, file_path, status)
     VALUES (?, ?, ?, ?, 'pending')
     ON DUPLICATE KEY UPDATE file_path = VALUES(file_path)`,
    [input.batchId, input.startPage, input.endPage, input.filePath]
  );
}

export async function listComposites(batchId: number) {
  const [rows] = await getPool().query(
    `SELECT * FROM composites WHERE batch_id = ? ORDER BY start_page ASC`,
    [batchId]
  );
  return rows as CompositeRow[];
}

export async function claimPendingComposite() {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(
      `SELECT * FROM composites WHERE status = 'pending' ORDER BY id ASC LIMIT 1 FOR UPDATE`
    );
    const row = (rows as CompositeRow[])[0];
    if (!row) {
      await conn.commit();
      return null;
    }
    await conn.query(
      `UPDATE composites SET status = 'processing', error_message = NULL WHERE id = ?`,
      [row.id]
    );
    await conn.commit();
    return { ...row, status: "processing" as const };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function finishComposite(
  id: number,
  status: "done" | "error",
  errorMessage: string | null = null
) {
  await getPool().query(
    `UPDATE composites SET status = ?, error_message = ? WHERE id = ?`,
    [status, errorMessage, id]
  );
}

export async function insertStudents(
  batchId: number,
  students: StudentRecord[],
  compositeFile: string,
  raw: unknown
) {
  if (!students.length) return;
  const values = students.map((s) => [
    batchId,
    s.sourcePage,
    s.slot,
    s.name,
    s.email,
    s.grade,
    s.schoolName,
    compositeFile,
    JSON.stringify(raw),
  ]);

  await getPool().query(
    `INSERT INTO students
      (batch_id, source_page, slot, name, email, grade, school_name, composite_file, raw_json)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      slot = VALUES(slot),
      name = VALUES(name),
      email = VALUES(email),
      grade = VALUES(grade),
      school_name = VALUES(school_name),
      composite_file = VALUES(composite_file),
      raw_json = VALUES(raw_json)`,
    [values]
  );
}

export async function syncBatchAfterGemini(batchId: number) {
  const [rows] = await getPool().query(
    `SELECT
       SUM(status = 'pending') AS pending_count,
       SUM(status = 'processing') AS processing_count,
       SUM(status = 'error') AS error_count,
       COUNT(*) AS total_count
     FROM composites WHERE batch_id = ?`,
    [batchId]
  );
  const stats = (
    rows as Array<{
      pending_count: number;
      processing_count: number;
      error_count: number;
      total_count: number;
    }>
  )[0];

  if (!stats || Number(stats.total_count) === 0) return;
  if (Number(stats.pending_count) > 0 || Number(stats.processing_count) > 0) {
    await updateBatch(batchId, { status: "parsing" });
    return;
  }
  if (Number(stats.error_count) > 0) {
    await updateBatch(batchId, {
      status: "error",
      error_message: "One or more Gemini composites failed",
    });
    return;
  }
  await updateBatch(batchId, { status: "done", error_message: null });
}

export async function listBatches() {
  const [rows] = await getPool().query(
    `SELECT b.*,
            (SELECT COUNT(*) FROM pages p WHERE p.batch_id = b.id) AS page_count,
            (SELECT COUNT(*) FROM composites c WHERE c.batch_id = b.id) AS composite_count,
            (SELECT COUNT(*) FROM composites c WHERE c.batch_id = b.id AND c.status = 'done') AS composites_done,
            (SELECT COUNT(*) FROM students s WHERE s.batch_id = b.id) AS student_count
     FROM batches b
     ORDER BY b.id DESC
     LIMIT 50`
  );
  return rows as Array<Record<string, unknown>>;
}

export async function listStudents(batchId?: number) {
  const sql = batchId
    ? `SELECT * FROM students WHERE batch_id = ? ORDER BY source_page ASC`
    : `SELECT * FROM students ORDER BY id DESC LIMIT 500`;
  const [rows] = batchId
    ? await getPool().query(sql, [batchId])
    : await getPool().query(sql);
  return rows as Array<Record<string, unknown>>;
}
