import { NextResponse } from "next/server";
import { findUserByUsername, initSchema } from "@/lib/db";
import { startSession, verifyPassword } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
  };
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  if (!username || !password) {
    return NextResponse.json(
      { error: "Username and password required" },
      { status: 400 }
    );
  }

  await initSchema();
  const user = await findUserByUsername(username);
  if (
    !user ||
    !user.active ||
    !verifyPassword(password, user.password_hash)
  ) {
    return NextResponse.json(
      { error: "Invalid username or password" },
      { status: 401 }
    );
  }

  await startSession(user.id);
  return NextResponse.json({
    user: { id: user.id, username: user.username, role: user.role },
  });
}
