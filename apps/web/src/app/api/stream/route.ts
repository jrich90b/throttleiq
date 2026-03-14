import { apiFetch } from "@/lib/apiFetch";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? process.env.API_BASE_URL;
  if (!base) {
    return NextResponse.json({ ok: false, error: "API base not configured" }, { status: 500 });
  }

  const authResp = await apiFetch(`${base}/auth/me`, { cache: "no-store" });
  const authJson = await authResp.json().catch(() => null);
  if (!authResp.ok || !authJson?.ok) {
    return NextResponse.json({ ok: false, error: "auth required" }, { status: 401 });
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (payload: string) => controller.enqueue(encoder.encode(payload));

      send("event: ping\ndata: {}\n\n");

      const pingInterval = setInterval(() => {
        send("event: ping\ndata: {}\n\n");
      }, 5000);

      const keepAlive = setInterval(() => {
        send(":keepalive\n\n");
      }, 15000);

      const cleanup = () => {
        clearInterval(pingInterval);
        clearInterval(keepAlive);
        controller.close();
      };

      if (req.signal) {
        req.signal.addEventListener("abort", cleanup, { once: true });
      }
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    }
  });
}
