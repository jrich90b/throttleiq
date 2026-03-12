import "dotenv/config";
import http from "node:http";
import { URL } from "node:url";

const PORT = Number(process.env.MCP_PORT ?? 4010);
const API_KEY = process.env.MCP_API_KEY ?? "";

function sendJson(res: http.ServerResponse, status: number, payload: any) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

function unauthorized(res: http.ServerResponse) {
  sendJson(res, 401, { ok: false, error: "unauthorized" });
}

function parseBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", chunk => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (req.method === "GET" && url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, service: "mcp", ts: new Date().toISOString() });
  }

  if (req.method === "POST" && url.pathname === "/execute") {
    const auth = String(req.headers.authorization ?? "");
    if (API_KEY && auth !== `Bearer ${API_KEY}`) {
      return unauthorized(res);
    }

    let body: any = {};
    try {
      body = await parseBody(req);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: "invalid_json" });
    }

    const task = String(body?.task ?? "").trim();
    const siteUrl = String(body?.siteUrl ?? "").trim();
    if (!task || !siteUrl) {
      return sendJson(res, 400, { ok: false, error: "missing_task_or_site" });
    }

    // TODO: Replace with real SharePoint integration.
    return sendJson(res, 200, {
      ok: true,
      result: {
        status: "stub",
        message: "MCP server is running. SharePoint integration not yet implemented.",
        task,
        siteUrl
      }
    });
  }

  return sendJson(res, 404, { ok: false, error: "not_found" });
});

server.listen(PORT, () => {
  console.log(`[mcp] listening on :${PORT}`);
});
