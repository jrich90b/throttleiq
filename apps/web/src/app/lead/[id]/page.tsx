"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

type LeadVehicle = {
  stockId?: string;
  vin?: string;
  year?: string;
  model?: string;
  color?: string;
  condition?: string;
  description?: string;
};

type LeadProfile = {
  leadRef?: string;
  source?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  street?: string;
  city?: string;
  region?: string;
  postal?: string;
  purchaseTimeframe?: string;
  hasMotoLicense?: boolean;
  vehicle?: LeadVehicle;
  inquiry?: string;
};

type Conversation = {
  id: string;
  leadKey: string;
  lead?: LeadProfile;
  lastInbound?: { body?: string };
};

export default function LeadDetailsPage() {
  const params = useParams<{ id: string }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<string | null>(null);
  const [conv, setConv] = useState<Conversation | null>(null);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        setLoading(true);
        setError(null);
        const rawId = decodeURIComponent(String(params?.id ?? ""));
        if (!rawId) {
          setError("Missing lead id");
          setDebugInfo("id missing in route params");
          setLoading(false);
          return;
        }
        const apiPath = `/api/conversations/${encodeURIComponent(rawId)}`;
        const r = await fetch(apiPath, { cache: "no-store" });
        const text = await r.text();
        const data = JSON.parse(text);
        if (!active) return;
        if (!r.ok) {
          setError(data?.error ?? "Failed to load lead");
          setDebugInfo(`id=${rawId} path=${apiPath} status=${r.status} body=${text.slice(0, 500)}`);
          return;
        }
        setConv(data?.conversation ?? null);
      } catch (e: any) {
        if (!active) return;
        setError(e?.message ?? "Failed to load lead");
        setDebugInfo(`exception=${e?.message ?? e}`);
      } finally {
        if (active) setLoading(false);
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [params.id]);

  const lead = conv?.lead ?? {};
  const leadName = useMemo(() => {
    const raw = lead?.name?.trim() ?? "";
    const first = lead?.firstName ?? "";
    const last = lead?.lastName ?? "";
    return raw || [first, last].filter(Boolean).join(" ").trim() || conv?.leadKey || "Lead";
  }, [lead?.name, lead?.firstName, lead?.lastName, conv?.leadKey]);

  const inquiryText = lead?.inquiry ?? "";
  const vehicle = lead?.vehicle ?? {};

  return (
    <div className="min-h-screen bg-gray-50 text-gray-900">
      <div className="max-w-3xl mx-auto px-6 py-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-gray-500">Lead</div>
            <div className="text-2xl font-semibold">{leadName}</div>
            <div className="text-xs text-gray-500 mt-1">{conv?.leadKey ?? ""}</div>
          </div>
        </div>

        {loading ? <div className="mt-6 text-gray-500">Loading…</div> : null}
        {error ? <div className="mt-6 text-red-600 text-sm">{error}</div> : null}
        {debugInfo ? (
          <div className="mt-2 text-xs text-gray-500 break-words">Debug: {debugInfo}</div>
        ) : null}

        {!loading && !error ? (
          <div className="mt-6 space-y-6">
            <div className="border rounded-lg bg-white p-4">
              <div className="text-sm font-medium text-gray-800">Contact</div>
              <div className="mt-2 space-y-1 text-sm text-gray-700">
                <div>Email: {lead?.email ?? "—"}</div>
                <div>Phone: {lead?.phone ?? "—"}</div>
                <div>Street: {lead?.street ?? "—"}</div>
                <div>
                  City/State/ZIP:{" "}
                  {[lead?.city, lead?.region, lead?.postal].filter(Boolean).join(", ") || "—"}
                </div>
              </div>
            </div>

            <div className="border rounded-lg bg-white p-4">
              <div className="text-sm font-medium text-gray-800">Lead Info</div>
              <div className="mt-2 space-y-1 text-sm text-gray-700">
                <div>Source: {lead?.source ?? "—"}</div>
                <div>Lead Ref: {lead?.leadRef ?? "—"}</div>
                <div>Purchase Timeframe: {lead?.purchaseTimeframe ?? "—"}</div>
                <div>Motorcycle License: {lead?.hasMotoLicense == null ? "—" : lead?.hasMotoLicense ? "Yes" : "No"}</div>
              </div>
            </div>

            <div className="border rounded-lg bg-white p-4">
              <div className="text-sm font-medium text-gray-800">Vehicle</div>
              <div className="mt-2 space-y-1 text-sm text-gray-700">
                <div>Year: {vehicle.year ?? "—"}</div>
                <div>Model: {vehicle.model ?? vehicle.description ?? "—"}</div>
                <div>Color: {vehicle.color ?? "—"}</div>
                <div>Stock: {vehicle.stockId ?? "—"}</div>
                <div>VIN: {vehicle.vin ?? "—"}</div>
                <div>Condition: {vehicle.condition ?? "—"}</div>
              </div>
            </div>

            {inquiryText ? (
              <div className="border rounded-lg bg-white p-4">
                <div className="text-sm font-medium text-gray-800">Inquiry</div>
                <div className="mt-2 text-sm text-gray-700 whitespace-pre-wrap">{inquiryText}</div>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
