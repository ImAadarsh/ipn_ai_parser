import { NextResponse } from "next/server";
import { currentUser } from "./auth";
import type { AuthUser } from "./db";

export async function authGuard(
  admin = false
): Promise<{ user: AuthUser; error?: never } | { user?: never; error: NextResponse }> {
  const user = await currentUser();
  if (!user) {
    return {
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
  }
  if (admin && user.role !== "admin") {
    return {
      error: NextResponse.json({ error: "Admin only" }, { status: 403 }),
    };
  }
  return { user };
}
