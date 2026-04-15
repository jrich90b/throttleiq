import { promises as fs } from "node:fs";
import * as path from "node:path";
import { randomUUID, pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { dataPath } from "./dataDir.js";

export type UserRole = "manager" | "salesperson" | "service" | "parts" | "apparel";

export type UserPermissions = {
  canEditAppointments: boolean;
  canToggleHumanOverride: boolean;
  canAccessTodos: boolean;
  canAccessSuppressions: boolean;
};

function basePermissions(): UserPermissions {
  return {
    canEditAppointments: false,
    canToggleHumanOverride: false,
    canAccessTodos: false,
    canAccessSuppressions: false
  };
}

function defaultPermissionsForRole(role: UserRole): UserPermissions {
  if (role === "manager") {
    return {
      canEditAppointments: true,
      canToggleHumanOverride: true,
      canAccessTodos: true,
      canAccessSuppressions: true
    };
  }
  if (role === "service" || role === "parts" || role === "apparel") {
    return {
      canEditAppointments: false,
      canToggleHumanOverride: false,
      canAccessTodos: true,
      canAccessSuppressions: false
    };
  }
  return basePermissions();
}

export type UserRecord = {
  id: string;
  email: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  role: UserRole;
  includeInSchedule?: boolean;
  calendarId?: string;
  phone?: string;
  extension?: string;
  permissions: UserPermissions;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
};

type SessionRecord = { token: string; userId: string; expiresAt: string };
type PasswordResetRecord = {
  tokenHash: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
};

type UsersFile = { users: UserRecord[] };
type SessionsFile = { sessions: SessionRecord[] };
type PasswordResetsFile = { resets: PasswordResetRecord[] };

const USERS_PATH = dataPath("users.json");
const SESSIONS_PATH = dataPath("sessions.json");
const PASSWORD_RESETS_PATH = dataPath("password_resets.json");
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60;

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(filePath: string, data: any): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
}

export async function listUsers(): Promise<UserRecord[]> {
  const data = await readJson<UsersFile>(USERS_PATH, { users: [] });
  return data.users ?? [];
}

export async function hasAnyUsers(): Promise<boolean> {
  const users = await listUsers();
  return users.length > 0;
}

export async function getUserByEmail(email: string): Promise<UserRecord | null> {
  const users = await listUsers();
  return users.find(u => u.email.toLowerCase() === email.toLowerCase()) ?? null;
}

export async function getUserById(id: string): Promise<UserRecord | null> {
  const users = await listUsers();
  return users.find(u => u.id === id) ?? null;
}

function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const iterations = 100000;
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

function verifyPasswordHash(password: string, stored: string): boolean {
  const [method, iterStr, salt, hash] = stored.split("$");
  if (method !== "pbkdf2") return false;
  const iterations = Number(iterStr || 0);
  if (!iterations || !salt || !hash) return false;
  const computed = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return timingSafeEqual(Buffer.from(computed), Buffer.from(hash));
}

function hashResetToken(token: string): string {
  return createHash("sha256").update(String(token ?? "")).digest("hex");
}

async function listActivePasswordResets(nowMs = Date.now()): Promise<PasswordResetRecord[]> {
  const data = await readJson<PasswordResetsFile>(PASSWORD_RESETS_PATH, { resets: [] });
  return (data.resets ?? []).filter(r => {
    const expiresAt = Date.parse(String(r.expiresAt ?? ""));
    return Number.isFinite(expiresAt) && expiresAt > nowMs;
  });
}

async function writePasswordResets(resets: PasswordResetRecord[]): Promise<void> {
  await writeJson(PASSWORD_RESETS_PATH, { resets });
}

export async function createUser(input: {
  email: string;
  password: string;
  role: UserRole;
  name?: string;
  firstName?: string;
  lastName?: string;
  includeInSchedule?: boolean;
  calendarId?: string;
  phone?: string;
  extension?: string;
  permissions?: Partial<UserPermissions>;
}): Promise<UserRecord> {
  const users = await listUsers();
  if (users.some(u => u.email.toLowerCase() === input.email.toLowerCase())) {
    throw new Error("Email already exists");
  }
  const now = new Date().toISOString();
  const roleDefaults = defaultPermissionsForRole(input.role);
  const perms: UserPermissions =
    input.role === "manager"
      ? roleDefaults
      : input.role === "service" || input.role === "parts" || input.role === "apparel"
        ? {
            ...roleDefaults,
            ...(input.permissions ?? {}),
            canEditAppointments: false,
            canToggleHumanOverride: false,
            canAccessSuppressions: false,
            canAccessTodos: true
          }
        : { ...roleDefaults, ...(input.permissions ?? {}) };
  const includeInSchedule =
    input.role === "service" || input.role === "parts" || input.role === "apparel"
      ? false
      : typeof input.includeInSchedule === "boolean"
      ? input.includeInSchedule
      : input.role === "salesperson";
  const user: UserRecord = {
    id: randomUUID(),
    email: input.email.trim(),
    name: input.name?.trim() || undefined,
    firstName: input.firstName?.trim() || undefined,
    lastName: input.lastName?.trim() || undefined,
    role: input.role,
    includeInSchedule,
    calendarId: input.calendarId?.trim() || undefined,
    phone: input.phone?.trim() || undefined,
    extension: input.extension?.trim() || undefined,
    permissions: perms,
    passwordHash: hashPassword(input.password),
    createdAt: now,
    updatedAt: now
  };
  await writeJson(USERS_PATH, { users: [...users, user] });
  return user;
}

export async function updateUser(
  id: string,
  patch: Partial<{
    email: string;
    password: string;
    role: UserRole;
    name: string;
    firstName: string;
    lastName: string;
    includeInSchedule: boolean;
    calendarId: string;
    phone: string;
    extension: string;
    permissions: Partial<UserPermissions>;
  }>
): Promise<UserRecord> {
  const users = await listUsers();
  const idx = users.findIndex(u => u.id === id);
  if (idx === -1) throw new Error("User not found");
  const existing = users[idx];
  if (patch.email && patch.email.toLowerCase() !== existing.email.toLowerCase()) {
    if (users.some(u => u.email.toLowerCase() === patch.email!.toLowerCase())) {
      throw new Error("Email already exists");
    }
  }
  const nextRole = patch.role ?? existing.role;
  const roleDefaults = defaultPermissionsForRole(nextRole);
  const nextPerms: UserPermissions =
    nextRole === "manager"
      ? roleDefaults
      : nextRole === "service" || nextRole === "parts" || nextRole === "apparel"
        ? {
            ...roleDefaults,
            ...(existing.permissions ?? roleDefaults),
            ...(patch.permissions ?? {}),
            canEditAppointments: false,
            canToggleHumanOverride: false,
            canAccessSuppressions: false,
            canAccessTodos: true
          }
        : { ...roleDefaults, ...(existing.permissions ?? roleDefaults), ...(patch.permissions ?? {}) };
  const includeInSchedule =
    nextRole === "service" || nextRole === "parts" || nextRole === "apparel"
      ? false
      : typeof patch.includeInSchedule === "boolean"
      ? patch.includeInSchedule
      : existing.includeInSchedule ?? (nextRole === "salesperson");
  const updated: UserRecord = {
    ...existing,
    email: patch.email?.trim() || existing.email,
    name: patch.name?.trim() || existing.name,
    firstName: patch.firstName?.trim() || existing.firstName,
    lastName: patch.lastName?.trim() || existing.lastName,
    role: nextRole,
    includeInSchedule,
    calendarId: patch.calendarId?.trim() || undefined,
    phone: patch.phone?.trim() || undefined,
    extension: patch.extension?.trim() || undefined,
    permissions: nextPerms,
    passwordHash: patch.password ? hashPassword(patch.password) : existing.passwordHash,
    updatedAt: new Date().toISOString()
  };
  users[idx] = updated;
  await writeJson(USERS_PATH, { users });
  return updated;
}

export async function deleteUser(id: string): Promise<void> {
  const users = await listUsers();
  await writeJson(USERS_PATH, { users: users.filter(u => u.id !== id) });
}

export async function verifyPassword(email: string, password: string): Promise<UserRecord | null> {
  const user = await getUserByEmail(email);
  if (!user) return null;
  if (!verifyPasswordHash(password, user.passwordHash)) return null;
  return user;
}

export async function createSession(userId: string): Promise<SessionRecord> {
  const data = await readJson<SessionsFile>(SESSIONS_PATH, { sessions: [] });
  const token = randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  const next = { token, userId, expiresAt };
  await writeJson(SESSIONS_PATH, { sessions: [...(data.sessions ?? []), next] });
  return next;
}

export async function getSession(token: string): Promise<SessionRecord | null> {
  const data = await readJson<SessionsFile>(SESSIONS_PATH, { sessions: [] });
  const now = Date.now();
  const valid = (data.sessions ?? []).filter(s => new Date(s.expiresAt).getTime() > now);
  if (valid.length !== (data.sessions ?? []).length) {
    await writeJson(SESSIONS_PATH, { sessions: valid });
  }
  return valid.find(s => s.token === token) ?? null;
}

export async function deleteSession(token: string): Promise<void> {
  const data = await readJson<SessionsFile>(SESSIONS_PATH, { sessions: [] });
  const remaining = (data.sessions ?? []).filter(s => s.token !== token);
  await writeJson(SESSIONS_PATH, { sessions: remaining });
}

export async function deleteSessionsForUser(userId: string): Promise<void> {
  const data = await readJson<SessionsFile>(SESSIONS_PATH, { sessions: [] });
  const remaining = (data.sessions ?? []).filter(s => s.userId !== userId);
  await writeJson(SESSIONS_PATH, { sessions: remaining });
}

export async function createPasswordResetForEmail(
  email: string
): Promise<{ user: UserRecord | null; token?: string; expiresAt?: string }> {
  const normalizedEmail = String(email ?? "").trim().toLowerCase();
  if (!normalizedEmail) return { user: null };
  const user = await getUserByEmail(normalizedEmail);
  const active = await listActivePasswordResets();
  if (!user) {
    if (active.length > 0) await writePasswordResets(active);
    return { user: null };
  }
  const now = new Date();
  const token = randomBytes(32).toString("hex");
  const expiresAtIso = new Date(now.getTime() + PASSWORD_RESET_TTL_MS).toISOString();
  const tokenHash = hashResetToken(token);
  const next: PasswordResetRecord = {
    tokenHash,
    userId: user.id,
    createdAt: now.toISOString(),
    expiresAt: expiresAtIso
  };
  const kept = active.filter(r => r.userId !== user.id);
  kept.push(next);
  await writePasswordResets(kept);
  return { user, token, expiresAt: expiresAtIso };
}

export async function resetPasswordWithToken(
  token: string,
  password: string
): Promise<UserRecord | null> {
  const rawToken = String(token ?? "").trim();
  const nextPassword = String(password ?? "");
  if (!rawToken || !nextPassword) return null;
  const active = await listActivePasswordResets();
  const tokenHash = hashResetToken(rawToken);
  const match = active.find(r => r.tokenHash === tokenHash) ?? null;
  if (!match) {
    await writePasswordResets(active);
    return null;
  }
  const user = await getUserById(match.userId);
  if (!user) {
    const remaining = active.filter(r => r.tokenHash !== tokenHash);
    await writePasswordResets(remaining);
    return null;
  }
  const updated = await updateUser(user.id, { password: nextPassword });
  const remaining = active.filter(r => r.userId !== user.id);
  await writePasswordResets(remaining);
  await deleteSessionsForUser(user.id);
  return updated;
}
