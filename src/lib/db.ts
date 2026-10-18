import crypto from "crypto";
import mysql from "mysql2/promise";
import { PAGES_PER_COMPOSITE } from "./constants";
import { hashPassword } from "./password";
import type {
  BatchRow,
  CompositeRow,
  PageRow,
  StudentRecord,
} from "./types";

export type AuthUser = {
  id: number;
  username: string;
  role: string;
  active: number;
};

export type StudentFilters = {
  batchId?: number;
  query?: string;
  flag?: string;
  gradeNumber?: number;
  limit?: number;
};

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
  if (!(await columnExists("batches", "files_deleted_at"))) {
    await db.query(
      `ALTER TABLE batches ADD COLUMN files_deleted_at TIMESTAMP NULL DEFAULT NULL AFTER error_message`
    );
  }
  if (!(await columnExists("batches", "file_hash"))) {
    await db.query(
      `ALTER TABLE batches ADD COLUMN file_hash CHAR(64) NULL AFTER file_size_bytes, ADD KEY idx_file_hash (file_hash)`
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

  for (const [column, ddl] of [
    ["prompt_tokens", "INT UNSIGNED NOT NULL DEFAULT 0"],
    ["completion_tokens", "INT UNSIGNED NOT NULL DEFAULT 0"],
    ["total_tokens", "INT UNSIGNED NOT NULL DEFAULT 0"],
    ["cost_usd", "DECIMAL(12,6) NOT NULL DEFAULT 0"],
  ] as const) {
    if (!(await columnExists("composites", column))) {
      await db.query(`ALTER TABLE composites ADD COLUMN ${column} ${ddl}`);
    }
  }

  for (const [column, ddl] of [
    ["issues", "VARCHAR(255) NULL"],
    ["is_duplicate", "TINYINT(1) NOT NULL DEFAULT 0"],
    ["valid_email", "TINYINT(1) NOT NULL DEFAULT 1"],
  ] as const) {
    if (!(await columnExists("students", column))) {
      await db.query(`ALTER TABLE students ADD COLUMN ${column} ${ddl}`);
    }
  }

  if (!(await columnExists("students", "grade_number"))) {
    await db.query(
      `ALTER TABLE students ADD COLUMN grade_number TINYINT UNSIGNED NULL AFTER grade, ADD KEY idx_grade_number (grade_number)`
    );
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      username VARCHAR(100) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user',
      active TINYINT(1) NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_username (username)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token CHAR(64) NOT NULL,
      user_id INT UNSIGNED NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at TIMESTAMP NOT NULL,
      PRIMARY KEY (token),
      KEY idx_user (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (
      k VARCHAR(64) NOT NULL,
      v VARCHAR(255) NOT NULL,
      PRIMARY KEY (k)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  const adminUsername = process.env.ADMIN_USERNAME || "admin";
  const adminPassword = process.env.ADMIN_PASSWORD || "admin123";
  const [admins] = await db.query(
    `SELECT id FROM users WHERE username = ?`,
    [adminUsername]
  );
  if ((admins as Array<{ id: number }>).length === 0) {
    await db.query(
      `INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`,
      [adminUsername, hashPassword(adminPassword)]
    );
  }
}

export async function createUploadBatch(input: {
  filename: string;
  storedPath: string;
  fileSizeBytes: number;
  fileHash: string;
}) {
  const [result] = await getPool().query(
    `INSERT INTO batches (filename, stored_path, file_size_bytes, file_hash, pages_per_composite, status)
     VALUES (?, ?, ?, ?, ?, 'uploaded')`,
    [
      input.filename,
      input.storedPath,
      input.fileSizeBytes,
      input.fileHash,
      PAGES_PER_COMPOSITE,
    ]
  );
  return (result as mysql.ResultSetHeader).insertId;
}

export async function findBatchByHash(fileHash: string) {
  const [rows] = await getPool().query(
    `SELECT id, filename, status FROM batches WHERE file_hash = ? LIMIT 1`,
    [fileHash]
  );
  return (
    (rows as Array<{ id: number; filename: string; status: string }>)[0] ?? null
  );
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
  status: "done" | "error" | "review",
  errorMessage: string | null = null
) {
  await getPool().query(
    `UPDATE composites SET status = ?, error_message = ? WHERE id = ?`,
    [status, errorMessage, id]
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function insertStudents(
  batchId: number,
  students: StudentRecord[],
  compositeFile: string,
  raw: unknown,
  startPage: number,
  endPage: number
) {
  const db = getPool();

  await db.query(
    `DELETE FROM students WHERE batch_id = ? AND source_page BETWEEN ? AND ?`,
    [batchId, startPage, endPage]
  );
  if (!students.length) return;

  const [existingRows] = await db.query(
    `SELECT email FROM students WHERE batch_id = ? AND email IS NOT NULL`,
    [batchId]
  );
  const seen = new Set(
    (existingRows as Array<{ email: string }>).map((r) =>
      String(r.email).toLowerCase()
    )
  );

  const values = students.map((s) => {
    const email = s.email ? s.email.toLowerCase() : null;
    const issues: string[] = [];
    let validEmail = 1;

    if (!s.name) issues.push("missing_name");
    if (!email) issues.push("missing_email");
    else if (!EMAIL_RE.test(email)) {
      validEmail = 0;
      issues.push("invalid_email");
    }
    if (!s.grade) issues.push("missing_grade");
    if (!s.schoolName) issues.push("missing_school");

    let isDuplicate = 0;
    if (email) {
      if (seen.has(email)) {
        isDuplicate = 1;
        issues.push("duplicate_email");
      }
      seen.add(email);
    }

    return [
      batchId,
      s.sourcePage,
      s.slot,
      s.name,
      email,
      s.grade,
      s.gradeNumber ?? null,
      s.schoolName,
      compositeFile,
      JSON.stringify(raw),
      issues.join(",") || null,
      isDuplicate,
      validEmail,
    ];
  });

  await db.query(
    `INSERT INTO students
      (batch_id, source_page, slot, name, email, grade, grade_number, school_name, composite_file, raw_json, issues, is_duplicate, valid_email)
     VALUES ?
     ON DUPLICATE KEY UPDATE
      slot = VALUES(slot),
      name = VALUES(name),
      email = VALUES(email),
      grade = VALUES(grade),
      grade_number = VALUES(grade_number),
      school_name = VALUES(school_name),
      composite_file = VALUES(composite_file),
      raw_json = VALUES(raw_json),
      issues = VALUES(issues),
      is_duplicate = VALUES(is_duplicate),
      valid_email = VALUES(valid_email)`,
    [values]
  );
}

export async function syncBatchAfterGemini(batchId: number) {
  const [rows] = await getPool().query(
    `SELECT
       SUM(status = 'pending') AS pending_count,
       SUM(status = 'processing') AS processing_count,
       SUM(status = 'error') AS error_count,
       SUM(status = 'review') AS review_count,
       COUNT(*) AS total_count
     FROM composites WHERE batch_id = ?`,
    [batchId]
  );
  const stats = (
    rows as Array<{
      pending_count: number;
      processing_count: number;
      error_count: number;
      review_count: number;
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
      error_message: "One or more composites failed",
    });
    return;
  }
  if (Number(stats.review_count) > 0) {
    await updateBatch(batchId, {
      status: "needs_review",
      error_message: `${stats.review_count} image(s) need review`,
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
            (SELECT COUNT(*) FROM composites c WHERE c.batch_id = b.id AND c.status = 'review') AS composites_review,
            (SELECT COUNT(*) FROM composites c WHERE c.batch_id = b.id AND c.status = 'processing') AS composites_processing,
            (SELECT COUNT(*) FROM students s WHERE s.batch_id = b.id) AS student_count
     FROM batches b
     ORDER BY b.id DESC
     LIMIT 50`
  );
  return rows as Array<Record<string, unknown>>;
}

export async function listStudents(filters: StudentFilters = {}) {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filters.batchId) {
    where.push("batch_id = ?");
    params.push(filters.batchId);
  }
  if (filters.query) {
    where.push("(name LIKE ? OR email LIKE ? OR school_name LIKE ?)");
    const like = `%${filters.query}%`;
    params.push(like, like, like);
  }
  if (filters.flag === "duplicate") where.push("is_duplicate = 1");
  if (filters.flag === "invalid_email") where.push("valid_email = 0");
  if (filters.flag === "issues") where.push("issues IS NOT NULL");
  if (filters.gradeNumber) {
    where.push("grade_number = ?");
    params.push(filters.gradeNumber);
  }

  const sql = `SELECT * FROM students ${
    where.length ? `WHERE ${where.join(" AND ")}` : ""
  } ORDER BY batch_id DESC, source_page ASC LIMIT ?`;
  params.push(Math.min(filters.limit || 500, 2000));
  const [rows] = await getPool().query(sql, params);
  return rows as Array<Record<string, unknown>>;
}

export async function recordUsage(
  compositeId: number,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    costUsd: number;
  }
) {
  await getPool().query(
    `UPDATE composites
     SET prompt_tokens = ?, completion_tokens = ?, total_tokens = ?, cost_usd = ?
     WHERE id = ?`,
    [
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      usage.costUsd,
      compositeId,
    ]
  );
}

export async function usageSummary() {
  const [rows] = await getPool().query(
    `SELECT
       COUNT(*) AS calls,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
       COALESCE(SUM(total_tokens), 0) AS total_tokens,
       COALESCE(SUM(cost_usd), 0) AS cost_usd
     FROM composites WHERE total_tokens > 0`
  );
  return (rows as Array<Record<string, number>>)[0];
}

export async function listReviewComposites() {
  const [rows] = await getPool().query(
    `SELECT c.id, c.batch_id, c.start_page, c.end_page, c.file_path,
            c.error_message, c.updated_at, b.filename
     FROM composites c JOIN batches b ON b.id = c.batch_id
     WHERE c.status = 'review'
     ORDER BY c.id DESC`
  );
  return rows as Array<Record<string, unknown>>;
}

export async function getCompositeById(id: number) {
  const [rows] = await getPool().query(
    `SELECT * FROM composites WHERE id = ?`,
    [id]
  );
  return ((rows as CompositeRow[])[0] ?? null) as CompositeRow | null;
}

export async function resetComposite(id: number) {
  await getPool().query(
    `UPDATE composites SET status = 'pending', error_message = NULL WHERE id = ?`,
    [id]
  );
}

export async function getSetting(key: string) {
  const [rows] = await getPool().query(
    `SELECT v FROM settings WHERE k = ?`,
    [key]
  );
  const row = (rows as Array<{ v: string }>)[0];
  return row ? row.v : null;
}

export async function setSetting(key: string, value: string) {
  await getPool().query(
    `INSERT INTO settings (k, v) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE v = VALUES(v)`,
    [key, value]
  );
}

export async function workerPaused() {
  return (await getSetting("worker_paused")) === "true";
}

export async function acquireWorkerLease(ms: number) {
  const current = await getSetting("worker_lease");
  if (current && Number(current) > Date.now() + 2000) return false;
  await setSetting("worker_lease", String(Date.now() + ms));
  return true;
}

export async function workerLeaseHeld() {
  const current = await getSetting("worker_lease");
  return Boolean(current && Number(current) > Date.now() + 2000);
}

export async function releaseWorkerLease() {
  await setSetting("worker_lease", "0");
}

export async function pipelineHasWork() {
  const [rows] = await getPool().query(
    `SELECT
       (SELECT COUNT(*) FROM batches
         WHERE status IN ('uploaded','extracting_pages','pages_ready',
                          'composing','composites_ready','parsing')) AS active_batches,
       (SELECT COUNT(*) FROM composites c
         WHERE c.status = 'pending'
           AND EXISTS (SELECT 1 FROM batches b
                       WHERE b.id = c.batch_id
                         AND b.status NOT IN ('error'))) AS pending_composites`
  );
  const row = (
    rows as Array<{ active_batches: number; pending_composites: number }>
  )[0];
  return (
    Number(row.active_batches) > 0 || Number(row.pending_composites) > 0
  );
}

export async function pipelineCounts() {
  const [rows] = await getPool().query(
    `SELECT
       (SELECT COUNT(*) FROM pages) AS pages,
       (SELECT COUNT(*) FROM composites) AS composites,
       (SELECT COUNT(*) FROM composites
         WHERE status IN ('done','review')) AS settled,
       (SELECT COUNT(*) FROM students) AS students`
  );
  return (
    rows as Array<{
      pages: number;
      composites: number;
      settled: number;
      students: number;
    }>
  )[0];
}

export async function releaseStaleProcessing(countMinutes = 30) {
  const [result] = await getPool().query(
    `UPDATE composites
     SET status = 'pending', error_message = 'Recovered from an interrupted run'
     WHERE status = 'processing'
       AND updated_at < DATE_SUB(NOW(), INTERVAL ? MINUTE)`,
    [countMinutes]
  );
  return (result as mysql.ResultSetHeader).affectedRows || 0;
}

export async function pipelineSummary() {
  const [rows] = await getPool().query(
    `SELECT
       (SELECT COUNT(*) FROM pages) AS pages_done,
       (SELECT COALESCE(SUM(total_pages), 0) FROM batches
         WHERE status <> 'error') AS pages_total,
       (SELECT COUNT(*) FROM composites) AS images_done,
       (SELECT COUNT(*) FROM composites
         WHERE status IN ('done','review')) AS images_processed,
       (SELECT COUNT(*) FROM composites WHERE status = 'done') AS images_ok,
       (SELECT COUNT(*) FROM composites WHERE status = 'review') AS images_review,
       (SELECT COUNT(*) FROM students) AS students,
       (SELECT COALESCE(SUM(cost_usd), 0) FROM composites) AS cost_usd,
       (SELECT COUNT(*) FROM batches) AS batches`
  );
  return (rows as Array<Record<string, number>>)[0];
}

export async function studentStats() {
  const [rows] = await getPool().query(
    `SELECT
       COUNT(*) AS total,
       SUM(name IS NOT NULL) AS named,
       SUM(email IS NOT NULL) AS with_email,
       SUM(email IS NOT NULL AND valid_email = 1) AS valid_emails,
       SUM(is_duplicate = 1) AS duplicates,
       SUM(valid_email = 0) AS invalid_emails,
       SUM(grade IS NOT NULL) AS with_grade,
       SUM(school_name IS NOT NULL) AS with_school,
       COUNT(DISTINCT NULLIF(school_name, '')) AS schools,
       COUNT(DISTINCT NULLIF(grade, '')) AS grades
     FROM students`
  );
  return (
    rows as Array<Record<string, number | null>>
  )[0] as Record<string, number>;
}

export async function schoolBreakdown(limit = 12) {
  const [rows] = await getPool().query(
    `SELECT school_name AS label, COUNT(*) AS total
     FROM students
     WHERE school_name IS NOT NULL AND school_name <> ''
     GROUP BY school_name
     ORDER BY total DESC
     LIMIT ?`,
    [limit]
  );
  return rows as Array<{ label: string; total: number }>;
}

export async function gradeBreakdown(limit = 12) {
  const [rows] = await getPool().query(
    `SELECT CONCAT('Class ', grade_number) AS label,
            COUNT(*) AS total,
            grade_number
     FROM students
     WHERE grade_number IS NOT NULL
     GROUP BY grade_number
     ORDER BY grade_number ASC
     LIMIT ?`,
    [limit]
  );
  return rows as Array<{ label: string; total: number; grade_number: number }>;
}

export async function batchesForCleanup(retentionDays: number) {
  const [rows] = await getPool().query(
    `SELECT id, stored_path FROM batches
     WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
       AND files_deleted_at IS NULL
       AND status IN ('done','error','needs_review')
     ORDER BY id ASC
     LIMIT 200`,
    [retentionDays]
  );
  return rows as Array<{ id: number; stored_path: string }>;
}

export async function batchFiles(batchId: number) {
  const [rows] = await getPool().query(
    `SELECT file_path FROM composites WHERE batch_id = ?`,
    [batchId]
  );
  return (rows as Array<{ file_path: string }>).map((r) => r.file_path);
}

export async function markBatchFilesDeleted(batchId: number) {
  await getPool().query(
    `UPDATE batches SET files_deleted_at = NOW() WHERE id = ?`,
    [batchId]
  );
}

export async function deleteExpiredSessions() {
  const [result] = await getPool().query(
    `DELETE FROM sessions WHERE expires_at < NOW()`
  );
  return (result as mysql.ResultSetHeader).affectedRows || 0;
}

export async function findUserByUsername(username: string) {
  const [rows] = await getPool().query(
    `SELECT * FROM users WHERE username = ? LIMIT 1`,
    [username]
  );
  return (
    (rows as Array<AuthUser & { password_hash: string }>)[0] ?? null
  );
}

export async function getUserByToken(token: string) {
  const [rows] = await getPool().query(
    `SELECT u.id, u.username, u.role, u.active
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > NOW() LIMIT 1`,
    [token]
  );
  const user = (rows as AuthUser[])[0];
  if (!user || !user.active) return null;
  return user;
}

export async function createSession(userId: number, days: number) {
  const token = crypto.randomBytes(32).toString("hex");
  await getPool().query(
    `INSERT INTO sessions (token, user_id, expires_at)
     VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [token, userId, days]
  );
  return token;
}

export async function deleteSession(token: string) {
  await getPool().query(`DELETE FROM sessions WHERE token = ?`, [token]);
}

export async function listUsers() {
  const [rows] = await getPool().query(
    `SELECT id, username, role, active, created_at FROM users ORDER BY id ASC`
  );
  return rows as Array<Record<string, unknown>>;
}

export async function createUser(input: {
  username: string;
  passwordHash: string;
  role: string;
}) {
  const [result] = await getPool().query(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`,
    [input.username, input.passwordHash, input.role]
  );
  return (result as mysql.ResultSetHeader).insertId;
}

export async function setUserActive(id: number, active: boolean) {
  await getPool().query(`UPDATE users SET active = ? WHERE id = ?`, [
    active ? 1 : 0,
    id,
  ]);
}

export async function setUserPassword(id: number, passwordHash: string) {
  await getPool().query(`UPDATE users SET password_hash = ? WHERE id = ?`, [
    passwordHash,
    id,
  ]);
}

export async function deleteUser(id: number) {
  await getPool().query(`DELETE FROM users WHERE id = ?`, [id]);
}
