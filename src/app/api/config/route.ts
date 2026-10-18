import { NextResponse } from "next/server";
import { PAGES_PER_COMPOSITE, maxPdfMb } from "@/lib/constants";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({
    maxPdfMb: maxPdfMb(),
    pagesPerComposite: PAGES_PER_COMPOSITE,
  });
}
