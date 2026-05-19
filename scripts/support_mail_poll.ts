const apiBase = (process.env.API_BASE_URL || process.env.NEXT_PUBLIC_API_BASE_URL || "").replace(/\/$/, "");
const token = process.env.SUPPORT_AGENT_POLL_TOKEN || process.env.AUTOMATION_RUN_WRITE_TOKEN || "";
const limit = Number(process.env.SUPPORT_MAIL_POLL_LIMIT ?? "10");

async function main() {
  if (!apiBase) throw new Error("API_BASE_URL is required.");
  if (!token) throw new Error("SUPPORT_AGENT_POLL_TOKEN or AUTOMATION_RUN_WRITE_TOKEN is required.");
  const resp = await fetch(`${apiBase}/support-mail/poll`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({ limit: Number.isFinite(limit) ? limit : 10 })
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Support mail poll failed (${resp.status}): ${text.slice(0, 500)}`);
  console.log(text);
}

main().catch(err => {
  console.error(err?.message ?? err);
  process.exit(1);
});
