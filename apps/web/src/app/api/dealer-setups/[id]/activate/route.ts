import { NextResponse } from "next/server";
import { activeClientApiFetch, jsonUpstreamResponse } from "../../../active-clients/upstream";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const base = process.env.API_BASE_URL;
  if (!base) return NextResponse.json({ ok: false, error: "API_BASE_URL not set" }, { status: 500 });

  const { id } = await ctx.params;
  const { response, text } = await activeClientApiFetch(base, `/dealer-setups/${encodeURIComponent(id)}/activate`, {
    method: "POST"
  });
  return jsonUpstreamResponse(response, text);
}
