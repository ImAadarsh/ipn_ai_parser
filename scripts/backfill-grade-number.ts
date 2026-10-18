import "./preload-env";
import { getPool, initSchema } from "../src/lib/db";
import { parseGradeNumber } from "../src/lib/grade";

async function main() {
  await initSchema();
  const db = getPool();

  const [rows] = await db.query(
    `SELECT id, grade FROM students
     WHERE grade IS NOT NULL AND grade <> '' AND grade_number IS NULL`
  );

  const students = rows as Array<{ id: number; grade: string }>;
  let updated = 0;

  for (const student of students) {
    const value = parseGradeNumber(student.grade);
    if (value == null) continue;
    await db.query(`UPDATE students SET grade_number = ? WHERE id = ?`, [
      value,
      student.id,
    ]);
    updated += 1;
  }

  const [summary] = await db.query(
    `SELECT grade_number, COUNT(*) AS total
     FROM students WHERE grade_number IS NOT NULL
     GROUP BY grade_number ORDER BY grade_number ASC`
  );
  console.log(`backfilled ${updated}/${students.length} students`);
  console.table(summary);

  await db.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
