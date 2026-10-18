import fs from "fs/promises";
import path from "path";
import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { getCompositeById, initSchema } from "@/lib/db";
import { COMPOSITE_DIR } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function GET(_request: Request, { params }: Params) {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  const id = Number(params.id);
  if (!id) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  await initSchema();
  const composite = await getCompositeById(id);
  if (!composite) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const jpeg = await fs.readFile(
      path.join(COMPOSITE_DIR, composite.file_path)
    );
    return new NextResponse(jpeg, {
      headers: {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Image missing" }, { status: 404 });
  }
}
