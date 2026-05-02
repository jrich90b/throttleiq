import { config as dotenvConfig } from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { sendEmail } from "../services/api/src/domain/emailSender.ts";

type Attachment = {
  content: string;
  filename: string;
  type?: string;
  disposition?: "attachment" | "inline";
};

function loadRuntimeEnv() {
  dotenvConfig();
  const feedbackLoopEnvPath = String(
    process.env.FEEDBACK_LOOP_ENV_PATH || "/home/ubuntu/throttleiq-runtime/.feedback_loop.env"
  ).trim();
  if (feedbackLoopEnvPath && fs.existsSync(feedbackLoopEnvPath)) {
    dotenvConfig({ path: feedbackLoopEnvPath, override: true });
  }
}

function existingFiles(dirPath: string): string[] {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .map(name => path.join(dirPath, name))
    .filter(filePath => fs.existsSync(filePath) && fs.statSync(filePath).isFile());
}

function newestFile(files: string[]): string | null {
  const sorted = [...files].sort((a, b) => {
    return fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs;
  });
  return sorted[0] ?? null;
}

function mimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".html" || ext === ".htm") return "text/html";
  if (ext === ".json") return "application/json";
  return "application/octet-stream";
}

function toAttachment(filePath: string): Attachment {
  return {
    content: fs.readFileSync(filePath).toString("base64"),
    filename: path.basename(filePath),
    type: mimeType(filePath),
    disposition: "attachment"
  };
}

function companionFiles(filePath: string): string[] {
  const parsed = path.parse(filePath);
  const base = path.join(parsed.dir, parsed.name);
  const candidates = [`${base}.png`, `${base}.html`];
  return Array.from(new Set(candidates.filter(candidate => fs.existsSync(candidate))));
}

async function run() {
  loadRuntimeEnv();

  const explicitFile = String(process.env.TLP_DEBUG_FILE ?? "").trim();
  const debugDir = String(process.env.TLP_DEBUG_DIR || "/tmp/tlp-debug").trim();
  const pattern = String(process.env.TLP_DEBUG_PATTERN || "visit_submit_log").trim();
  const to = String(process.env.TLP_DEBUG_EMAIL_TO || process.env.FEEDBACK_REPORT_EMAIL_TO || "").trim();
  const from = String(
    process.env.TLP_DEBUG_EMAIL_FROM ||
      process.env.FEEDBACK_REPORT_EMAIL_FROM ||
      process.env.NOTIFICATION_FROM_EMAIL ||
      ""
  ).trim();

  if (!to) {
    console.error("Missing TLP_DEBUG_EMAIL_TO or FEEDBACK_REPORT_EMAIL_TO");
    process.exit(1);
  }
  if (!from) {
    console.error("Missing TLP_DEBUG_EMAIL_FROM, FEEDBACK_REPORT_EMAIL_FROM, or NOTIFICATION_FROM_EMAIL");
    process.exit(1);
  }

  const selected =
    explicitFile && fs.existsSync(explicitFile)
      ? explicitFile
      : newestFile(
          existingFiles(debugDir).filter(filePath => {
            const name = path.basename(filePath);
            return name.includes(pattern) && /\.(png|html?)$/i.test(name);
          })
        );

  if (!selected) {
    console.error(`No TLP debug files found in ${debugDir} matching ${pattern}`);
    process.exit(1);
  }

  const files = companionFiles(selected);
  const attachments = files.map(toAttachment);
  const generatedAt = new Date().toISOString();
  const subject = `[ThrottleIQ TLP Debug] ${path.basename(selected)}`;
  const text = [
    `TLP debug artifact generated: ${generatedAt}`,
    "",
    `Selected file: ${selected}`,
    `Debug directory: ${debugDir}`,
    "",
    "Attached files:",
    ...files.map(filePath => `- ${filePath}`)
  ].join("\n");

  await sendEmail({
    to,
    from,
    subject,
    text,
    attachments
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        to,
        subject,
        files,
        attachmentCount: attachments.length
      },
      null,
      2
    )
  );
}

run().catch(err => {
  console.error("send_tlp_debug_email failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
