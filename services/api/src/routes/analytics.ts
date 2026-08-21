/**
 * THE TWO MANAGER ANALYTICS ENDPOINTS, together.
 *
 * Both live here rather than in index.ts because the source-size ratchet caught the Appointments
 * report at +39 lines and said the right thing: move new code into a module instead of raising the
 * ceiling. `/analytics/kpi` came with it — index.ts was sitting EXACTLY on its ceiling, so nothing
 * could be added without moving something out, and its sibling is the obvious thing to move. The
 * KPI handler below is a verbatim relocation; no behaviour changed with it.
 *
 * WHY THEY ARE TWO ENDPOINTS AND NOT ONE PAYLOAD. They disagree about what a date range means:
 * `/analytics/kpi` ranges on when the LEAD ARRIVED (a lead-cohort question), `/analytics/appointments`
 * ranges on when the APPOINTMENT IS (a pay-period question). Joe asked for the second one on
 * 2026-08-21 precisely because the first cannot answer it. Merging them behind one date picker is
 * how you get two numbers that are both right and never reconcile.
 *
 * FAIL DIRECTION: both are read-only and manager-gated. They read the store and return a table —
 * they write nothing, send nothing, and cannot change a customer-visible outcome. The judgement
 * calls that DO matter for the appointments report (an ungraded appointment never counting as a
 * show; an unrecorded setter never borrowing the calendar owner's name) live in
 * `domain/appointmentSetterReport.ts`, pinned by `appointment_setter_report:eval`.
 */
import type { Express } from "express";

import { getAllConversations } from "../domain/conversationStore.js";
import { getSchedulerConfig } from "../domain/schedulerConfig.js";
import { buildKpiOverview } from "../domain/kpiAnalytics.js";
import {
  appointmentReportToCsv,
  buildAppointmentReport
} from "../domain/appointmentSetterReport.js";

export function registerAnalyticsRoutes(app: Express) {
  app.get("/analytics/kpi", async (req, res) => {
    const user = (req as any).user ?? null;
    if (String(user?.role ?? "").toLowerCase() !== "manager") {
      return res.status(403).json({ ok: false, error: "manager access required" });
    }
    const source = String(req.query?.source ?? "all").trim();
    const ownerId = String(req.query?.ownerId ?? "all").trim();
    const leadType = String(req.query?.leadType ?? "all")
      .trim()
      .toLowerCase();
    const leadScope = String(req.query?.leadScope ?? "include_walkins")
      .trim()
      .toLowerCase();
    const appointmentSetter = String(req.query?.appointmentSetter ?? "all")
      .trim()
      .toLowerCase();
    const callOwnerId = String(req.query?.callOwnerId ?? ownerId ?? "all").trim();
    const from = String(req.query?.from ?? "").trim();
    const to = String(req.query?.to ?? "").trim();

    const conversations = getAllConversations();
    const schedulerCfg = await getSchedulerConfig();
    const overview = buildKpiOverview(
      conversations,
      {
        source: source || "all",
        ownerId: ownerId || "all",
        leadType: (leadType || "all") as "all" | "new" | "used" | "walk_in",
        leadScope: (leadScope || "include_walkins") as
          | "online_only"
          | "include_walkins"
          | "walkin_only"
          | "phone_log_only",
        callOwnerId: callOwnerId || "all",
        appointmentSetter: (appointmentSetter || "all") as
          | "all"
          | "ai_sms"
          | "human_sms"
          | "human_email"
          | "human_phone"
          | "human_manual"
          | "customer_public_booking"
          | "unknown",
        from: from || undefined,
        to: to || undefined
      },
      {
        businessHours: {
          timezone: String(schedulerCfg.timezone || "America/New_York"),
          businessHours: schedulerCfg.businessHours ?? {}
        }
      }
    );

    res.json({
      ok: true,
      overview
    });
  });

  /** "Who set it, and did they show?" — the commission view. */
  app.get("/analytics/appointments", async (req, res) => {
    const user = (req as any).user ?? null;
    if (String(user?.role ?? "").toLowerCase() !== "manager") {
      return res.status(403).json({ ok: false, error: "manager access required" });
    }

    const from = String(req.query?.from ?? "").trim();
    const to = String(req.query?.to ?? "").trim();
    const format = String(req.query?.format ?? "json").trim().toLowerCase();

    const schedulerCfg = await getSchedulerConfig();
    const report = buildAppointmentReport(getAllConversations(), {
      from: from || undefined,
      to: to || undefined,
      timeZone: String(schedulerCfg.timezone || "America/New_York")
    });

    if (format === "csv") {
      // The CSV is built by the domain module, not assembled again here — a commission sheet
      // produced by two code paths is a commission sheet that can disagree with itself.
      const stamp = `${(from || "start").slice(0, 10)}_${(to || "end").slice(0, 10)}`;
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="appointments_${stamp}.csv"`);
      return res.send(appointmentReportToCsv(report));
    }

    return res.json({ ok: true, report });
  });
}
