export function normalizeSalesTone(text: string): string {
  let out = String(text ?? "").trim();
  if (!out) return out;

  const replacements: Array<[RegExp, string]> = [
    [
      /\bTotally understand, and thank you for saying that about the bike\.\b/gi,
      "I hear you, and I appreciate that."
    ],
    [
      /\bTotally understand\.\s*If anything changes, just reach out\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ],
    [
      /\bTotally understand, and I appreciate that\.\s*If anything changes, just reach out\.\b/gi,
      "I hear you, and I appreciate that. If anything changes down the road, just give me a shout."
    ],
    [
      /\bIf anything changes, just reach out\.\b/gi,
      "If anything changes down the road, just give me a shout."
    ],
    [
      /\bIf anything changes, just let me know\.\b/gi,
      "If anything changes down the road, just give me a shout."
    ],
    [
      /\bI(?:’|')m here when you(?:’|')re ready\.\s*Just reach out when the time is right\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ],
    [
      /\bNo problem\s*[—-]\s*I(?:’|')m here when you(?:’|')re ready\.\s*Just reach out when the time is right\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ],
    [
      /\bUnderstood\s*[—-]\s*I(?:’|')m here when you(?:’|')re ready\.\s*Just reach out when the time is right\.\b/gi,
      "I hear you. If anything changes down the road, just give me a shout."
    ]
  ];

  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }

  return out;
}

function firstToken(value: string): string {
  const token = String(value ?? "")
    .trim()
    .split(/\s+/)[0];
  return token || "there";
}

export function formatSmsLayout(text: string): string {
  let out = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!out) return out;
  out = out.replace(/[ \t]+\n/g, "\n");
  out = out.replace(/\n{3,}/g, "\n\n");
  out = out.replace(/[ \t]{2,}/g, " ");
  return out.trim();
}

export function formatEmailLayout(
  text: string,
  opts?: {
    firstName?: string | null;
    fallbackName?: string | null;
  }
): string {
  let out = formatSmsLayout(text);
  if (!out) return out;
  const preferredName = firstToken(opts?.firstName ?? "");
  const fallbackName = firstToken(opts?.fallbackName ?? "there");
  const greetingName = preferredName !== "there" ? preferredName : fallbackName;
  out = out.replace(/^Hi\s+([^—,\n]+)\s*[—-]\s*/i, (_m, name) => `Hi ${String(name).trim()},\n\n`);
  if (!/^(Hi|Hello)\s+[^,\n]+,\s*/i.test(out)) {
    out = `Hi ${greetingName},\n\n${out}`;
  }
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}
