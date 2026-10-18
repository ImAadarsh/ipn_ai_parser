import dotenv from "dotenv";
import path from "path";

dotenv.config({ path: path.join(process.cwd(), ".env.local") });
dotenv.config();

async function main() {
  const { initSchema } = await import("../src/lib/db");
  await initSchema();
  console.log("MySQL tables are ready: batches, students");
  process.exit(0);
}

main().catch((error) => {
  console.error("Could not create tables:", error);
  process.exit(1);
});
