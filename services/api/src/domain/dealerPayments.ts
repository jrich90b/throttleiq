import { promises as fs } from "node:fs";
import * as path from "node:path";
import crypto from "node:crypto";
import Stripe from "stripe";
import { dataPath } from "./dataDir.js";
import { getDealerProfile, saveDealerProfile, type DealerProfile } from "./dealerProfile.js";

export type DealerPaymentRequestStatus = "open" | "paid" | "expired" | "canceled" | "failed";
export type DealerPaymentChannel = "sms" | "email";

export type DealerPaymentRequest = {
  id: string;
  conversationId: string;
  leadKey?: string;
  leadRef?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  amountCents: number;
  currency: string;
  description: string;
  channel: DealerPaymentChannel;
  status: DealerPaymentRequestStatus;
  stripeAccountId: string;
  stripeMode: "test" | "live" | "unknown";
  stripeCheckoutSessionId?: string;
  stripePaymentIntentId?: string;
  stripeCheckoutUrl?: string;
  createdAt: string;
  updatedAt: string;
  createdByUserId?: string;
  createdByUserName?: string;
  paidAt?: string;
  notifiedAt?: string;
  expiresAt?: string;
  error?: string;
};

export type DealerPaymentStripeStatus = {
  configured: boolean;
  mode: "test" | "live" | "unknown";
  webhookConfigured: boolean;
  liveModeAllowed: boolean;
  connectedAccountId?: string;
  chargesEnabled?: boolean;
  payoutsEnabled?: boolean;
  detailsSubmitted?: boolean;
  cardPaymentsStatus?: string;
  transfersStatus?: string;
  capabilitiesReady?: boolean;
  missing: string[];
};

type DealerPaymentStore = {
  requests: DealerPaymentRequest[];
};

type DealerPaymentCheckoutInput = {
  conversationId: string;
  leadKey?: string;
  leadRef?: string;
  customerName?: string;
  customerPhone?: string;
  customerEmail?: string;
  amountCents: number;
  currency?: string;
  description: string;
  channel?: DealerPaymentChannel;
  createdByUserId?: string;
  createdByUserName?: string;
};

const STORE_PATH = process.env.DEALER_PAYMENT_REQUESTS_PATH || dataPath("dealer_payment_requests.json");

let cachedStripe: Stripe | null = null;
let cachedSecretKey = "";

const DEALER_PAYMENT_CAPABILITIES = {
  card_payments: { requested: true },
  transfers: { requested: true }
} as const;

function clean(value: unknown, max = 1000) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function stripeSecretKey() {
  return clean(process.env.STRIPE_SECRET_KEY, 300);
}

function stripeModeFromKey(key: string): DealerPaymentStripeStatus["mode"] {
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return "unknown";
}

function stripeClient() {
  const key = stripeSecretKey();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  const mode = stripeModeFromKey(key);
  if (mode === "live" && String(process.env.STRIPE_ALLOW_LIVE_MODE ?? "").trim() !== "1") {
    throw new Error("Live Stripe key refused. Set STRIPE_ALLOW_LIVE_MODE=1 only after live payments approval.");
  }
  if (!cachedStripe || cachedSecretKey !== key) {
    cachedStripe = new Stripe(key);
    cachedSecretKey = key;
  }
  return cachedStripe;
}

function connectedAccountIdFromProfile(profile?: DealerProfile | null) {
  const stripe = (profile as any)?.payments?.stripe ?? {};
  return clean(
    stripe.connectedAccountId ??
      stripe.accountId ??
      stripe.stripeAccountId ??
      (profile as any)?.stripeConnectedAccountId ??
      (profile as any)?.stripeAccountId,
    160
  );
}

function profileStripePatch(profile: DealerProfile, patch: Record<string, unknown>): DealerProfile {
  const currentPayments = ((profile as any)?.payments ?? {}) as Record<string, any>;
  const currentStripe = (currentPayments.stripe ?? {}) as Record<string, any>;
  return {
    ...profile,
    payments: {
      ...currentPayments,
      stripe: {
        ...currentStripe,
        ...patch,
        updatedAt: new Date().toISOString()
      }
    }
  } as DealerProfile;
}

function accountCapabilityStatus(account: Stripe.Account, key: "card_payments" | "transfers") {
  return clean((account.capabilities as Record<string, unknown> | undefined)?.[key], 80) || "unrequested";
}

function accountStripePatch(account: Stripe.Account) {
  const cardPaymentsStatus = accountCapabilityStatus(account, "card_payments");
  const transfersStatus = accountCapabilityStatus(account, "transfers");
  const capabilitiesReady = cardPaymentsStatus === "active" && transfersStatus === "active";
  return {
    connectedAccountId: account.id,
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    cardPaymentsStatus,
    transfersStatus,
    capabilitiesReady
  };
}

async function retrieveDealerPaymentAccount(stripe: Stripe, accountId: string) {
  return await stripe.accounts.update(accountId, {
    capabilities: DEALER_PAYMENT_CAPABILITIES
  });
}

function commandBaseUrl() {
  return clean(
    process.env.APP_BASE_URL ||
      process.env.COMMAND_BASE_URL ||
      process.env.PUBLIC_COMMAND_BASE_URL ||
      "https://www.leadrider.ai",
    500
  ).replace(/\/+$/, "");
}

function publicApiBaseUrl() {
  return clean(
    process.env.PUBLIC_BASE_URL ||
      process.env.PUBLIC_API_BASE_URL ||
      process.env.LEADRIDER_API_BASE_URL ||
      process.env.API_BASE_URL ||
      "https://api.leadrider.ai",
    500
  ).replace(/\/+$/, "");
}

function successUrl(requestId: string) {
  const configured = clean(process.env.STRIPE_DEALER_PAYMENT_SUCCESS_URL, 500);
  if (configured) return configured;
  return `${commandBaseUrl()}/?section=inbox&payment=success&paymentRequest=${encodeURIComponent(requestId)}`;
}

function cancelUrl(requestId: string) {
  const configured = clean(process.env.STRIPE_DEALER_PAYMENT_CANCEL_URL, 500);
  if (configured) return configured;
  return `${commandBaseUrl()}/?section=inbox&payment=cancel&paymentRequest=${encodeURIComponent(requestId)}`;
}

function metadata(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key, clean(value, 500)])
      .filter(([, value]) => value)
  ) as Record<string, string>;
}

function formatMoney(cents: number, currency = "usd") {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2
  });
}

export function parseDealerPaymentAmountCents(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 0 && value < 100000000 ? Math.round(value) : 0;
  }
  const text = clean(value, 80);
  const match = text.match(/\d[\d,]*(?:\.\d{1,2})?/);
  if (!match) return 0;
  const dollars = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(dollars) && dollars > 0 && dollars < 1000000
    ? Math.round(dollars * 100)
    : 0;
}

function normalizeCurrency(value: unknown) {
  const currency = clean(value || "usd", 10).toLowerCase();
  return /^[a-z]{3}$/.test(currency) ? currency : "usd";
}

function normalizeChannel(value: unknown): DealerPaymentChannel {
  return clean(value, 20).toLowerCase() === "email" ? "email" : "sms";
}

async function readStore(): Promise<DealerPaymentStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw) as Partial<DealerPaymentStore>;
    return { requests: Array.isArray(parsed.requests) ? parsed.requests : [] };
  } catch {
    return { requests: [] };
  }
}

async function writeStore(store: DealerPaymentStore) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  const tmp = `${STORE_PATH}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  await fs.rename(tmp, STORE_PATH);
}

export async function listDealerPaymentRequests(filters?: {
  conversationId?: string;
  status?: DealerPaymentRequestStatus;
}): Promise<DealerPaymentRequest[]> {
  const store = await readStore();
  return store.requests
    .filter(req => !filters?.conversationId || req.conversationId === filters.conversationId)
    .filter(req => !filters?.status || req.status === filters.status)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function getDealerPaymentRequest(id: string): Promise<DealerPaymentRequest | null> {
  const requestId = clean(id, 160);
  if (!requestId) return null;
  const store = await readStore();
  return store.requests.find(row => row.id === requestId) ?? null;
}

export function formatDealerPaymentAmount(request: Pick<DealerPaymentRequest, "amountCents" | "currency">) {
  return formatMoney(request.amountCents, request.currency);
}

async function upsertDealerPaymentRequest(request: DealerPaymentRequest) {
  const store = await readStore();
  const idx = store.requests.findIndex(row => row.id === request.id);
  if (idx >= 0) store.requests[idx] = request;
  else store.requests.push(request);
  await writeStore(store);
  return request;
}

export async function updateDealerPaymentRequest(
  id: string,
  patch: Partial<DealerPaymentRequest>
): Promise<DealerPaymentRequest | null> {
  const store = await readStore();
  const idx = store.requests.findIndex(row => row.id === id);
  if (idx < 0) return null;
  const updated = {
    ...store.requests[idx],
    ...patch,
    updatedAt: new Date().toISOString()
  };
  store.requests[idx] = updated;
  await writeStore(store);
  return updated;
}

export function getDealerPaymentStripeStatus(profile?: DealerProfile | null): DealerPaymentStripeStatus {
  const key = stripeSecretKey();
  const mode = stripeModeFromKey(key);
  const liveModeAllowed = String(process.env.STRIPE_ALLOW_LIVE_MODE ?? "").trim() === "1";
  const connectedAccountId = connectedAccountIdFromProfile(profile);
  const stripeProfile = (profile as any)?.payments?.stripe ?? {};
  const cardPaymentsStatus = clean(stripeProfile.cardPaymentsStatus, 80) || undefined;
  const transfersStatus = clean(stripeProfile.transfersStatus, 80) || undefined;
  const capabilitiesReady = cardPaymentsStatus === "active" && transfersStatus === "active";
  const missing: string[] = [];
  if (!key) missing.push("STRIPE_SECRET_KEY");
  if (mode === "live" && !liveModeAllowed) missing.push("STRIPE_ALLOW_LIVE_MODE=1");
  if (!connectedAccountId) missing.push("dealer payments Stripe connected account");
  if (connectedAccountId && cardPaymentsStatus !== "active") missing.push("card_payments capability active");
  if (connectedAccountId && transfersStatus !== "active") missing.push("transfers capability active");
  return {
    configured: !!key && !!connectedAccountId && capabilitiesReady && (mode !== "live" || liveModeAllowed),
    mode,
    webhookConfigured: !!clean(process.env.STRIPE_WEBHOOK_SECRET, 300),
    liveModeAllowed,
    connectedAccountId: connectedAccountId || undefined,
    chargesEnabled: stripeProfile.chargesEnabled === true,
    payoutsEnabled: stripeProfile.payoutsEnabled === true,
    detailsSubmitted: stripeProfile.detailsSubmitted === true,
    cardPaymentsStatus,
    transfersStatus,
    capabilitiesReady,
    missing
  };
}

export async function createDealerPaymentConnectLink(input: {
  refreshUrl?: string;
  returnUrl?: string;
} = {}) {
  const profile = (await getDealerProfile()) ?? {};
  const status = getDealerPaymentStripeStatus(profile);
  const stripe = stripeClient();
  let accountId = status.connectedAccountId;

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      email: clean(profile.replyToEmail || profile.fromEmail, 320) || undefined,
      business_type: "company",
      capabilities: DEALER_PAYMENT_CAPABILITIES,
      business_profile: {
        name: clean(profile.dealerName, 120) || undefined,
        url: clean(profile.website, 500) || undefined
      },
      metadata: metadata({
        dealerName: profile.dealerName,
        source: "leadrider_dealer_payments"
      })
    });
    accountId = account.id;
    await saveDealerProfile(
      profileStripePatch(profile, {
        enabled: true,
        ...accountStripePatch(account)
      })
    );
  }

  const account = await retrieveDealerPaymentAccount(stripe, accountId);
  await saveDealerProfile(
    profileStripePatch((await getDealerProfile()) ?? profile, {
      enabled: true,
      ...accountStripePatch(account)
    })
  );
  const base = commandBaseUrl();
  const link = await stripe.accountLinks.create({
    account: account.id,
    refresh_url: input.refreshUrl || `${base}/?section=settings&stripe=refresh`,
    return_url: input.returnUrl || `${base}/?section=settings&stripe=connected`,
    type: "account_onboarding"
  });
  return {
    url: link.url,
    accountId: account.id,
    chargesEnabled: account.charges_enabled === true,
    payoutsEnabled: account.payouts_enabled === true,
    detailsSubmitted: account.details_submitted === true,
    cardPaymentsStatus: accountCapabilityStatus(account, "card_payments"),
    transfersStatus: accountCapabilityStatus(account, "transfers")
  };
}

export async function refreshDealerPaymentStripeAccount() {
  const profile = (await getDealerProfile()) ?? {};
  const accountId = connectedAccountIdFromProfile(profile);
  if (!accountId) return { profile, account: null };
  const account = await retrieveDealerPaymentAccount(stripeClient(), accountId);
  const saved = await saveDealerProfile(
    profileStripePatch(profile, {
      enabled: true,
      ...accountStripePatch(account)
    })
  );
  return { profile: saved, account };
}

export async function createDealerPaymentCheckout(input: DealerPaymentCheckoutInput) {
  let profile = (await getDealerProfile()) ?? {};
  let status = getDealerPaymentStripeStatus(profile);
  if (status.connectedAccountId) {
    const refreshed = await refreshDealerPaymentStripeAccount();
    profile = refreshed.profile;
    status = getDealerPaymentStripeStatus(profile);
  }
  if (!status.configured || !status.connectedAccountId) {
    throw new Error(`Dealer Stripe payments are not ready: ${status.missing.join(", ") || "unknown setup issue"}.`);
  }
  const amountCents = parseDealerPaymentAmountCents(input.amountCents);
  if (amountCents <= 0) throw new Error("Payment amount must be greater than $0.");
  const description = clean(input.description, 240);
  if (!description) throw new Error("Payment description is required.");
  const currency = normalizeCurrency(input.currency);
  const channel = normalizeChannel(input.channel);
  const now = new Date().toISOString();
  const request: DealerPaymentRequest = {
    id: crypto.randomUUID(),
    conversationId: clean(input.conversationId, 160),
    leadKey: clean(input.leadKey, 160) || undefined,
    leadRef: clean(input.leadRef, 80) || undefined,
    customerName: clean(input.customerName, 160) || undefined,
    customerPhone: clean(input.customerPhone, 80) || undefined,
    customerEmail: clean(input.customerEmail, 320) || undefined,
    amountCents,
    currency,
    description,
    channel,
    status: "open",
    stripeAccountId: status.connectedAccountId,
    stripeMode: status.mode,
    createdAt: now,
    updatedAt: now,
    createdByUserId: clean(input.createdByUserId, 120) || undefined,
    createdByUserName: clean(input.createdByUserName, 160) || undefined
  };
  if (!request.conversationId) throw new Error("Conversation is required for a payment request.");
  await upsertDealerPaymentRequest(request);

  const baseMetadata = metadata({
    dealerPaymentRequestId: request.id,
    conversationId: request.conversationId,
    leadKey: request.leadKey,
    leadRef: request.leadRef,
    source: "leadrider_dealer_payment"
  });
  const session = await stripeClient().checkout.sessions.create(
    {
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency,
            unit_amount: amountCents,
            product_data: {
              name: description,
              description: [profile.dealerName, request.customerName].filter(Boolean).join(" - ") || undefined
            }
          }
        }
      ],
      customer_email: request.customerEmail && request.customerEmail.includes("@") ? request.customerEmail : undefined,
      phone_number_collection: request.customerPhone ? { enabled: true } : undefined,
      success_url: successUrl(request.id),
      cancel_url: cancelUrl(request.id),
      metadata: baseMetadata,
      payment_intent_data: { metadata: baseMetadata }
    },
    { stripeAccount: status.connectedAccountId }
  );

  const expiresAt =
    typeof session.expires_at === "number" ? new Date(session.expires_at * 1000).toISOString() : undefined;
  const updated = await updateDealerPaymentRequest(request.id, {
    stripeCheckoutSessionId: session.id,
    stripeCheckoutUrl: session.url ?? undefined,
    status: session.status === "expired" ? "expired" : "open",
    expiresAt
  });
  const finalRequest = updated ?? request;
  return {
    request: finalRequest,
    checkoutUrl: session.url,
    suggestedMessage: buildDealerPaymentSuggestedMessage(finalRequest)
  };
}

export async function syncDealerPaymentRequestsWithStripe(filters?: {
  conversationId?: string;
}): Promise<{ requests: DealerPaymentRequest[]; updated: DealerPaymentRequest[] }> {
  const requests = await listDealerPaymentRequests(filters);
  const updated: DealerPaymentRequest[] = [];
  const openRequests = requests.filter(
    request => request.status === "open" && request.stripeCheckoutSessionId && request.stripeAccountId
  );
  if (!openRequests.length) return { requests, updated };
  let stripe: Stripe;
  try {
    stripe = stripeClient();
  } catch {
    return { requests, updated };
  }
  const byId = new Map(requests.map(request => [request.id, request]));
  for (const request of openRequests) {
    try {
      const session = await stripe.checkout.sessions.retrieve(
        request.stripeCheckoutSessionId!,
        {},
        { stripeAccount: request.stripeAccountId }
      );
      const paymentIntentId =
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : session.payment_intent?.id;
      const paid = session.payment_status === "paid" || session.status === "complete";
      const expired = session.status === "expired";
      if (!paid && !expired) continue;
      const synced = await updateDealerPaymentRequest(request.id, {
        status: paid ? "paid" : "expired",
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: paymentIntentId,
        paidAt: paid ? request.paidAt || new Date().toISOString() : undefined,
        expiresAt:
          typeof session.expires_at === "number"
            ? new Date(session.expires_at * 1000).toISOString()
            : request.expiresAt
      });
      if (synced) {
        byId.set(synced.id, synced);
        updated.push(synced);
      }
    } catch (err) {
      // Keep listing payment requests even if Stripe has a transient retrieval issue.
    }
  }
  return {
    requests: Array.from(byId.values()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))),
    updated
  };
}

export function dealerPaymentPublicUrl(request: DealerPaymentRequest) {
  const requestId = clean(request.id, 160);
  if (!requestId) return "";
  return `${publicApiBaseUrl()}/public/pay/${encodeURIComponent(requestId)}`;
}

export function buildDealerPaymentSuggestedMessage(request: DealerPaymentRequest) {
  const amount = formatMoney(request.amountCents, request.currency);
  const url = dealerPaymentPublicUrl(request) || clean(request.stripeCheckoutUrl, 4000);
  const description = clean(request.description, 180);
  const prefix =
    request.channel === "email"
      ? `Here is the secure payment link for ${description} (${amount}):`
      : `Here is the secure payment link for ${description} (${amount}):`;
  return [prefix, url].filter(Boolean).join("\n");
}

export async function handleDealerPaymentStripeEvent(event: Stripe.Event) {
  if (
    event.type !== "checkout.session.completed" &&
    event.type !== "checkout.session.expired" &&
    event.type !== "payment_intent.payment_failed"
  ) {
    return null;
  }
  const object = event.data.object as any;
  const requestId = clean(object?.metadata?.dealerPaymentRequestId, 120);
  if (!requestId) return null;

  if (event.type === "checkout.session.completed") {
    const session = object as Stripe.Checkout.Session;
    const paymentIntentId =
      typeof session.payment_intent === "string"
        ? session.payment_intent
        : session.payment_intent?.id;
    const paid = session.payment_status === "paid" || session.status === "complete";
    const request = await updateDealerPaymentRequest(requestId, {
      status: paid ? "paid" : "open",
      stripeCheckoutSessionId: session.id,
      stripePaymentIntentId: paymentIntentId,
      paidAt: paid ? new Date().toISOString() : undefined
    });
    return { eventId: event.id, type: event.type, dealerPaymentRequestId: request?.id ?? requestId };
  }

  if (event.type === "checkout.session.expired") {
    const request = await updateDealerPaymentRequest(requestId, {
      status: "expired",
      stripeCheckoutSessionId: clean(object?.id, 160) || undefined
    });
    return { eventId: event.id, type: event.type, dealerPaymentRequestId: request?.id ?? requestId };
  }

  const request = await updateDealerPaymentRequest(requestId, {
    status: "failed",
    stripePaymentIntentId: clean(object?.id, 160) || undefined,
    error: clean(object?.last_payment_error?.message ?? "Stripe payment failed.", 500)
  });
  return { eventId: event.id, type: event.type, dealerPaymentRequestId: request?.id ?? requestId };
}
