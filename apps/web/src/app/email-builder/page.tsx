"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type CampaignAssetTarget =
  | "sms"
  | "email"
  | "facebook_post"
  | "instagram_post"
  | "instagram_story"
  | "web_banner"
  | "flyer_8_5x11";

type CampaignGeneratedAsset = {
  target: CampaignAssetTarget;
  url: string;
  width?: number;
  height?: number;
  type?: string;
  label?: string;
};

type CampaignEntry = {
  id: string;
  name: string;
  prompt?: string;
  description?: string;
  briefDocumentUrls?: string[];
  inspirationImageUrls?: string[];
  assetImageUrls?: string[];
  generatedAssets?: CampaignGeneratedAsset[];
  finalImageUrl?: string;
  emailSubject?: string;
  emailBodyText?: string;
  emailBodyHtml?: string;
  updatedAt?: string;
  createdAt?: string;
};

type AuthUser = {
  id: string;
  name?: string;
  email?: string;
  role?: string;
};

const IMAGE_TARGET_PRIORITY: CampaignAssetTarget[] = [
  "flyer_8_5x11",
  "web_banner",
  "facebook_post",
  "instagram_post",
  "instagram_story",
  "sms",
  "email"
];

function campaignLooksLikeImageUrl(raw: unknown): boolean {
  const value = String(raw ?? "").trim();
  if (!value) return false;
  if (/\/uploads\/campaigns\//i.test(value)) return true;
  return /\.(png|jpe?g|webp|gif|avif|bmp|svg)(\?.*)?$/i.test(value);
}

function campaignPrimaryImage(entry: CampaignEntry | null | undefined): string {
  if (!entry) return "";
  const generatedAssets = Array.isArray(entry.generatedAssets) ? entry.generatedAssets : [];
  for (const target of IMAGE_TARGET_PRIORITY) {
    const match = generatedAssets.find(asset => {
      const assetTarget = String(asset?.target ?? "").trim();
      const assetUrl = String(asset?.url ?? "").trim();
      return assetTarget === target && campaignLooksLikeImageUrl(assetUrl);
    });
    if (match?.url) return String(match.url).trim();
  }
  const finalImageUrl = String(entry.finalImageUrl ?? "").trim();
  if (campaignLooksLikeImageUrl(finalImageUrl)) return finalImageUrl;
  const inspiration = Array.isArray(entry.inspirationImageUrls) ? entry.inspirationImageUrls : [];
  for (const raw of inspiration) {
    const url = String(raw ?? "").trim();
    if (campaignLooksLikeImageUrl(url)) return url;
  }
  return "";
}

function toPreviewHtml(subject: string, html: string, text: string): string {
  const htmlTrimmed = String(html ?? "").trim();
  if (htmlTrimmed) {
    if (/<!doctype|<html|<body/i.test(htmlTrimmed)) return htmlTrimmed;
    return `<!doctype html><html><head><meta charset="utf-8" /></head><body>${htmlTrimmed}</body></html>`;
  }
  const escaped = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const safeSubject = String(subject ?? "").trim() || "Email Preview";
  return `<!doctype html><html><head><meta charset="utf-8" /><title>${safeSubject}</title></head><body style="font-family:Arial,Helvetica,sans-serif;padding:20px;white-space:pre-wrap;">${escaped}</body></html>`;
}

function escapeHtmlForEmail(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function derivePrimarySectionText(rawText: string, sectionTitle: string): string {
  const title = String(sectionTitle ?? "").trim().toLowerCase();
  const lines = String(rawText ?? "")
    .replace(/\r/g, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\[object Object\]/gi, " ")
    .split(/\n+/)
    .map(v => v.trim())
    .filter(Boolean)
    .filter(line => {
      const lower = line.toLowerCase();
      if (!lower) return false;
      if (title && lower === title) return false;
      if (/^find a dealer/i.test(lower)) return false;
      if (/^[a-z0-9 .&'-]+\s+\|\s+[a-z0-9 .&'-]+$/i.test(lower)) return false;
      if (/^https?:\/\//i.test(lower)) return false;
      return true;
    });
  if (!lines.length) return "";
  const joined = lines.join(" ").replace(/\s+/g, " ").trim();
  const withoutUrls = joined.replace(/https?:\/\/[^\s<>"'`]+/gi, " ").replace(/[ ]{2,}/g, " ").trim();
  if (!withoutUrls) return "";
  const sentences = withoutUrls
    .split(/(?<=[.!?])\s+/)
    .map(v => v.trim())
    .filter(Boolean);
  const picked = sentences.slice(0, 2).join(" ").trim() || withoutUrls;
  if (picked.length <= 360) return picked;
  const clipped = picked.slice(0, 360);
  const boundary = Math.max(clipped.lastIndexOf("."), clipped.lastIndexOf("!"), clipped.lastIndexOf("?"));
  if (boundary >= 180) return clipped.slice(0, boundary + 1).trim();
  return `${clipped.trim()}...`;
}

function syncDeterministicEmailHtmlFromText(html: string, text: string, sectionTitle: string): string {
  const rawHtml = String(html ?? "").trim();
  const rawText = String(text ?? "").trim();
  if (!rawHtml || !rawText) return rawHtml;
  if (!/data-lr-email-shell/i.test(rawHtml) && !/data-lr-email-section/i.test(rawHtml)) return rawHtml;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(rawHtml, "text/html");
    const bodyCell =
      (doc.querySelector("td[data-lr-email-section-body='1']") as HTMLTableCellElement | null) ||
      (doc.querySelector("td[style*='color:#e5e7eb'][style*='line-height:21px']") as HTMLTableCellElement | null);
    if (!bodyCell) return rawHtml;

    const infoBlocks = Array.from(
      bodyCell.querySelectorAll("[data-lr-email-info='1'], div[style*='color:#cbd5e1']")
    ).map(node => (node as HTMLElement).outerHTML);

    const primaryText = derivePrimarySectionText(rawText, sectionTitle);
    if (!primaryText) return rawHtml;
    const copyHtml = escapeHtmlForEmail(primaryText).replace(/\n/g, "<br>");
    bodyCell.innerHTML = `${copyHtml}${infoBlocks.length ? `\n${infoBlocks.join("\n")}` : ""}`;

    const rendered = doc.documentElement?.outerHTML ? `<!doctype html>${doc.documentElement.outerHTML}` : rawHtml;
    return rendered;
  } catch {
    return rawHtml;
  }
}

function parseCampaignUrlsText(raw: string): string[] {
  const text = String(raw ?? "").trim();
  if (!text) return [];
  const matches = text.match(/https?:\/\/[^\s<>"'`]+/gi) ?? [];
  if (!matches.length) return [];
  return Array.from(
    new Set(
      matches
        .map(v => String(v ?? "").trim().replace(/[),.;!?]+$/g, ""))
        .filter(Boolean)
    )
  );
}

function fileLabelFromUrl(url: string, fallback: string): string {
  try {
    const parsed = new URL(url);
    const pathname = String(parsed.pathname ?? "");
    const base = pathname.split("/").filter(Boolean).pop() || "";
    return decodeURIComponent(base || fallback);
  } catch {
    const base = String(url ?? "")
      .split("/")
      .filter(Boolean)
      .pop();
    return base || fallback;
  }
}

export default function EmailBuilderPage() {
  const [authLoading, setAuthLoading] = useState(true);
  const [authUser, setAuthUser] = useState<AuthUser | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);

  const [loading, setLoading] = useState(false);
  const [campaigns, setCampaigns] = useState<CampaignEntry[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [selectedLockerIds, setSelectedLockerIds] = useState<string[]>([]);
  const [includeCurrentCampaign, setIncludeCurrentCampaign] = useState(true);

  const [customPrompt, setCustomPrompt] = useState("");
  const [customDescription, setCustomDescription] = useState("");
  const [referenceImageUrlsText, setReferenceImageUrlsText] = useState("");
  const [briefDocumentUrlsText, setBriefDocumentUrlsText] = useState("");

  const [uploadBusy, setUploadBusy] = useState<"" | "refs" | "briefs">("");
  const refsInputRef = useRef<HTMLInputElement | null>(null);
  const briefsInputRef = useRef<HTMLInputElement | null>(null);

  const [subject, setSubject] = useState("");
  const [emailText, setEmailText] = useState("");
  const [emailHtml, setEmailHtml] = useState("");
  const [sendTo, setSendTo] = useState("");
  const [testTo, setTestTo] = useState("");

  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState<"" | "live" | "test">("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const selectedCampaign = useMemo(
    () => campaigns.find(row => row.id === selectedCampaignId) ?? null,
    [campaigns, selectedCampaignId]
  );

  const lockerCampaigns = useMemo(
    () => campaigns.filter(row => row.id !== selectedCampaignId),
    [campaigns, selectedCampaignId]
  );

  const previewHtmlDoc = useMemo(
    () => toPreviewHtml(subject, emailHtml, emailText),
    [subject, emailHtml, emailText]
  );

  const contextPreview = useMemo(() => {
    const ids = Array.from(
      new Set([...(includeCurrentCampaign && selectedCampaignId ? [selectedCampaignId] : []), ...selectedLockerIds])
    );
    return ids
      .map(id => campaigns.find(row => row.id === id))
      .filter((row): row is CampaignEntry => Boolean(row));
  }, [campaigns, includeCurrentCampaign, selectedCampaignId, selectedLockerIds]);

  async function loadCampaigns() {
    setLoading(true);
    try {
      const resp = await fetch("/api/campaigns", { cache: "no-store" });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) throw new Error(data?.error ?? "Failed to load campaigns");
      const rows: CampaignEntry[] = Array.isArray(data?.campaigns) ? data.campaigns : [];
      rows.sort((a, b) => {
        const aAt = new Date(String(a.updatedAt ?? a.createdAt ?? "")).getTime();
        const bAt = new Date(String(b.updatedAt ?? b.createdAt ?? "")).getTime();
        return bAt - aAt;
      });
      setCampaigns(rows);
      if (!selectedCampaignId && rows.length) {
        setSelectedCampaignId(rows[0].id);
      } else if (selectedCampaignId && !rows.some(row => row.id === selectedCampaignId)) {
        setSelectedCampaignId(rows[0]?.id ?? "");
      }
    } catch (err: any) {
      setError(err?.message ?? "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setAuthLoading(true);
      setAuthError(null);
      try {
        const authResp = await fetch("/api/auth/me", { cache: "no-store" });
        const authJson = await authResp.json().catch(() => null);
        if (!authResp.ok || !authJson?.ok) {
          if (!cancelled) {
            setAuthUser(null);
            setAuthError("Sign in to use Email Builder.");
          }
          return;
        }
        if (!cancelled) {
          setAuthUser((authJson?.user as AuthUser | undefined) ?? null);
        }
      } catch (err: any) {
        if (!cancelled) setAuthError(err?.message ?? "Auth check failed");
      } finally {
        if (!cancelled) setAuthLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!authUser) return;
    void loadCampaigns();
  }, [authUser]);

  useEffect(() => {
    if (!selectedCampaign) {
      setSubject("");
      setEmailText("");
      setEmailHtml("");
      return;
    }
    setSubject(String(selectedCampaign.emailSubject ?? ""));
    setEmailText(String(selectedCampaign.emailBodyText ?? ""));
    setEmailHtml(String(selectedCampaign.emailBodyHtml ?? ""));
    setCustomPrompt(String(selectedCampaign.prompt ?? ""));
    setCustomDescription(String(selectedCampaign.description ?? ""));
    setReferenceImageUrlsText("");
    setBriefDocumentUrlsText("");
  }, [selectedCampaignId, selectedCampaign]);

  async function uploadFiles(
    files: FileList | null,
    endpoint: string,
    kind: "refs" | "briefs"
  ): Promise<string[]> {
    if (!files || !files.length) return [];
    const out: string[] = [];
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.append("file", file);
      const resp = await fetch(endpoint, { method: "POST", body: fd });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.url) {
        throw new Error(data?.error ?? `Failed to upload ${kind} file`);
      }
      out.push(String(data.url));
    }
    return out;
  }

  async function handleUpload(kind: "refs" | "briefs", files: FileList | null) {
    if (!files?.length) return;
    setUploadBusy(kind);
    setError(null);
    try {
      if (kind === "refs") {
        const urls = await uploadFiles(files, "/api/campaigns/media?profile=email", kind);
        setReferenceImageUrlsText(prev => {
          const next = Array.from(new Set([...parseCampaignUrlsText(prev), ...urls]));
          return next.join("\n");
        });
      } else {
        const urls = await uploadFiles(files, "/api/campaigns/briefs", kind);
        setBriefDocumentUrlsText(prev => {
          const next = Array.from(new Set([...parseCampaignUrlsText(prev), ...urls]));
          return next.join("\n");
        });
      }
      setNotice("Files uploaded.");
    } catch (err: any) {
      setError(err?.message ?? "Upload failed");
    } finally {
      setUploadBusy("");
    }
  }

  async function generateEmail() {
    if (!selectedCampaignId) {
      setError("Select a base campaign.");
      return;
    }
    setGenerating(true);
    setError(null);
    setNotice(null);
    try {
      const payload = {
        campaignId: selectedCampaignId,
        includeCurrentCampaign,
        selectedCampaignIds: selectedLockerIds,
        prompt: String(customPrompt ?? "").trim() || undefined,
        description: String(customDescription ?? "").trim() || undefined,
        referenceImageUrls: parseCampaignUrlsText(referenceImageUrlsText),
        briefDocumentUrls: parseCampaignUrlsText(briefDocumentUrlsText)
      };
      const resp = await fetch("/api/campaigns/email/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.error ?? "Failed to generate email");
      }
      const generated = data?.generated ?? {};
      const campaign = (data?.campaign as CampaignEntry | undefined) ?? null;
      setSubject(String(generated?.emailSubject ?? campaign?.emailSubject ?? ""));
      setEmailText(String(generated?.emailBodyText ?? campaign?.emailBodyText ?? ""));
      setEmailHtml(String(generated?.emailBodyHtml ?? campaign?.emailBodyHtml ?? ""));
      if (campaign) {
        setCampaigns(prev => {
          const idx = prev.findIndex(row => row.id === campaign.id);
          const next = idx >= 0 ? prev.map(row => (row.id === campaign.id ? campaign : row)) : [campaign, ...prev];
          return next;
        });
      }
      setNotice("Email generated.");
    } catch (err: any) {
      setError(err?.message ?? "Failed to generate email");
    } finally {
      setGenerating(false);
    }
  }

  async function saveEmail() {
    if (!selectedCampaignId) {
      setError("Select a campaign.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const selectedHtml = String(selectedCampaign?.emailBodyHtml ?? "").trim();
      const selectedText = String(selectedCampaign?.emailBodyText ?? "").trim();
      const draftHtml = String(emailHtml ?? "").trim();
      const draftText = String(emailText ?? "").trim();
      const htmlChanged = draftHtml !== selectedHtml;
      const textChanged = draftText !== selectedText;

      let htmlForSave = emailHtml;
      if (textChanged && !htmlChanged) {
        const synced = syncDeterministicEmailHtmlFromText(
          draftHtml,
          draftText,
          String(selectedCampaign?.name ?? subject ?? "Campaign Update")
        );
        if (synced) {
          htmlForSave = synced;
          setEmailHtml(synced);
        }
      }

      const resp = await fetch(`/api/campaigns/${encodeURIComponent(selectedCampaignId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emailSubject: subject,
          emailBodyText: emailText,
          emailBodyHtml: htmlForSave,
          channel: "email",
          assetTargets: ["email"]
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok || !data?.campaign) {
        throw new Error(data?.error ?? "Failed to save email");
      }
      const campaign = data.campaign as CampaignEntry;
      setCampaigns(prev => prev.map(row => (row.id === campaign.id ? campaign : row)));
      if (!htmlChanged && textChanged) setNotice("Email saved. Preview updated from edited text.");
      else setNotice("Email saved.");
    } catch (err: any) {
      setError(err?.message ?? "Failed to save email");
    } finally {
      setSaving(false);
    }
  }

  async function sendEmailNow(mode: "live" | "test") {
    if (!selectedCampaignId) {
      setError("Select a campaign.");
      return;
    }
    const recipient = String(mode === "test" ? testTo : sendTo).trim();
    if (!recipient) {
      setError(mode === "test" ? "Enter a test email address." : "Enter a recipient email address.");
      return;
    }
    setSending(mode);
    setError(null);
    setNotice(null);
    try {
      const resp = await fetch("/api/campaigns/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          campaignId: selectedCampaignId,
          to: recipient,
          test: mode === "test",
          subject,
          emailBodyText: emailText,
          emailBodyHtml: emailHtml
        })
      });
      const data = await resp.json().catch(() => null);
      if (!resp.ok || !data?.ok) {
        throw new Error(data?.details || data?.error || "Failed to send email");
      }
      const sentTo = String(data?.to ?? recipient);
      const sentSubject = String(data?.subject ?? subject).trim();
      setNotice(
        `${mode === "test" ? "Test email sent" : "Email sent"} to ${sentTo}${sentSubject ? ` • Subject: ${sentSubject}` : ""}`
      );
      if (mode === "live") setSendTo(sentTo);
      if (mode === "test") setTestTo(sentTo);
    } catch (err: any) {
      setError(err?.message ?? "Failed to send email");
    } finally {
      setSending("");
    }
  }

  function openPreview() {
    const html = String(previewHtmlDoc ?? "").trim();
    if (!html) {
      setError("Generate email first.");
      return;
    }
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const win = window.open(url, "_blank", "noopener,noreferrer");
    if (!win) {
      setError("Popup blocked. Allow popups and retry.");
      window.URL.revokeObjectURL(url);
      return;
    }
    setTimeout(() => window.URL.revokeObjectURL(url), 60_000);
  }

  function downloadHtml() {
    const html = String(previewHtmlDoc ?? "").trim();
    if (!html) {
      setError("Generate email first.");
      return;
    }
    const blob = new Blob([html], { type: "text/html;charset=utf-8" });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug =
      String(selectedCampaign?.name ?? "campaign_email")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "") || "campaign_email";
    a.href = url;
    a.download = `${slug}.html`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  if (authLoading) {
    return <main className="min-h-screen bg-[#060b13] text-gray-100 p-8">Loading Email Builder...</main>;
  }
  if (!authUser) {
    return (
      <main className="min-h-screen bg-[#060b13] text-gray-100 p-8">
        <div className="max-w-xl border border-white/15 rounded-lg p-5 bg-black/25">
          <h1 className="text-xl font-semibold">Email Builder</h1>
          <p className="text-sm text-gray-300 mt-2">{authError || "Sign in required."}</p>
          <a
            href="/"
            className="inline-flex mt-4 px-4 py-2 rounded border border-white/30 text-sm hover:bg-white/10"
          >
            Go to Sign in
          </a>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#060b13] text-gray-100">
      <div className="max-w-[1400px] mx-auto px-4 md:px-6 py-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Email Builder</h1>
            <p className="text-sm text-gray-400 mt-1">
              Separate email workflow with campaign locker context, uploads, and HTML preview.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <a href="/" className="px-3 py-2 border border-white/25 rounded text-sm hover:bg-white/10">
              Back to App
            </a>
            <button
              className="px-3 py-2 border border-white/25 rounded text-sm hover:bg-white/10 disabled:opacity-50"
              onClick={() => void loadCampaigns()}
              disabled={loading}
            >
              {loading ? "Refreshing..." : "Refresh campaigns"}
            </button>
          </div>
        </div>

        {error ? <div className="border border-red-400/40 bg-red-950/40 rounded px-3 py-2 text-sm">{error}</div> : null}
        {notice ? <div className="border border-emerald-400/40 bg-emerald-950/30 rounded px-3 py-2 text-sm">{notice}</div> : null}

        <div className="grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] gap-4">
          <aside className="border border-white/15 rounded-xl bg-[#0b1220] p-3 space-y-3">
            <div>
              <label className="block text-xs text-gray-300">Base campaign</label>
              <select
                className="mt-1 w-full border border-white/25 bg-[#0a1020] rounded px-2.5 py-2 text-sm"
                value={selectedCampaignId}
                onChange={e => setSelectedCampaignId(e.target.value)}
              >
                <option value="">Select campaign</option>
                {campaigns.map(row => (
                  <option key={row.id} value={row.id}>
                    {row.name}
                  </option>
                ))}
              </select>
            </div>

            <label className="inline-flex items-center gap-2 text-sm text-gray-200">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={includeCurrentCampaign}
                onChange={e => setIncludeCurrentCampaign(e.target.checked)}
              />
              Include base campaign in context
            </label>

            <div>
              <div className="text-xs font-semibold text-gray-300 mb-1">Campaign locker</div>
              <div className="max-h-[280px] overflow-y-auto border border-white/10 rounded">
                {lockerCampaigns.map(row => {
                  const checked = selectedLockerIds.includes(row.id);
                  const img = campaignPrimaryImage(row);
                  return (
                    <label
                      key={row.id}
                      className={`flex items-start gap-2 p-2 border-b border-white/10 last:border-b-0 cursor-pointer ${
                        checked ? "bg-white/10" : "bg-transparent hover:bg-white/5"
                      }`}
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={checked}
                        onChange={e =>
                          setSelectedLockerIds(prev =>
                            e.target.checked ? Array.from(new Set([...prev, row.id])) : prev.filter(id => id !== row.id)
                          )
                        }
                      />
                      {img ? (
                        <img src={img} alt={row.name} className="h-10 w-14 object-cover rounded border border-white/20 shrink-0" />
                      ) : (
                        <div className="h-10 w-14 rounded border border-dashed border-white/20 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <div className="text-sm font-medium truncate">{row.name}</div>
                        <div className="text-[11px] text-gray-400">
                          {new Date(String(row.updatedAt ?? row.createdAt ?? "")).toLocaleString()}
                        </div>
                      </div>
                    </label>
                  );
                })}
                {!lockerCampaigns.length ? (
                  <div className="p-3 text-xs text-gray-400">No other campaigns yet.</div>
                ) : null}
              </div>
            </div>

            <label className="block text-xs text-gray-300">
              Prompt override
              <textarea
                className="mt-1 w-full border border-white/20 bg-[#0a1020] rounded px-2.5 py-2 text-sm min-h-[110px]"
                value={customPrompt}
                onChange={e => setCustomPrompt(e.target.value)}
              />
            </label>

            <label className="block text-xs text-gray-300">
              Description override
              <textarea
                className="mt-1 w-full border border-white/20 bg-[#0a1020] rounded px-2.5 py-2 text-sm min-h-[80px]"
                value={customDescription}
                onChange={e => setCustomDescription(e.target.value)}
              />
            </label>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-gray-300">Extra references</div>
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-[#f28c28] text-[#111] text-xs font-semibold"
                disabled={uploadBusy === "refs"}
                onClick={() => refsInputRef.current?.click()}
              >
                {uploadBusy === "refs" ? "Uploading..." : "Upload reference images"}
              </button>
              <input
                ref={refsInputRef}
                className="hidden"
                type="file"
                accept="image/*"
                multiple
                onChange={async e => {
                  const el = e.currentTarget;
                  await handleUpload("refs", el.files);
                  el.value = "";
                }}
              />
              <textarea
                className="w-full border border-white/20 bg-[#0a1020] rounded px-2.5 py-2 text-xs min-h-[70px]"
                placeholder="Reference image URLs (one per line)"
                value={referenceImageUrlsText}
                onChange={e => setReferenceImageUrlsText(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <div className="text-xs font-semibold text-gray-300">Extra brief files</div>
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-[#f28c28] text-[#111] text-xs font-semibold"
                disabled={uploadBusy === "briefs"}
                onClick={() => briefsInputRef.current?.click()}
              >
                {uploadBusy === "briefs" ? "Uploading..." : "Upload briefs"}
              </button>
              <input
                ref={briefsInputRef}
                className="hidden"
                type="file"
                accept=".pdf,.txt,.md,.csv,.json,.html,.doc,.docx,application/pdf,text/plain,text/markdown,text/csv,application/json,text/html,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                multiple
                onChange={async e => {
                  const el = e.currentTarget;
                  await handleUpload("briefs", el.files);
                  el.value = "";
                }}
              />
              <textarea
                className="w-full border border-white/20 bg-[#0a1020] rounded px-2.5 py-2 text-xs min-h-[70px]"
                placeholder="Brief file URLs (one per line)"
                value={briefDocumentUrlsText}
                onChange={e => setBriefDocumentUrlsText(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                className="px-3 py-2 rounded bg-[#f28c28] text-[#111] text-sm font-semibold disabled:opacity-50"
                onClick={() => void generateEmail()}
                disabled={generating || !selectedCampaignId}
              >
                {generating ? "Generating..." : "Generate Email"}
              </button>
              <button
                className="px-3 py-2 rounded border border-white/25 text-sm disabled:opacity-50 hover:bg-white/10"
                onClick={() => void saveEmail()}
                disabled={saving || !selectedCampaignId}
              >
                {saving ? "Saving..." : "Save Email"}
              </button>
            </div>
          </aside>

          <section className="border border-white/15 rounded-xl bg-[#0b1220] p-3 space-y-3">
            <div className="text-xs text-gray-400">
              Context campaigns:{" "}
              {contextPreview.length
                ? contextPreview.map((row, idx) => (
                    <span key={`ctx-${row.id}`}>
                      {idx ? ", " : ""}
                      {row.name}
                    </span>
                  ))
                : "none"}
            </div>

            <div className="border border-white/20 rounded bg-white min-h-[420px] overflow-hidden">
              <div className="px-3 py-2 text-xs font-semibold text-slate-700 border-b">Email HTML preview</div>
              <iframe
                title="Email HTML preview"
                className="w-full h-[660px] bg-white"
                srcDoc={previewHtmlDoc}
                sandbox="allow-same-origin"
              />
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                className="px-3 py-2 rounded border border-white/25 text-sm hover:bg-white/10"
                onClick={openPreview}
              >
                Open Preview
              </button>
              <button
                className="px-3 py-2 rounded border border-white/25 text-sm hover:bg-white/10"
                onClick={downloadHtml}
              >
                Download HTML
              </button>
            </div>

            <div className="border border-white/20 rounded p-3 bg-[#0a1020] space-y-3">
              <div className="text-xs font-semibold text-gray-200">Send Email</div>
              <label className="block text-xs text-gray-300">
                Recipient email
                <div className="mt-1 flex flex-wrap gap-2">
                  <input
                    className="flex-1 min-w-[260px] border border-white/20 bg-[#070c17] rounded px-2.5 py-2 text-sm"
                    placeholder="customer@example.com"
                    value={sendTo}
                    onChange={e => setSendTo(e.target.value)}
                  />
                  <button
                    className="px-3 py-2 rounded bg-[#f28c28] text-[#111] text-sm font-semibold disabled:opacity-50"
                    disabled={sending !== "" || !selectedCampaignId}
                    onClick={() => void sendEmailNow("live")}
                  >
                    {sending === "live" ? "Sending..." : "Send Email"}
                  </button>
                </div>
              </label>
              <label className="block text-xs text-gray-300">
                Test email
                <div className="mt-1 flex flex-wrap gap-2">
                  <input
                    className="flex-1 min-w-[260px] border border-white/20 bg-[#070c17] rounded px-2.5 py-2 text-sm"
                    placeholder="you@example.com"
                    value={testTo}
                    onChange={e => setTestTo(e.target.value)}
                  />
                  <button
                    className="px-3 py-2 rounded border border-white/25 text-sm hover:bg-white/10 disabled:opacity-50"
                    disabled={sending !== "" || !selectedCampaignId}
                    onClick={() => void sendEmailNow("test")}
                  >
                    {sending === "test" ? "Sending..." : "Send Test"}
                  </button>
                </div>
                <div className="mt-1 text-[11px] text-gray-400">
                  Test sends use the same HTML and text from this editor and prefix subject with <span className="font-mono">[TEST]</span>.
                </div>
              </label>
            </div>

            <label className="block text-xs text-gray-300">
              Email subject
              <input
                className="mt-1 w-full border border-white/20 bg-[#0a1020] rounded px-2.5 py-2 text-sm"
                value={subject}
                onChange={e => setSubject(e.target.value)}
              />
            </label>

            <label className="block text-xs text-gray-300">
              Email draft (text)
              <textarea
                className="mt-1 w-full border border-white/20 bg-[#0a1020] rounded px-2.5 py-2 text-sm min-h-[120px]"
                value={emailText}
                onChange={e => setEmailText(e.target.value)}
              />
            </label>

            <details className="border border-white/20 rounded p-3 bg-[#0a1020]">
              <summary className="text-xs font-semibold text-gray-200 cursor-pointer">Advanced HTML</summary>
              <textarea
                className="mt-2 w-full border border-white/20 bg-[#070c17] rounded px-2.5 py-2 text-xs font-mono min-h-[180px]"
                value={emailHtml}
                onChange={e => setEmailHtml(e.target.value)}
              />
            </details>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {contextPreview.map((row, idx) => {
                const img = campaignPrimaryImage(row);
                return (
                  <div key={`ctx-preview-${row.id}`} className="border border-white/15 rounded p-2 bg-[#0a1020]">
                    <div className="text-xs font-semibold text-gray-100">{row.name || `Campaign ${idx + 1}`}</div>
                    {img ? (
                      <a href={img} target="_blank" rel="noreferrer" className="block mt-2">
                        <img src={img} alt={row.name} className="w-full h-[120px] object-contain bg-white rounded" />
                      </a>
                    ) : (
                      <div className="mt-2 text-[11px] text-gray-400">No primary image found.</div>
                    )}
                    <div className="mt-2 text-[11px] text-gray-400">
                      Prompt: {String(row.prompt ?? "").trim().slice(0, 120) || "—"}
                    </div>
                    {Array.isArray(row.briefDocumentUrls) && row.briefDocumentUrls.length ? (
                      <div className="mt-1 text-[11px] text-gray-400">
                        Briefs:{" "}
                        {row.briefDocumentUrls.slice(0, 2).map((url, i) => (
                          <span key={`brief-${row.id}-${i}`}>
                            {i ? ", " : ""}
                            {fileLabelFromUrl(String(url ?? ""), `brief-${i + 1}`)}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
