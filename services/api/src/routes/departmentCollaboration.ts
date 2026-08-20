/**
 * "Bring in a department" endpoints — the INVITE, as opposed to `POST /conversations/:id/department`
 * in index.ts, which is a HANDOFF. Lives here (not index.ts) per the source-size ratchet.
 *
 * WHY (Joe, 2026-08-20). Christopher Szczesny (+17169400722) bought a Road Glide from Scott on 8/14
 * and on 8/19 asked the SAME thread for taillights — a Parts question on a Sales lead. The only
 * button we had would have re-labelled his sold sales lead as a parts lead, stopped the agent, and
 * (because `addTodo` drops every non-"call" task on a post_sale lead) filed no task at all. Scott
 * typed "Ill have parts get a hold of you" by hand, 23 hours later.
 *
 * So an invite deliberately does NOT: touch `conv.classification`, touch `conv.leadOwner`, or call
 * `setFollowUpMode` / `stopFollowUpCadence` / `stopRelatedCadences`. Those three omissions ARE the
 * feature and are pinned by `bring_in_department:eval` — switching the agent off is what produced
 * 16.5 hours of silence on this same lead's other thread (`+17169400722::2`), and the stale-handoff
 * sweep that would catch a parked department thread is not on a schedule today.
 *
 * Semantics + fail-direction notes: `domain/departmentCollaboration.ts`.
 */
import type { Express, Request, RequestHandler, Response } from "express";
import {
  addTodo,
  setFollowUpMode,
  stopFollowUpCadence,
  getConversation,
  listOpenTodos,
  markTodoDone,
  saveConversation
} from "../domain/conversationStore.js";
import { listUsers } from "../domain/userStore.js";
import {
  bringInDepartment,
  handBackDepartment,
  isCollaboratorDepartment,
  recordDepartmentNotification,
  type CollaboratorDepartment
} from "../domain/departmentCollaboration.js";

/** Cap on how many people in one department get the invite text, so a big department isn't blasted. */
const DEPARTMENT_INVITE_NOTIFY_LIMIT = 3;

export type DepartmentCollaborationDeps = {
  /** Narrowed to the one permission these routes gate on, matching the handoff endpoint they sit beside. */
  requirePermission: (permission: "canAccessTodos") => RequestHandler;
  canUserAccessConversation: (user: any, conv: any) => boolean;
  recordRouteOutcome: (scope: "live" | "regen" | "manual", outcome: string, detail?: Record<string, unknown>) => void;
  sendInternalSms: (toNumber: string, body: string) => Promise<boolean>;
  pickUserSmsPhone: (user: any) => string;
  normalizePhone: (raw: string) => string;
  // Handoff-only helpers that still live in index.ts. Their narrow string-union parameters
  // (DialogStateName, the cadence setMode union, the campaign pass-target union) are typed `any`
  // here so the module does not have to re-import index.ts's internal unions just to be called.
  getDialogState: (conv: any) => string;
  setDialogState: (conv: any, state: any) => void;
  stopRelatedCadences: (conv: any, reason: string, opts?: any) => void;
  maybeMarkCampaignThreadPassed: (conv: any, target: any) => void;
};

function resolveConversation(req: Request, res: Response, deps: DepartmentCollaborationDeps) {
  const conv = getConversation(req.params.id);
  if (!conv) {
    res.status(404).json({ ok: false, error: "Not found" });
    return null;
  }
  const user = (req as any).user ?? null;
  if (!deps.canUserAccessConversation(user, conv)) {
    res.status(403).json({ ok: false, error: "forbidden" });
    return null;
  }
  return { conv, user };
}

function readDepartment(req: Request, res: Response): CollaboratorDepartment | null {
  const raw = String(req.body?.department ?? "").trim().toLowerCase();
  if (!isCollaboratorDepartment(raw)) {
    res.status(400).json({ ok: false, error: "Invalid department" });
    return null;
  }
  return raw as CollaboratorDepartment;
}

export function registerDepartmentCollaborationRoutes(app: Express, deps: DepartmentCollaborationDeps) {
  /**
   * THE HANDOFF (pre-existing, moved here 2026-08-20 so all three department endpoints sit together).
   * Unlike the invite below, this says "this is really a <department> lead": it rewrites
   * classification, and it deliberately STOPS the agent (setFollowUpMode/stopFollowUpCadence).
   * Both behaviours are intentional here and are pinned by bring_in_department:eval as the contrast.
   */
  app.post("/conversations/:id/department", deps.requirePermission("canAccessTodos"), (req, res) => {
    const conv = getConversation(req.params.id);
    if (!conv) return res.status(404).json({ ok: false, error: "Not found" });
    const user = (req as any).user ?? null;
    if (!deps.canUserAccessConversation(user, conv)) {
      return res.status(403).json({ ok: false, error: "forbidden" });
    }

    const department = String(req.body?.department ?? "")
      .trim()
      .toLowerCase() as CollaboratorDepartment;
    if (!["service", "parts", "apparel"].includes(department)) {
      return res.status(400).json({ ok: false, error: "Invalid department" });
    }

    const summaryRaw = String(req.body?.summary ?? "").trim();
    const summary = summaryRaw || `${department} request`;

    const ownerIdRaw = String(req.body?.ownerId ?? "").trim();
    const ownerNameRaw = String(req.body?.ownerName ?? "").trim();
    if ((ownerIdRaw || ownerNameRaw) && user?.role !== "manager") {
      return res.status(403).json({ ok: false, error: "manager required to assign owner" });
    }
    const owner =
      ownerIdRaw || ownerNameRaw ? { id: ownerIdRaw || undefined, name: ownerNameRaw || undefined } : undefined;

    conv.classification = {
      ...(conv.classification ?? {}),
      bucket: department,
      cta: `${department}_request`
    };
    if (department === "service") {
      if (deps.getDialogState(conv) === "none") {
        deps.setDialogState(conv, "service_request");
      }
      deps.setDialogState(conv, "service_handoff");
    }

    const hasDepartmentTodo = listOpenTodos().some(t => t.convId === conv.id && t.reason === department);
    if (!hasDepartmentTodo) {
      addTodo(conv, department, summary, undefined, owner);
    }

    setFollowUpMode(conv, "manual_handoff", `${department}_request`);
    stopFollowUpCadence(conv, "manual_handoff");
    deps.stopRelatedCadences(conv, "manual_handoff", { setMode: "manual_handoff" });
    deps.maybeMarkCampaignThreadPassed(conv, department);
    saveConversation(conv);
    return res.json({ ok: true, conversation: conv });
  });

  app.post("/conversations/:id/bring-in-department", deps.requirePermission("canAccessTodos"), async (req, res) => {
    const resolved = resolveConversation(req, res, deps);
    if (!resolved) return;
    const { conv, user } = resolved;
    const department = readDepartment(req, res);
    if (!department) return;
    const note = String(req.body?.note ?? "").trim().slice(0, 400);

    const result = bringInDepartment((conv as any).departmentCollaborators, {
      department,
      invitedByUserId: String(user?.id ?? "").trim() || null,
      invitedByName: String(user?.name ?? user?.email ?? "").trim() || null,
      note,
      at: new Date().toISOString()
    });
    // Already in the thread AND already reached somebody: a true no-op. Never a second task, never a
    // duplicate text.
    if (!result.added && !result.shouldNotify) {
      deps.recordRouteOutcome("manual", "bring_in_department_already_active", { convId: conv.id, department });
      return res.json({ ok: true, added: false, retried: false, conversation: conv });
    }
    // Falling through with `added === false` is the RETRY path: the department is already in the
    // thread but the last attempt reached nobody, so the notification below is still owed. The
    // collaborator entry and the task are already there and are deliberately left alone.
    (conv as any).departmentCollaborators = result.collaborators;

    // The department's route in is this task. `allowSoldLead` is REQUIRED: addTodo drops every
    // non-"call" task on a sold/post_sale lead, which is exactly the thread this feature exists for.
    // An explicit human invite is unambiguous intent, sold or not.
    const summary = note || `${department} request`;
    if (!listOpenTodos().some(t => t.convId === conv.id && t.reason === department)) {
      addTodo(conv, department, summary, undefined, undefined, undefined, undefined, { allowSoldLead: true });
    }
    saveConversation(conv);

    // Notify the department directly. Internal staff SMS only — never a customer send.
    let notified = 0;
    try {
      const leadName = [conv?.lead?.firstName, conv?.lead?.lastName]
        .map(v => String(v ?? "").trim())
        .filter(Boolean)
        .join(" ");
      const invitedBy = String(user?.name ?? user?.email ?? "").trim();
      const body = [
        `${invitedBy || "A teammate"} brought ${department} into a conversation${leadName ? ` with ${leadName}` : ""}.`,
        note ? `Ask: ${note}` : "",
        "Open the console to reply on the thread."
      ]
        .filter(Boolean)
        .join(" ");
      const recipients = (await listUsers())
        .filter(u => String(u?.role ?? "").trim().toLowerCase() === department)
        .map(u => deps.normalizePhone(String(deps.pickUserSmsPhone(u) ?? "").trim()))
        .filter(Boolean)
        .slice(0, DEPARTMENT_INVITE_NOTIFY_LIMIT);
      for (const phone of recipients) {
        if (await deps.sendInternalSms(phone, body)) notified += 1;
      }
    } catch (err) {
      // A failed text must never fail the invite — the task is filed and the thread is already
      // shared, which is the part a second click cannot recover.
      console.warn("[bring-in-department] notify failed", err);
    }
    // Record what delivery ACHIEVED, so a `notified: 0` invite stays retryable and a delivered one
    // does not re-text. Persisted before the response so a crash cannot lose the fact.
    (conv as any).departmentCollaborators = recordDepartmentNotification((conv as any).departmentCollaborators, {
      department,
      notified,
      at: new Date().toISOString()
    });
    saveConversation(conv);
    deps.recordRouteOutcome("manual", result.added ? "bring_in_department" : "bring_in_department_notify_retry", {
      convId: conv.id,
      department,
      notified
    });
    return res.json({ ok: true, added: result.added, retried: !result.added, notified, conversation: conv });
  });

  /** Hand back to the lead owner — closes the department's open task and revokes their access. */
  app.post("/conversations/:id/hand-back-department", deps.requirePermission("canAccessTodos"), (req, res) => {
    const resolved = resolveConversation(req, res, deps);
    if (!resolved) return;
    const { conv, user } = resolved;
    const department = readDepartment(req, res);
    if (!department) return;

    const result = handBackDepartment((conv as any).departmentCollaborators, {
      department,
      handedBackByName: String(user?.name ?? user?.email ?? "").trim() || null,
      at: new Date().toISOString()
    });
    if (!result.handedBack) {
      return res.json({ ok: true, handedBack: false, conversation: conv });
    }
    (conv as any).departmentCollaborators = result.collaborators;
    let closedTodos = 0;
    for (const todo of listOpenTodos()) {
      if (todo.convId !== conv.id || todo.reason !== department) continue;
      if (markTodoDone(conv.id, todo.id)) closedTodos += 1;
    }
    saveConversation(conv);
    deps.recordRouteOutcome("manual", "hand_back_department", { convId: conv.id, department, closedTodos });
    return res.json({ ok: true, handedBack: true, closedTodos, conversation: conv });
  });
}
