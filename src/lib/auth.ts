import { cookies } from "next/headers";
import {
  createSession,
  deleteSession,
  getUserByToken,
  type AuthUser,
} from "./db";

export { hashPassword, verifyPassword } from "./password";

export const SESSION_COOKIE = "ipn_session";
const SESSION_DAYS = 7;

export async function currentUser(): Promise<AuthUser | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return getUserByToken(token);
}

export async function startSession(userId: number) {
  const token = await createSession(userId, SESSION_DAYS);
  cookies().set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function endSession() {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (token) await deleteSession(token);
  cookies().delete(SESSION_COOKIE);
}
