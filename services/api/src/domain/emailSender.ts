type SendEmailInput = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  from: string;
  replyTo?: string;
};

function toHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "<br/>");
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
    ]
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
