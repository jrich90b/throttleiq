import { useMemo } from "react";

export type InboxDealFilter = "all" | "active" | "hot" | "sold" | "hold";
export type InboxTaskFilter = "all" | "open_task" | "overdue" | "no_task";

export type ConversationTaskState = { hasOpenTask: boolean; hasOverdueTask: boolean };

type ConversationLike = any;
type TodoLike = any;

type UseInboxSectionDataArgs = {
  conversations: ConversationLike[];
  todos: TodoLike[];
  view: "inbox" | "campaigns" | "archive";
  inboxQuery: string;
  inboxOwnerFilter: string;
  inboxDealFilter: InboxDealFilter;
  inboxTaskFilter: InboxTaskFilter;
  getConversationTaskState: (conversation: ConversationLike) => ConversationTaskState;
  canFilterOwners: boolean;
  canonicalizeOwnerName: (rawName: string, ownerId?: string | null) => string;
  inferOwnerDepartment: (
    ownerNameRaw: string,
    ownerId?: string | null
  ) => "service" | "parts" | "apparel" | null;
  inferTodoDepartment: (todo: TodoLike) => "service" | "parts" | "apparel" | null;
  isHotDealConversation: (conversation: ConversationLike) => boolean;
  isSoldDealConversation: (conversation: ConversationLike) => boolean;
  isConversationOnHold: (conversation: ConversationLike) => boolean;
  isArchivedConversation: (conversation: ConversationLike) => boolean;
  isCampaignOnlyConversation: (conversation: ConversationLike | null | undefined) => boolean;
  isCampaignConversation: (conversation: ConversationLike | null | undefined) => boolean;
};

type GroupedConversation = {
  key: string;
  label: string;
  items: ConversationLike[];
  isCampaignGroup: boolean;
};

export function useInboxSectionData({
  conversations,
  todos,
  view,
  inboxQuery,
  inboxOwnerFilter,
  inboxDealFilter,
  inboxTaskFilter,
  getConversationTaskState,
  canFilterOwners,
  canonicalizeOwnerName,
  inferOwnerDepartment,
  inferTodoDepartment,
  isHotDealConversation,
  isSoldDealConversation,
  isConversationOnHold,
  isArchivedConversation,
  isCampaignOnlyConversation,
  isCampaignConversation
}: UseInboxSectionDataArgs) {
  const visibleConversations = useMemo(() => {
    return conversations.filter(c => {
      const archived = isArchivedConversation(c);
      const campaignOnly = isCampaignOnlyConversation(c);
      const campaignVisible = isCampaignConversation(c);
      if (view === "archive") return archived;
      if (view === "campaigns") return !archived && campaignVisible;
      return !archived && !campaignOnly;
    });
  }, [
    conversations,
    view,
    isArchivedConversation,
    isCampaignOnlyConversation,
    isCampaignConversation
  ]);

  const inboxDepartmentTeamsByConv = useMemo(() => {
    const out = new Map<string, Set<string>>();
    for (const t of todos) {
      const team = inferTodoDepartment(t);
      if (!team) continue;
      if (!out.has(t.convId)) out.set(t.convId, new Set<string>());
      out.get(t.convId)?.add(team);
    }
    return out;
  }, [todos, inferTodoDepartment]);

  const inboxTodoOwnerByConv = useMemo(() => {
    const out = new Map<string, string>();
    for (const t of todos) {
      const ownerDisplay = String(
        t.ownerDisplayName ?? t.departmentOwnerName ?? t.ownerName ?? ""
      ).trim();
      const reason = String(t.reason ?? "").toLowerCase();
      const isDepartmentTodo =
        reason === "service" ||
        reason === "parts" ||
        reason === "apparel" ||
        t.ownerDisplayType === "department_owner";
      if (!isDepartmentTodo) continue;
      if (!ownerDisplay) continue;
      if (!out.has(t.convId)) out.set(t.convId, ownerDisplay);
    }
    return out;
  }, [todos]);

  const filteredConversations = useMemo(() => {
    const q = inboxQuery.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, "");
    const ownerNameFilter = inboxOwnerFilter.startsWith("owner:")
      ? decodeURIComponent(inboxOwnerFilter.slice("owner:".length)).toLowerCase()
      : "";

    const rows = visibleConversations.filter(c => {
      if (inboxDealFilter === "hot" && !isHotDealConversation(c)) return false;
      if (inboxDealFilter === "sold" && !isSoldDealConversation(c)) return false;
      if (inboxDealFilter === "hold" && !isConversationOnHold(c)) return false;
      // "active" = a deal still in play: not sold, not parked on hold.
      if (inboxDealFilter === "active" && (isSoldDealConversation(c) || isConversationOnHold(c))) {
        return false;
      }

      if (inboxTaskFilter !== "all") {
        const taskState = getConversationTaskState(c);
        if (inboxTaskFilter === "open_task" && !taskState.hasOpenTask) return false;
        if (inboxTaskFilter === "overdue" && !taskState.hasOverdueTask) return false;
        if (inboxTaskFilter === "no_task" && taskState.hasOpenTask) return false;
      }

      if (canFilterOwners && inboxOwnerFilter !== "all") {
        const leadOwner = canonicalizeOwnerName(
          String(c.leadOwner?.name ?? c.leadOwner?.id ?? "").trim(),
          c.leadOwner?.id
        );
        const ownerDepartment = inferOwnerDepartment(
          String(c.leadOwner?.name ?? c.leadOwner?.id ?? "").trim(),
          c.leadOwner?.id
        );
        const teams = inboxDepartmentTeamsByConv.get(c.id) ?? new Set<string>();
        const hasServiceTodo = teams.has("service") || ownerDepartment === "service";
        const hasPartsTodo = teams.has("parts") || ownerDepartment === "parts";
        const hasApparelTodo = teams.has("apparel") || ownerDepartment === "apparel";
        if (inboxOwnerFilter === "team:sales") {
          if (!leadOwner || ownerDepartment) return false;
        } else if (inboxOwnerFilter === "team:service") {
          if (!hasServiceTodo) return false;
        } else if (inboxOwnerFilter === "team:parts") {
          if (!hasPartsTodo) return false;
        } else if (inboxOwnerFilter === "team:apparel") {
          if (!hasApparelTodo) return false;
        } else if (inboxOwnerFilter === "team:unassigned") {
          if (leadOwner || hasServiceTodo || hasPartsTodo || hasApparelTodo || ownerDepartment) {
            return false;
          }
        } else if (ownerNameFilter) {
          if (leadOwner.toLowerCase() !== ownerNameFilter) return false;
        } else {
          return false;
        }
      }

      if (!q) return true;

      const name = String(c.leadName ?? "").toLowerCase();
      const key = String(c.leadKey ?? "").toLowerCase();
      if (name.includes(q) || key.includes(q)) return true;

      if (qDigits) {
        const keyDigits = String(c.leadKey ?? "").replace(/\D/g, "");
        if (keyDigits.includes(qDigits)) return true;
      }
      return false;
    });

    return [...rows].sort((a, b) => {
      // Sort the working Inbox by last REAL activity (customer reply / staff reply), not by the
      // generic record-updated time. A campaign broadcast bumps updatedAt but leaves inboxActivityAt
      // frozen, so a mass send no longer shoves threads to the top of the Inbox. Falls back to
      // updatedAt for older conversations that predate the field.
      const aMs = Date.parse(String(a.inboxActivityAt ?? a.updatedAt ?? "")) || 0;
      const bMs = Date.parse(String(b.inboxActivityAt ?? b.updatedAt ?? "")) || 0;
      return bMs - aMs;
    });
  }, [
    visibleConversations,
    inboxQuery,
    canFilterOwners,
    inboxOwnerFilter,
    inboxDealFilter,
    inboxTaskFilter,
    getConversationTaskState,
    inboxDepartmentTeamsByConv,
    canonicalizeOwnerName,
    inferOwnerDepartment,
    isHotDealConversation,
    isSoldDealConversation,
    isConversationOnHold
  ]);

  const inboxDealCounts = useMemo(() => {
    let active = 0;
    let hot = 0;
    let sold = 0;
    let hold = 0;
    for (const c of visibleConversations) {
      const isSold = isSoldDealConversation(c);
      const isHold = isConversationOnHold(c);
      if (isSold) sold += 1;
      if (isHold) hold += 1;
      if (!isSold && !isHold) active += 1;
      if (isHotDealConversation(c)) hot += 1;
    }
    return { active, hot, sold, hold };
  }, [visibleConversations, isSoldDealConversation, isConversationOnHold, isHotDealConversation]);

  const inboxTaskCounts = useMemo(() => {
    let openTask = 0;
    let overdue = 0;
    let noTask = 0;
    for (const c of visibleConversations) {
      const state = getConversationTaskState(c);
      if (state.hasOpenTask) openTask += 1;
      else noTask += 1;
      if (state.hasOverdueTask) overdue += 1;
    }
    return { openTask, overdue, noTask };
  }, [visibleConversations, getConversationTaskState]);

  const groupedConversations = useMemo(() => {
    if (view === "campaigns") {
      const byKey = new Map<
        string,
        { key: string; label: string; items: ConversationLike[]; latestUpdatedMs: number }
      >();
      for (const c of filteredConversations) {
        const thread = c.campaignThread ?? null;
        const campaignId = String(thread?.campaignId ?? "").trim();
        const campaignName =
          String(thread?.campaignName ?? "").trim() ||
          String(thread?.listName ?? "").trim() ||
          "Unlabeled campaign";
        const key =
          campaignId ||
          String(thread?.listId ?? "").trim() ||
          `campaign_name:${campaignName.toLowerCase()}`;
        const updatedMs = Date.parse(String(c.updatedAt ?? "")) || 0;
        const existing = byKey.get(key);
        if (!existing) {
          byKey.set(key, {
            key,
            label: campaignName,
            items: [c],
            latestUpdatedMs: updatedMs
          });
          continue;
        }
        existing.items.push(c);
        existing.latestUpdatedMs = Math.max(existing.latestUpdatedMs, updatedMs);
      }
      return Array.from(byKey.values())
        .map(group => ({
          key: group.key,
          label: group.label,
          items: group.items.sort((a, b) => {
            const aMs = Date.parse(String(a.updatedAt ?? "")) || 0;
            const bMs = Date.parse(String(b.updatedAt ?? "")) || 0;
            return bMs - aMs;
          }),
          isCampaignGroup: true
        }))
        .sort((a, b) => {
          const aMs = Date.parse(String(a.items[0]?.updatedAt ?? "")) || 0;
          const bMs = Date.parse(String(b.items[0]?.updatedAt ?? "")) || 0;
          return bMs - aMs;
        });
    }

    const groups: GroupedConversation[] = [];
    let lastLabel = "";
    for (const c of filteredConversations) {
      // Group the Inbox by the same effective time it is sorted by (last real activity), so a
      // campaign-tagged thread stays under its real-activity date, not the day the blast went out.
      const label = new Date(c.inboxActivityAt ?? c.updatedAt).toLocaleDateString("en-US", {
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric"
      });
      if (label !== lastLabel) {
        groups.push({ key: label, label, items: [c], isCampaignGroup: false });
        lastLabel = label;
      } else {
        groups[groups.length - 1].items.push(c);
      }
    }
    return groups;
  }, [filteredConversations, view]);

  return {
    visibleConversations,
    inboxDepartmentTeamsByConv,
    inboxTodoOwnerByConv,
    filteredConversations,
    inboxDealCounts,
    inboxTaskCounts,
    groupedConversations
  };
}
