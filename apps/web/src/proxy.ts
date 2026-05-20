import { NextRequest, NextResponse } from "next/server";

export function proxy(request: NextRequest) {
  const host = request.headers.get("host")?.split(":")[0]?.toLowerCase() ?? "";
  const pathname = request.nextUrl.pathname;
  const isLeadRiderRoot = host === "leadrider.ai" || host === "www.leadrider.ai";

  if (isLeadRiderRoot && pathname === "/") {
    return NextResponse.rewrite(new URL("/landing", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/"]
};
