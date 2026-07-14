import React from "react";
import { SideNavIcon } from "./UiIcon";
import type { SideNavIconName } from "./UiIcon";
import {
  dueBucketLabel,
  relativeDueLabel,
  taskEffectiveDueMs
} from "../lib/taskTriage";
import type { DueBucket } from "../lib/taskTriage";
import { salesCriticalKind, SALES_REASON_META } from "../lib/taskReason";
import { digestAttentionCount, groupTasksForDigest } from "../lib/morningDigest";

// Morning digest — a once-a-day "here's your day" popup (Joe, 2026-07-14).
// Each salesperson sees THEIR open tasks (the /todos payload is already
// owner-scoped server-side) grouped by urgency, and can call or message the
// customer right from the row. There is deliberately NO "mark all done":
// completion is detected by the task-fulfillment auto-close engine — do the
// task (call/text from anywhere in the console) and it closes itself.
//
// Contrast: this is a LIGHT ISLAND on the dark shell — `lr-light-modal`
// re-declares the alias vars (AGENTS.md UI Contrast Guardrail), and everything
// inside paints its own light-surface colors.

const BUCKET_ICON: Record<DueBucket, SideNavIconName> = {
  overdue: "bolt",
  today: "clock",
  this_week: "calendar",
  later: "calendar",
  no_date: "bell"
};

const BUCKET_HEADER_CLASS: Record<DueBucket, string> = {
  overdue: "text-red-700 bg-red-50 border-red-200",
  today: "text-amber-800 bg-amber-50 border-amber-200",
  this_week: "text-slate-700 bg-slate-50 border-slate-200",
  later: "text-slate-600 bg-slate-50 border-slate-200",
  no_date: "text-slate-600 bg-slate-50 border-slate-200"
};

function displayCaseName(raw: string): string {
  const name = String(raw ?? "").trim();
  if (!name) return name;
  if (name !== name.toUpperCase() && name !== name.toLowerCase()) return name;
  return name
    .split(/\s+/)
    .map(word => (word ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word))
    .join(" ");
}

export function MorningDigestModal(props: {
  open: boolean;
  onClose: () => void;
  todos: any[];
  conversationsById: Map<string, any>;
  authUser: any;
  todoActionLabel: (todo: any) => string;
  onCall: (todo: any) => void;
  onMessage: (todo: any) => void;
  onOpenTaskInbox: () => void;
}) {
  const { open, onClose, todos, conversationsById, authUser, todoActionLabel, onCall, onMessage, onOpenTaskInbox } =
    props;
  const nowMs = Date.now();
  if (!open) return null;

  const groups = groupTasksForDigest(todos, nowMs);
  const attention = digestAttentionCount(todos, nowMs);
  const firstName = String(authUser?.name ?? "").trim().split(/\s+/)[0] || "there";
  const dateLabel = new Date(nowMs).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-3">
      <div className="lr-app-modal lr-light-modal w-full max-w-2xl max-h-[92vh] overflow-y-auto rounded-lg bg-white text-slate-900 shadow-xl">
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-semibold text-slate-900">Good morning, {firstName}</div>
              <div className="mt-0.5 text-sm text-slate-600">{dateLabel}</div>
            </div>
            <button
              type="button"
              className="rounded p-1.5 text-slate-500 hover:bg-slate-100 hover:text-slate-800"
              onClick={onClose}
              title="Dismiss for today"
            >
              <SideNavIcon name="close" className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-700">
              <SideNavIcon name="todos" className="h-3.5 w-3.5" />
              {todos.length} open task{todos.length === 1 ? "" : "s"}
            </span>
            {attention > 0 ? (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 font-semibold text-red-700">
                <SideNavIcon name="bolt" className="h-3.5 w-3.5" />
                {attention} need{attention === 1 ? "s" : ""} you today
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 font-medium text-emerald-700">
                <SideNavIcon name="check" className="h-3.5 w-3.5" />
                Nothing overdue
              </span>
            )}
          </div>
          <div className="mt-2 flex items-start gap-1.5 text-xs text-slate-500">
            <span aria-hidden className="mt-0.5 inline-flex shrink-0">
              <SideNavIcon name="bolt" className="h-3.5 w-3.5" />
            </span>
            <span>
              Tasks close themselves when you&apos;ve done them — call or text the customer (from here or
              anywhere) and the agent marks it complete. No need to check anything off.
            </span>
          </div>
        </div>

        <div className="space-y-4 px-5 py-4">
          {groups.map(group => (
            <div key={group.bucket}>
              <div
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-semibold uppercase tracking-wide ${BUCKET_HEADER_CLASS[group.bucket]}`}
              >
                <SideNavIcon name={BUCKET_ICON[group.bucket]} className="h-3.5 w-3.5" />
                {dueBucketLabel(group.bucket)}
                <span className="font-normal">· {group.tasks.length}</span>
              </div>
              <div className="mt-2 space-y-2">
                {group.tasks.map((t: any) => {
                  const conv = conversationsById.get(t.convId);
                  const vehicleLine = String(conv?.vehicleDescription ?? "").trim();
                  const salesKind = salesCriticalKind(t);
                  const reasonMeta = salesKind ? SALES_REASON_META[salesKind] : null;
                  const dueMs = taskEffectiveDueMs(t);
                  const dueLabel = dueMs != null ? relativeDueLabel(dueMs, nowMs) : null;
                  const isUrgent = group.bucket === "overdue" || group.bucket === "today";
                  return (
                    <div
                      key={t.id}
                      className={`rounded-lg border p-3 ${
                        group.bucket === "overdue"
                          ? "border-red-200 bg-red-50/50"
                          : group.bucket === "today"
                            ? "border-amber-200 bg-amber-50/40"
                            : "border-slate-200 bg-white"
                      }`}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-semibold text-slate-900">
                            {displayCaseName(t.leadName || "") || t.leadKey}
                          </div>
                          {vehicleLine ? (
                            <div className="truncate text-xs text-slate-600">{vehicleLine}</div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          {reasonMeta ? (
                            <span className="inline-flex items-center gap-1 rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-[11px] font-semibold text-orange-700">
                              <SideNavIcon name={reasonMeta.icon as SideNavIconName} className="h-3 w-3" />
                              {reasonMeta.label}
                            </span>
                          ) : null}
                          {dueLabel && isUrgent ? (
                            <span
                              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold ${
                                group.bucket === "overdue"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-amber-100 text-amber-800"
                              }`}
                            >
                              <SideNavIcon name="clock" className="h-3 w-3" />
                              {group.bucket === "overdue" ? `Overdue · ${dueLabel}` : dueLabel}
                            </span>
                          ) : null}
                        </div>
                      </div>
                      <div className="mt-1.5 text-sm text-slate-700">{todoActionLabel(t)}</div>
                      <div className="mt-2 flex items-center justify-end gap-2">
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-800 hover:bg-slate-50"
                          onClick={() => onMessage(t)}
                          title="Open the conversation and text this customer"
                        >
                          <SideNavIcon name="chat" className="h-3.5 w-3.5" />
                          Message
                        </button>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1.5 rounded bg-[var(--accent)] px-2.5 py-1.5 text-xs font-semibold text-[var(--accent-contrast)] hover:opacity-90"
                          onClick={() => onCall(t)}
                          title="Call this customer"
                        >
                          <SideNavIcon name="phone" className="h-3.5 w-3.5" />
                          Call
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
          {groups.length === 0 ? (
            <div className="py-6 text-center text-sm text-slate-600">No open tasks — you&apos;re all set.</div>
          ) : null}
        </div>

        <div className="sticky bottom-0 flex items-center justify-between gap-2 border-t border-slate-200 bg-white px-5 py-3">
          <button
            type="button"
            className="inline-flex items-center gap-1.5 rounded border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-50"
            onClick={onOpenTaskInbox}
          >
            <SideNavIcon name="todos" className="h-4 w-4" />
            Open Task Inbox
          </button>
          <button
            type="button"
            className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-semibold text-[var(--accent-contrast)] hover:opacity-90"
            onClick={onClose}
          >
            Got it — let&apos;s go
          </button>
        </div>
      </div>
    </div>
  );
}
