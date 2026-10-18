import "./preload-env";
import { getPool } from "../src/lib/db";
import { runCompose } from "../src/lib/pipeline";

async function main() {
  try {
    await runCompose();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await getPool().end().catch(() => undefined);
    process.exit(process.exitCode ?? 0);
  }
}

main();
