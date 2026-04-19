import { useMemo } from "react";

export type InboxDealFilter = "all" | "hot" | "sold" | "hold";

type ConversationLike = any;
type TodoLike = any;

type UseInboxSectionDataArgs = {
  conversations: ConversationLike[];
  todos: TodoLike[];
  view: "inbox" | "campaigns" | "archive";
  inboxQuery: string;
  inboxOwnerFilter: string;
  inboxDealFilter: InboxDealFilter;
  isManager: boolean;
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
  isManager,
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

      if (isManager && inboxOwnerFilter !== "all") {
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
      const aMs = Date.parse(String(a.updatedAt ?? "")) || 0;
      const bMs = Date.parse(String(b.updatedAt ?? "")) || 0;
      return bMs - aMs;
    });
  }, [
    visibleConversations,
    inboxQuery,
    isManager,
    inboxOwnerFilter,
    inboxDealFilter,
    inboxDepartmentTeamsByConv,
    canonicalizeOwnerName,
    inferOwnerDepartment,
    isHotDealConversation,
    isSoldDealConversation,
    isConversationOnHold
  ]);

  const inboxDealCounts = useMemo(() => {
    let hot = 0;
    let sold = 0;
    let hold = 0;
    for (const c of visibleConversations) {
      if (isSoldDealConversation(c)) sold += 1;
      if (isConversationOnHold(c)) hold += 1;
      if (isHotDealConversation(c)) hot += 1;
    }
    return { hot, sold, hold };
  }, [visibleConversations, isSoldDealConversation, isConversationOnHold, isHotDealConversation]);

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
      const label = new Date(c.updatedAt).toLocaleDateString("en-US", {
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
    groupedConversations
  };
}
