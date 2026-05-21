"use client";

import { useEffect, useMemo, useState } from "react";

type CommandUser = {
  id: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  role: "manager" | "salesperson" | "service" | "parts" | "apparel";
  permissions?: {
    canAccessTodos?: boolean;
    canViewAllTasks?: boolean;
    canViewAllLeads?: boolean;
  };
  calendarId?: string;
  includeInSchedule?: boolean;
  commandBookingEnabled?: boolean;
  commandCalendarId?: string;
  phone?: string;
  extension?: string;
  emailSignature?: string;
};

type UserForm = {
  name: string;
  email: string;
  password: string;
  role: "manager" | "salesperson";
};

type UserPatch = Partial<UserForm> & {
  commandBookingEnabled?: boolean;
  commandCalendarId?: string;
};

const emptyForm: UserForm = {
  name: "",
  email: "",
  password: "",
  role: "manager"
};

function displayName(user: CommandUser) {
  return user.name || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email;
}

function commandRoleLabel(user: CommandUser) {
  if (user.role === "manager") return "Admin";
  return "Operator";
}

function commandPayload(form: UserForm) {
  return {
    name: form.name.trim(),
    email: form.email.trim().toLowerCase(),
    password: form.password,
    role: form.role,
    permissions:
      form.role === "manager"
        ? undefined
        : {
            canAccessTodos: true,
            canViewAllTasks: true,
            canViewAllLeads: true
          }
  };
}

export default function CommandUsersPage() {
  const [users, setUsers] = useState<CommandUser[]>([]);
  const [form, setForm] = useState<UserForm>(emptyForm);
  const [notice, setNotice] = useState("LeadRider user management is ready.");
  const [busy, setBusy] = useState(false);
  const [editPasswordById, setEditPasswordById] = useState<Record<string, string>>({});

  const admins = useMemo(() => users.filter(user => user.role === "manager").length, [users]);
  const operators = useMemo(() => users.length - admins, [users, admins]);

  useEffect(() => {
    void loadUsers();
  }, []);

  async function loadUsers() {
    setBusy(true);
    try {
      const resp = await fetch("/api/users?scope=command", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "Users could not be loaded.");
      setUsers(Array.isArray(data.users) ? data.users : []);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Users could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  async function createUser() {
    if (!form.email.trim().endsWith("@leadrider.ai")) {
      setNotice("Command users must use an @leadrider.ai email.");
      return;
    }
    if (!form.password || form.password.length < 8) {
      setNotice("Use a temporary password with at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      const resp = await fetch("/api/users?scope=command", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(commandPayload(form))
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "User could not be created.");
      setUsers(current => [data.user, ...current.filter(user => user.id !== data.user.id)]);
      setForm(emptyForm);
      setNotice(`${data.user.email} was added to Command.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "User could not be created.");
    } finally {
      setBusy(false);
    }
  }

  function bookingLinkFor(user: CommandUser) {
    if (typeof window === "undefined") return `/book?commandUser=${encodeURIComponent(user.id)}`;
    return `${window.location.origin}/book?commandUser=${encodeURIComponent(user.id)}`;
  }

  async function updateUser(user: CommandUser, patch: UserPatch) {
    setBusy(true);
    try {
      const nextRole = patch.role ?? (user.role === "manager" ? "manager" : "salesperson");
      const resp = await fetch(`/api/users/${encodeURIComponent(user.id)}?scope=command`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: patch.name ?? displayName(user),
          email: patch.email ?? user.email,
          password: patch.password || undefined,
          role: nextRole,
          calendarId: user.calendarId,
          includeInSchedule: user.includeInSchedule,
          phone: user.phone,
          extension: user.extension,
          emailSignature: user.emailSignature,
          commandBookingEnabled:
            typeof patch.commandBookingEnabled === "boolean"
              ? patch.commandBookingEnabled
              : user.commandBookingEnabled ?? true,
          commandCalendarId:
            patch.commandCalendarId == null ? user.commandCalendarId ?? "" : patch.commandCalendarId,
          permissions:
            nextRole === "manager"
              ? undefined
              : {
                  canAccessTodos: true,
                  canViewAllTasks: true,
                  canViewAllLeads: true
                }
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "User could not be updated.");
      setUsers(current => current.map(row => (row.id === data.user.id ? data.user : row)));
      setEditPasswordById(current => ({ ...current, [user.id]: "" }));
      setNotice(`${data.user.email} was updated.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "User could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  async function deleteUser(user: CommandUser) {
    const confirmed = window.confirm(`Deactivate ${user.email}?`);
    if (!confirmed) return;
    setBusy(true);
    try {
      const resp = await fetch(`/api/users/${encodeURIComponent(user.id)}?scope=command`, { method: "DELETE" });
      const data = await resp.json();
      if (!resp.ok || !data?.ok) throw new Error(data?.error || "User could not be deactivated.");
      setUsers(current => current.filter(row => row.id !== user.id));
      setNotice(`${user.email} was deactivated.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "User could not be deactivated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="lr-ceo-shell">
      <aside className="lr-ceo-sidebar">
        <div className="lr-ceo-brand">
          <div className="lr-ceo-mark">LR</div>
          <div>
            <p className="lr-ceo-kicker">LeadRider</p>
            <h1>Command</h1>
          </div>
        </div>
        <nav className="lr-ceo-nav" aria-label="LeadRider command sections">
          <a href="/command">Command Home</a>
          <a href="/command/sales">Sales Funnel</a>
          <a href="/command/support">Support Agent</a>
          <a href="/command/personal-email">Personal Email</a>
          <a href="/command/clients">Active Clients</a>
          <a href="/command/clients/new">Dealer Setup</a>
          <a href="/command/users" className="is-active">Users</a>
          <a href="/command">Agreements</a>
          <a href="/command">Billing</a>
          <a href="/command">Connectors</a>
        </nav>
        <section className="lr-ceo-side-panel">
          <p className="lr-ceo-kicker">Access</p>
          <strong>{users.length} internal users</strong>
          <span>{admins} admins, {operators} operators</span>
        </section>
      </aside>

      <section className="lr-ceo-main">
        <header className="lr-ceo-header">
          <div>
            <p className="lr-ceo-kicker">LeadRider admin</p>
            <h2>Users</h2>
            <p>Manage internal Command users. Dealer workspace users stay inside each dealer account.</p>
          </div>
          <div className="lr-ceo-header-actions">
            <button type="button" className="lr-ceo-secondary-btn" onClick={loadUsers} disabled={busy}>Refresh</button>
          </div>
        </header>

        <section className="lr-ceo-notice" aria-live="polite">{notice}</section>

        <section className="lr-ceo-grid">
          <article className="lr-ceo-panel">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">New user</p>
                <h3>Add Command user</h3>
              </div>
            </div>
            <div className="lr-ceo-form-stack">
              <label>Name<input value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} placeholder="Full name" /></label>
              <label>Email<input value={form.email} onChange={event => setForm(current => ({ ...current, email: event.target.value }))} placeholder="name@leadrider.ai" /></label>
              <label>Temporary password<input type="password" value={form.password} onChange={event => setForm(current => ({ ...current, password: event.target.value }))} placeholder="Temporary password" /></label>
              <label>Role
                <select value={form.role} onChange={event => setForm(current => ({ ...current, role: event.target.value as UserForm["role"] }))}>
                  <option value="manager">Admin</option>
                  <option value="salesperson">Operator</option>
                </select>
              </label>
              <button type="button" onClick={createUser} disabled={busy}>Create user</button>
            </div>
          </article>

          <article className="lr-ceo-panel lr-ceo-panel-wide">
            <div className="lr-ceo-panel-title">
              <div>
                <p className="lr-ceo-kicker">Directory</p>
                <h3>Command access</h3>
              </div>
            </div>
            <div className="lr-ceo-user-list">
              {users.map(user => (
                <div className="lr-ceo-user-row" key={user.id}>
                  <div>
                    <strong>{displayName(user)}</strong>
                    <span>{user.email}</span>
                    <small>Paste the LeadRider Command Google Calendar ID below. This stays separate from dealer appointment calendars.</small>
                    {user.commandBookingEnabled !== false && user.commandCalendarId ? (
                      <a href={bookingLinkFor(user)} target="_blank" rel="noreferrer">
                        {bookingLinkFor(user)}
                      </a>
                    ) : null}
                  </div>
                  <select
                    value={user.role === "manager" ? "manager" : "salesperson"}
                    onChange={event => updateUser(user, { role: event.target.value as UserForm["role"] })}
                    disabled={busy}
                  >
                    <option value="manager">Admin</option>
                    <option value="salesperson">Operator</option>
                  </select>
                  <div className="lr-ceo-user-booking">
                    <label>
                      Command calendar ID
                      <input
                        value={user.commandCalendarId ?? ""}
                        onChange={event =>
                          setUsers(current =>
                            current.map(row => (row.id === user.id ? { ...row, commandCalendarId: event.target.value } : row))
                          )
                        }
                        placeholder="calendar@group.calendar.google.com"
                      />
                    </label>
                    <div className="lr-ceo-user-booking-actions">
                      <label className="lr-ceo-inline-check">
                        <input
                          type="checkbox"
                          checked={user.commandBookingEnabled !== false}
                          onChange={event =>
                            setUsers(current =>
                              current.map(row =>
                                row.id === user.id ? { ...row, commandBookingEnabled: event.target.checked } : row
                              )
                            )
                          }
                        />
                        Booking enabled
                      </label>
                      <button
                        type="button"
                        className="lr-ceo-secondary-btn"
                        onClick={() =>
                          updateUser(user, {
                            commandCalendarId: user.commandCalendarId ?? "",
                            commandBookingEnabled: user.commandBookingEnabled !== false
                          })
                        }
                        disabled={busy}
                      >
                        Save booking
                      </button>
                    </div>
                  </div>
                  <div className="lr-ceo-user-password">
                    <input
                      type="password"
                      value={editPasswordById[user.id] ?? ""}
                      onChange={event => setEditPasswordById(current => ({ ...current, [user.id]: event.target.value }))}
                      placeholder="New password"
                    />
                    <button
                      type="button"
                      className="lr-ceo-secondary-btn"
                      onClick={() => updateUser(user, { password: editPasswordById[user.id] ?? "" })}
                      disabled={busy || !(editPasswordById[user.id] ?? "").trim()}
                    >
                      Reset
                    </button>
                  </div>
                  <span className="lr-ceo-status-pill is-ready">{commandRoleLabel(user)}</span>
                  <button type="button" className="lr-ceo-secondary-btn" onClick={() => deleteUser(user)} disabled={busy}>Deactivate</button>
                </div>
              ))}
              {!users.length ? <p className="lr-ceo-empty">No LeadRider users found.</p> : null}
            </div>
          </article>
        </section>
      </section>
    </main>
  );
}
