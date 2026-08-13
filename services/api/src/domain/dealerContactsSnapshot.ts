/**
 * The dealership's OWN contacts, readable SYNCHRONOUSLY.
 *
 * WHY A SNAPSHOT AND NOT A LOOKUP. The identity join (`domain/leadIdentity.ts`) has to know whether
 * an address belongs to the dealership rather than a customer — measured 2026-08-13, a rep's work
 * address sitting in `lead.email` fused 18 unrelated customers into one person. But the three
 * consumers of that join are all SYNCHRONOUS side-effect paths (`pauseRelatedCadencesOnInbound`,
 * the cross-channel suppression walk, and `stopRelatedCadences`), while building the contacts needs
 * two async reads. Making those consumers async would ripple through every caller of
 * `stopRelatedCadences` — a large, risky change to side-effect code for a lookup that changes about
 * as often as the staff roster does.
 *
 * So the async work happens on a refresh and the sync path reads the last good value. Same shape as
 * `dynamicInventoryColorPhrases` in index.ts, lifted out of it so the handler file does not grow a
 * cache.
 *
 * FAIL DIRECTION, stated exactly. The snapshot starts EMPTY, and an empty snapshot makes
 * `resolveLeadIdentity`'s dealer check a no-op — i.e. precisely the behaviour that shipped before
 * 2026-08-13. A cold process, a failed roster read, and a disabled refresh are therefore all
 * "as it was", never worse. When the snapshot IS populated it can only REMOVE a join, and removing
 * a join can only SKIP a cross-thread side effect, never invent one. There is no input to this
 * module that makes the system act on more threads than it does today.
 */
import { collectDealerContacts, EMPTY_DEALER_CONTACTS, type DealerContacts } from "./crossLeadLeak.js";
import { getDealerProfile } from "./dealerProfile.js";
import { listUsers } from "./userStore.js";

const DEFAULT_TTL_MS = 60_000;

let snapshot: DealerContacts = EMPTY_DEALER_CONTACTS;
let expiresAt = 0;
let inFlight: Promise<DealerContacts> | undefined;

/**
 * The last good contacts. Never throws, never blocks — safe to call from any sync path.
 *
 * Stale-while-revalidate: returns what it has NOW and kicks off a background refresh when the TTL
 * has passed. That is what lets this be the default for `resolveLeadIdentity` with no wiring at any
 * call site — nobody has to remember to pass it, and nobody can forget. The first call of a cold
 * process returns the empty set, which is the pre-2026-08-13 behaviour, and the one after the
 * refresh lands is guarded.
 */
export function getDealerContactsSnapshot(): DealerContacts {
  if (Date.now() >= expiresAt) void refreshDealerContactsSnapshot();
  return snapshot;
}

/**
 * Refresh the snapshot, at most once per TTL. Never rejects: a failed roster or profile read keeps
 * the previous value rather than taking an inbound turn down over a contacts lookup.
 *
 * Loaders are injected so this module owns no I/O and the eval can drive it without a store.
 */
export async function refreshDealerContactsSnapshot(
  load: { users: () => Promise<unknown>; dealerProfile: () => Promise<unknown> } = {
    users: listUsers,
    dealerProfile: getDealerProfile
  },
  opts?: { nowMs?: number; ttlMs?: number }
): Promise<DealerContacts> {
  const now = opts?.nowMs ?? Date.now();
  const ttl = opts?.ttlMs ?? DEFAULT_TTL_MS;
  if (now < expiresAt) return snapshot;
  // Collapse concurrent refreshes — inbound turns arrive in bursts and this is two file reads.
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const [users, dealerProfile] = await Promise.all([load.users(), load.dealerProfile()]);
        snapshot = collectDealerContacts({ users, dealerProfile });
        expiresAt = now + ttl;
      } catch (err) {
        console.error("[dealer-contacts] refresh failed; keeping previous snapshot", err);
      } finally {
        inFlight = undefined;
      }
      return snapshot;
    })();
  }
  return inFlight;
}

/** Tests only — return the module to its cold-boot state. */
export function resetDealerContactsSnapshotForTests(): void {
  snapshot = EMPTY_DEALER_CONTACTS;
  expiresAt = 0;
  inFlight = undefined;
}
