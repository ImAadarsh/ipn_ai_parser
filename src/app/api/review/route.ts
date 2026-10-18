import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { initSchema, listReviewComposites } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  await initSchema();
  return NextResponse.json({ items: await listReviewComposites() });
}
