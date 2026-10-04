import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { ADMIN_COOKIE, ADMIN_LOGIN_PATH, isValidSessionToken } from "@/lib/admin-auth";

// Optimistic gate for /admin. Pages and server actions re-check with requireAdmin().
export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === ADMIN_LOGIN_PATH) return NextResponse.next();
  if (isValidSessionToken(request.cookies.get(ADMIN_COOKIE)?.value)) return NextResponse.next();
  return NextResponse.redirect(new URL(ADMIN_LOGIN_PATH, request.url));
}

export const config = {
  matcher: ["/admin", "/admin/:path*"],
};
