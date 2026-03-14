"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useSearchParams } from "next/navigation";

type Slot = {
  start: string;
  end: string;
  startLocal: string;
  endLocal: string;
};

function dayKeyFromIso(iso: string, tz: string) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    return fmt.format(new Date(iso));
  } catch {
    return new Date(iso).toISOString().slice(0, 10);
  }
}

function dayKeyFromParts(year: number, monthIndex: number, day: number, tz: string) {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    });
    const d = new Date(year, monthIndex, day, 12, 0, 0);
    return fmt.format(d);
  } catch {
    const d = new Date(year, monthIndex, day);
    return d.toISOString().slice(0, 10);
  }
}

function BookingPageInner() {
  const params = useSearchParams();
  const token = params.get("token") ?? "";
  const leadKey = params.get("leadKey") ?? "";

  const [config, setConfig] = useState<any>(null);
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [appointmentType, setAppointmentType] = useState("inventory_visit");
  const [preferredType, setPreferredType] = useState<string | null>(null);
  const [lockedType, setLockedType] = useState<string | null>(null);
  const [selectedSlot, setSelectedSlot] = useState<Slot | null>(null);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [monthCursor, setMonthCursor] = useState<Date>(() => new Date());
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<any>(null);
  const [form, setForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    notes: ""
  });

  useEffect(() => {
    if (!token) {
      setLoadingConfig(false);
      setError("Missing booking token.");
      return;
    }
    void (async () => {
      setLoadingConfig(true);
      setError(null);
      try {
        const resp = await fetch(`/api/booking/config?token=${encodeURIComponent(token)}`, {
          cache: "no-store"
        });
        const json = await resp.json();
        if (!resp.ok) {
          throw new Error(json?.error ?? "Failed to load booking config");
        }
        setConfig(json);
        const firstType = json?.appointmentTypes?.[0] ?? "inventory_visit";
        const pref =
          preferredType && json?.appointmentTypes?.includes(preferredType)
            ? preferredType
            : firstType;
        setAppointmentType(pref);
      } catch (err: any) {
        setError(err?.message ?? "Failed to load booking config");
      } finally {
        setLoadingConfig(false);
      }
    })();
  }, [token, preferredType]);

  useEffect(() => {
    if (!token) return;
    const firstName = params.get("firstName") ?? "";
    const lastName = params.get("lastName") ?? "";
    const email = params.get("email") ?? "";
    const phone = params.get("phone") ?? "";
    const type = params.get("type");
    if (type) setPreferredType(type);
    setForm(prev => ({
      ...prev,
      firstName: prev.firstName || firstName,
      lastName: prev.lastName || lastName,
      email: prev.email || email,
      phone: prev.phone || phone
    }));
  }, [params, token]);

  useEffect(() => {
    if (!token || !leadKey) return;
    void (async () => {
      try {
        const resp = await fetch(
          `/api/booking/prefill?token=${encodeURIComponent(token)}&leadKey=${encodeURIComponent(leadKey)}`,
          { cache: "no-store" }
        );
        const json = await resp.json();
        if (!resp.ok) return;
        const lead = json?.lead ?? null;
        if (!lead) return;
        setForm(prev => ({
          ...prev,
          firstName: prev.firstName || lead.firstName || "",
          lastName: prev.lastName || lead.lastName || "",
          email: prev.email || lead.email || "",
          phone: prev.phone || lead.phone || ""
        }));
        if (lead.appointmentType) {
          setLockedType(lead.appointmentType);
          setPreferredType(lead.appointmentType);
        }
      } catch {
        // ignore
      }
    })();
  }, [token, leadKey]);

  useEffect(() => {
    if (!token || !appointmentType) return;
    void (async () => {
      setLoadingSlots(true);
      setError(null);
      try {
        const qs = new URLSearchParams({
          token,
          type: appointmentType,
          daysAhead: "14",
          perSalesperson: "6"
        });
        const resp = await fetch(`/api/booking/availability?${qs.toString()}`, {
          cache: "no-store"
        });
        const json = await resp.json();
        if (!resp.ok) {
          throw new Error(json?.error ?? "Failed to load availability");
        }
        setSlots(json?.slots ?? []);
      } catch (err: any) {
        setError(err?.message ?? "Failed to load availability");
      } finally {
        setLoadingSlots(false);
      }
    })();
  }, [token, appointmentType]);

  const dealerName = config?.dealer?.dealerName ?? "Dealer";
  const tz = config?.timezone ?? "America/New_York";
  const appointmentTypes = config?.appointmentTypes ?? ["inventory_visit"];
  const showTypeSelect = !lockedType && !preferredType;

  const slotsByDay = useMemo(() => {
    const map = new Map<string, Slot[]>();
    for (const slot of slots) {
      const key = dayKeyFromIso(slot.start, tz);
      const existing = map.get(key);
      if (existing) {
        existing.push(slot);
      } else {
        map.set(key, [slot]);
      }
    }
    return map;
  }, [slots, tz]);

  const availableDays = useMemo(() => Array.from(slotsByDay.keys()).sort(), [slotsByDay]);

  useEffect(() => {
    if (!availableDays.length) return;
    if (!selectedDay) {
      setSelectedDay(availableDays[0]);
      const first = new Date(`${availableDays[0]}T12:00:00`);
      if (!Number.isNaN(first.getTime())) setMonthCursor(first);
    }
  }, [availableDays, selectedDay]);

  useEffect(() => {
    if (!availableDays.length || !selectedDay) return;
    if (!availableDays.includes(selectedDay)) {
      setSelectedDay(availableDays[0]);
      const first = new Date(`${availableDays[0]}T12:00:00`);
      if (!Number.isNaN(first.getTime())) setMonthCursor(first);
    }
  }, [availableDays, selectedDay]);

  const visibleSlots = useMemo(() => {
    if (!selectedDay) return [];
    return slotsByDay.get(selectedDay) ?? [];
  }, [slotsByDay, selectedDay]);

  const canSubmit = useMemo(() => {
    if (!selectedSlot) return false;
    if (!form.firstName.trim() && !form.lastName.trim()) return false;
    if (!form.email.trim() && !form.phone.trim()) return false;
    return true;
  }, [selectedSlot, form]);

  async function submitBooking() {
    if (!selectedSlot) return;
    setError(null);
    const leadName = [form.firstName, form.lastName].filter(Boolean).join(" ").trim();
    try {
      const resp = await fetch("/api/booking/book", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          appointmentType,
          slot: selectedSlot,
          lead: {
            name: leadName,
            firstName: form.firstName.trim(),
            lastName: form.lastName.trim(),
            email: form.email.trim(),
            phone: form.phone.trim(),
            notes: form.notes.trim()
          }
        })
      });
      const json = await resp.json();
      if (!resp.ok) throw new Error(json?.error ?? "Booking failed");
      setSuccess(json);
    } catch (err: any) {
      setError(err?.message ?? "Booking failed");
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
      <div className="w-full max-w-2xl bg-white border rounded-lg shadow-sm p-6">
        <div className="text-xl font-semibold mb-1">{dealerName}</div>
        <div className="text-sm text-gray-600 mb-6">Book a time to stop in (timezone: {tz}).</div>

        {loadingConfig ? (
          <div className="text-sm text-gray-600">Loading booking info…</div>
        ) : error ? (
          <div className="text-sm text-red-600">{error}</div>
        ) : success ? (
          <div className="space-y-3">
            <div className="text-lg font-semibold">You’re booked.</div>
            <div className="text-sm text-gray-700">
              We’ll see you at {success.whenText ?? selectedSlot?.startLocal}.
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {showTypeSelect ? (
              <div>
                <label className="text-sm font-medium block mb-2">Appointment type</label>
                <select
                  className="border rounded px-3 py-2 text-sm w-full"
                  value={appointmentType}
                  onChange={e => setAppointmentType(e.target.value)}
                >
                  {appointmentTypes.map((t: string) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            <div>
              <div className="text-sm font-medium mb-2">Choose a day</div>
              {loadingSlots ? (
                <div className="text-sm text-gray-600">Loading availability…</div>
              ) : slots.length === 0 ? (
                <div className="text-sm text-gray-600">No times available right now.</div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <button
                      className="text-sm border rounded px-2 py-1"
                      onClick={() =>
                        setMonthCursor(prev => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))
                      }
                    >
                      Prev
                    </button>
                    <div className="text-sm font-medium">
                      {monthCursor.toLocaleString("en-US", {
                        month: "long",
                        year: "numeric"
                      })}
                    </div>
                    <button
                      className="text-sm border rounded px-2 py-1"
                      onClick={() =>
                        setMonthCursor(prev => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))
                      }
                    >
                      Next
                    </button>
                  </div>
                  <div className="grid grid-cols-7 gap-1 text-xs text-gray-500">
                    {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map(d => (
                      <div key={d} className="text-center">
                        {d}
                      </div>
                    ))}
                  </div>
                  <div className="grid grid-cols-7 gap-1">
                    {(() => {
                      const year = monthCursor.getFullYear();
                      const month = monthCursor.getMonth();
                      const first = new Date(year, month, 1);
                      const startDay = first.getDay();
                      const daysInMonth = new Date(year, month + 1, 0).getDate();
                      const cells: ReactNode[] = [];
                      for (let i = 0; i < startDay; i++) {
                        cells.push(<div key={`empty-${i}`} />);
                      }
                      for (let day = 1; day <= daysInMonth; day++) {
                        const key = dayKeyFromParts(year, month, day, tz);
                        const hasSlots = slotsByDay.has(key);
                        const isSelected = selectedDay === key;
                        cells.push(
                          <button
                            key={key}
                            className={`text-sm border rounded p-2 text-center ${
                              hasSlots ? "hover:border-blue-500" : "opacity-40 cursor-not-allowed"
                            } ${isSelected ? "border-blue-600 bg-blue-50" : ""}`}
                            disabled={!hasSlots}
                            onClick={() => {
                              setSelectedDay(key);
                              setSelectedSlot(null);
                            }}
                          >
                            {day}
                          </button>
                        );
                      }
                      return cells;
                    })()}
                  </div>
                </div>
              )}
            </div>

            <div>
              <div className="text-sm font-medium mb-2">Available times</div>
              {loadingSlots ? (
                <div className="text-sm text-gray-600">Loading availability…</div>
              ) : !selectedDay ? (
                <div className="text-sm text-gray-600">Select a day to see times.</div>
              ) : visibleSlots.length === 0 ? (
                <div className="text-sm text-gray-600">No times available for that day.</div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {visibleSlots.map(slot => (
                    <button
                      key={`${slot.start}-${slot.end}`}
                      className={`border rounded px-3 py-2 text-left text-sm hover:border-blue-500 ${
                        selectedSlot?.start === slot.start ? "border-blue-600 bg-blue-50" : ""
                      }`}
                      onClick={() => setSelectedSlot(slot)}
                    >
                      <div className="font-medium">{slot.startLocal}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                className="border rounded px-3 py-2 text-sm"
                placeholder="First name"
                value={form.firstName}
                onChange={e => setForm({ ...form, firstName: e.target.value })}
              />
              <input
                className="border rounded px-3 py-2 text-sm"
                placeholder="Last name"
                value={form.lastName}
                onChange={e => setForm({ ...form, lastName: e.target.value })}
              />
              <input
                className="border rounded px-3 py-2 text-sm"
                placeholder="Email"
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
              />
              <input
                className="border rounded px-3 py-2 text-sm"
                placeholder="Phone"
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
              />
            </div>
            <textarea
              className="border rounded px-3 py-2 text-sm w-full min-h-[80px]"
              placeholder="Notes (optional)"
              value={form.notes}
              onChange={e => setForm({ ...form, notes: e.target.value })}
            />

            <div className="flex items-center justify-between">
              <div className="text-xs text-gray-500">
                Please select a time and provide your contact details.
              </div>
              <button
                className="px-4 py-2 rounded bg-blue-600 text-white text-sm disabled:bg-gray-300"
                disabled={!canSubmit}
                onClick={submitBooking}
              >
                Book appointment
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function BookingPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-gray-50 flex items-center justify-center p-6">
          <div className="w-full max-w-2xl bg-white border rounded-lg shadow-sm p-6">
            <div className="text-sm text-gray-600">Loading booking page…</div>
          </div>
        </div>
      }
    >
      <BookingPageInner />
    </Suspense>
  );
}
