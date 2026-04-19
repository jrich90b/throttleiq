import { useMemo } from "react";

export type TodoInboxSection = "followup" | "appointment" | "todo" | "reminder";

type TodoLike = any;

type UseTaskInboxDataArgs = {
  todos: TodoLike[];
  todoQuery: string;
  isManager: boolean;
  todoLeadOwnerFilter: string;
  todoTaskTypeFilter: "all" | TodoInboxSection;
  canonicalizeOwnerName: (rawName: string, ownerId?: string | null) => string;
  inferOwnerDepartment: (
    ownerNameRaw: string,
    ownerId?: string | null
  ) => "service" | "parts" | "apparel" | null;
  inferTodoDepartment: (todo: TodoLike) => "service" | "parts" | "apparel" | null;
  todoInboxSection: (todo: TodoLike) => TodoInboxSection;
};

export function useTaskInboxData({
  todos,
  todoQuery,
  isManager,
  todoLeadOwnerFilter,
  todoTaskTypeFilter,
  canonicalizeOwnerName,
  inferOwnerDepartment,
  inferTodoDepartment,
  todoInboxSection
}: UseTaskInboxDataArgs) {
  const filteredTodos = useMemo(() => {
    const q = todoQuery.trim().toLowerCase();
    const ownerNameFilter = todoLeadOwnerFilter.startsWith("owner:")
      ? decodeURIComponent(todoLeadOwnerFilter.slice("owner:".length)).toLowerCase()
      : "";

    return todos.filter(t => {
      const leadName = String(t.leadName ?? "").toLowerCase();
      const leadKey = String(t.leadKey ?? "").toLowerCase();
      const leadOwnerCanonical = canonicalizeOwnerName(String(t.leadOwnerName ?? "").trim());
      const leadOwner = String(leadOwnerCanonical ?? "").trim();
      const departmentOwner = String(t.departmentOwnerName ?? "").trim();
      const todoDept = inferTodoDepartment(t);
      const inferredDeptOwner = inferOwnerDepartment(leadOwner);
      const todoTeamBase = todoDept ?? "sales";
      const todoTeam = todoTeamBase === "sales" && inferredDeptOwner ? inferredDeptOwner : todoTeamBase;

      if (isManager && todoLeadOwnerFilter !== "all") {
        if (todoLeadOwnerFilter === "team:unassigned") {
          if (todoTeam === "sales") {
            if (leadOwner) return false;
          } else if (departmentOwner) {
            return false;
          }
        } else if (todoLeadOwnerFilter.startsWith("team:")) {
          if (todoTeam !== todoLeadOwnerFilter.slice(5)) return false;
        } else if (ownerNameFilter) {
          if (leadOwner.toLowerCase() !== ownerNameFilter) return false;
        } else {
          return false;
        }
      }

      if (todoTaskTypeFilter !== "all" && todoInboxSection(t) !== todoTaskTypeFilter) return false;
      if (!q) return true;
      return leadName.includes(q) || leadKey.includes(q);
    });
  }, [
    todos,
    todoQuery,
    isManager,
    todoLeadOwnerFilter,
    todoTaskTypeFilter,
    canonicalizeOwnerName,
    inferOwnerDepartment,
    inferTodoDepartment,
    todoInboxSection
  ]);

  const groupedTodos = useMemo(() => {
    const groups: Record<TodoInboxSection, TodoLike[]> = {
      followup: [],
      appointment: [],
      todo: [],
      reminder: []
    };
    for (const task of filteredTodos) {
      groups[todoInboxSection(task)].push(task);
    }
    return groups;
  }, [filteredTodos, todoInboxSection]);

  const todoSectionDefs = useMemo(() => {
    if (todoTaskTypeFilter === "all") {
      return [
        { key: "followup", label: "Follow-ups" },
        { key: "todo", label: "To Dos" },
        { key: "reminder", label: "Reminders" },
        { key: "appointment", label: "Appointments" }
      ] as Array<{ key: TodoInboxSection; label: string }>;
    }
    return [
      {
        key: todoTaskTypeFilter,
        label:
          todoTaskTypeFilter === "followup"
            ? "Follow-ups"
            : todoTaskTypeFilter === "appointment"
              ? "Appointments"
              : todoTaskTypeFilter === "reminder"
                ? "Reminders"
                : "To Dos"
      }
    ] as Array<{ key: TodoInboxSection; label: string }>;
  }, [todoTaskTypeFilter]);

  return {
    filteredTodos,
    groupedTodos,
    todoSectionDefs
  };
}
