import crypto from "crypto";
import { NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { authGuard } from "@/lib/api-auth";
import { maxPdfBytes, maxPdfMb } from "@/lib/constants";
import { createUploadBatch, findBatchByHash, initSchema } from "@/lib/db";
import { UPLOAD_DIR } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  try {
    const form = await request.formData();
    const file = form.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "PDF file is required" },
        { status: 400 }
      );
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json({ error: "Upload a PDF" }, { status: 400 });
    }
    if (file.size > maxPdfBytes()) {
      return NextResponse.json(
        { error: `PDF must be ${maxPdfMb()} MB or smaller` },
        { status: 400 }
      );
    }

    await initSchema();

    const buffer = Buffer.from(await file.arrayBuffer());
    const fileHash = crypto.createHash("sha256").update(buffer).digest("hex");

    const duplicate = await findBatchByHash(fileHash);
    if (duplicate) {
      return NextResponse.json(
        {
          error: `"${file.name}" is identical to batch #${duplicate.id} (${duplicate.filename}, ${duplicate.status}). Skipped to avoid duplicate work.`,
          duplicateOfBatchId: duplicate.id,
        },
        { status: 409 }
      );
    }

    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const safeName = `${Date.now()}-${file.name.replace(/[^\w.\-]+/g, "_")}`;
    const dest = path.join(UPLOAD_DIR, safeName);
    await fs.writeFile(dest, buffer);

    const batchId = await createUploadBatch({
      filename: file.name,
      storedPath: safeName,
      fileSizeBytes: file.size,
      fileHash,
    });

    return NextResponse.json({
      batchId,
      filename: file.name,
      sizeBytes: file.size,
      message: "PDF uploaded. The cron job will start soon.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Upload failed" },
      { status: 500 }
    );
  }
}
