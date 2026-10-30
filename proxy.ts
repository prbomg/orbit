import { NextRequest, NextResponse } from "next/server";
export function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (path === "/login" || path === "/login/" || path.startsWith("/api/auth/")) return NextResponse.next();
  // Only an optimistic redirect. Layout and every private API verify the DB session.
  if (!request.cookies.get("orbit_session")?.value) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Войдите в аккаунт" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    const url = request.nextUrl.clone(); url.pathname = "/login/"; url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}
// File routes authenticate every operation themselves. Skip body cloning here:
// Next's default 10 MiB proxy buffer would silently truncate binary uploads.
export const config = { matcher: ["/((?!_next/static|_next/image|icon.svg|favicon.ico|api/system/files(?:/|$)).*)"] };
