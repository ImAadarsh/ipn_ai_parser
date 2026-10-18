import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import { createUser, initSchema, listUsers } from "@/lib/db";
import { hashPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await authGuard(true);
  if (guard.error) return guard.error;
  await initSchema();
  return NextResponse.json({ users: await listUsers() });
}

export async function POST(request: Request) {
  const guard = await authGuard(true);
  if (guard.error) return guard.error;
  const body = (await request.json().catch(() => ({}))) as {
    username?: string;
    password?: string;
    role?: string;
  };
  const username = String(body.username || "").trim();
  const password = String(body.password || "");
  const role = body.role === "admin" ? "admin" : "user";

  if (!username || password.length < 6) {
    return NextResponse.json(
      { error: "Username required and password must be 6+ characters" },
      { status: 400 }
    );
  }

  await initSchema();
  try {
    const id = await createUser({
      username,
      passwordHash: hashPassword(password),
      role,
    });
    return NextResponse.json({ id, username, role });
  } catch {
    return NextResponse.json(
      { error: "Username already exists" },
      { status: 409 }
    );
  }
}
