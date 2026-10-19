import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import {
  initSchema,
  listDistortedImages,
  listReviewComposites,
} from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authGuard();
  if (guard.error) return guard.error;
  await initSchema();
  const [items, distorted] = await Promise.all([
    listReviewComposites(),
    listDistortedImages(300),
  ]);
  return NextResponse.json({ items, distorted });
}
