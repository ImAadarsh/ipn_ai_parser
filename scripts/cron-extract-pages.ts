import "./preload-env";
import { getPool } from "../src/lib/db";
import { runExtractPages } from "../src/lib/pipeline";

async function main() {
  try {
    await runExtractPages();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await getPool().end().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main();
