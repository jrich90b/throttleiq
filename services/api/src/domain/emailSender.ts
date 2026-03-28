type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from: string;
  replyTo?: string;
  attachments?: Array<{
    content: string;
    filename: string;
    type?: string;
    disposition?: "attachment" | "inline";
  }>;
};

function toHtml(text: string) {
  let html = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
  html = html.replace(
    /\b(book here|you can choose a time here|you can book an appointment here):\s*(https?:\/\/[^\s<]+)/gi,
    (_m, label, url) => {
      const prefix = String(label).replace(/\s*here$/i, "").trim();
      const prefixWithSpace = prefix.length ? `${prefix} ` : "";
      return `${prefixWithSpace}<a href="${url}">here</a>`;
    }
  );
  html = html.replace(
    /(^|<br\/>)(https?:\/\/[^\s<]+)(?=<br\/>|$)/g,
    (m, prefix, url) => {
      if (!/\.(png|jpe?g|gif|webp)(\?|#|$)/i.test(url)) return m;
      const lead = prefix ?? "";
      return `${lead}<img src="${url}" alt="Logo" style="max-width:180px;height:auto;display:block;margin-top:8px;" />`;
    }
  );
  return html;
}

export async function sendEmail(input: SendEmailInput) {
  const apiKey = process.env.SENDGRID_API_KEY;
  if (!apiKey) {
    throw new Error("SendGrid API key not configured (SENDGRID_API_KEY)");
  }
  const payload = {
    personalizations: [{ to: [{ email: input.to }] }],
    from: { email: input.from },
    ...(input.replyTo ? { reply_to: { email: input.replyTo } } : {}),
    subject: input.subject,
    content: [
      { type: "text/plain", value: input.text },
      { type: "text/html", value: input.html ?? toHtml(input.text) }
    ],
    ...(input.attachments && input.attachments.length
      ? {
          attachments: input.attachments.map(att => ({
            content: att.content,
            filename: att.filename,
            type: att.type ?? "application/octet-stream",
            disposition: att.disposition ?? "attachment"
          }))
        }
      : {})
  };

  const resp = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`SendGrid error ${resp.status}: ${body.slice(0, 200)}`);
  }
}
