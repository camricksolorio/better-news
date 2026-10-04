"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ADMIN_COOKIE, ADMIN_LOGIN_PATH, isCorrectSecret, requireAdmin, sessionToken } from "@/lib/admin-auth";

export async function login(_prev: { error?: string } | undefined, formData: FormData) {
  const input = formData.get("secret");
  const token = sessionToken();
  if (typeof input !== "string" || !token || !isCorrectSecret(input)) {
    return { error: "Wrong secret." };
  }
  (await cookies()).set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: "/admin",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/admin");
}

export async function logout() {
  await requireAdmin();
  (await cookies()).delete({ name: ADMIN_COOKIE, path: "/admin" });
  redirect(ADMIN_LOGIN_PATH);
}
