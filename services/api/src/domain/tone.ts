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

