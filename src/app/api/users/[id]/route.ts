import { NextResponse } from "next/server";
import { authGuard } from "@/lib/api-auth";
import {
  deleteUser,
  initSchema,
  setUserActive,
  setUserPassword,
} from "@/lib/db";
import { hashPassword } from "@/lib/password";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: { id: string } };

export async function PATCH(request: Request, { params }: Params) {
  const guard = await authGuard(true);
  if (guard.error) return guard.error;
  const id = Number(params.id);
  if (!id) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = (await request.json().catch(() => ({}))) as {
    active?: boolean;
    password?: string;
  };
  await initSchema();

  if (typeof body.active === "boolean") {
    if (id === guard.user.id && !body.active) {
      return NextResponse.json(
        { error: "You cannot deactivate yourself" },
        { status: 400 }
      );
    }
    await setUserActive(id, body.active);
  }
  if (typeof body.password === "string" && body.password) {
    if (body.password.length < 6) {
      return NextResponse.json(
        { error: "Password must be 6+ characters" },
        { status: 400 }
      );
    }
    await setUserPassword(id, hashPassword(body.password));
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(_request: Request, { params }: Params) {
  const guard = await authGuard(true);
  if (guard.error) return guard.error;
  const id = Number(params.id);
  if (!id) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }
  if (id === guard.user.id) {
    return NextResponse.json(
      { error: "You cannot delete yourself" },
      { status: 400 }
    );
  }
  await initSchema();
  await deleteUser(id);
  return NextResponse.json({ ok: true });
}
