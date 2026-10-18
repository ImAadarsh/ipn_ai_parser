import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import {
  finishComposite,
  getCompositeById,
  initSchema,
  resetComposite,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function POST(request: Request, { params }: Params) {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  const id = Number(params.id);
  if (!id) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
  };
  await initSchema();
  const composite = await getCompositeById(id);
  if (!composite) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (body.action === "retry") {
    await resetComposite(id);
    return NextResponse.json({ ok: true, status: "pending" });
  }
  if (body.action === "discard") {
    await finishComposite(id, "done");
    return NextResponse.json({ ok: true, status: "done" });
  }
  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
