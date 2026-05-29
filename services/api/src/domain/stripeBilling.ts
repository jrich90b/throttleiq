import Stripe from "stripe";
import {
  addActiveClientPaymentIfMissing,
  findActiveClientByStripeCustomerId,
  findActiveClientByStripeSubscriptionId,
  getActiveClient,
  updateActiveClient,
  type ActiveClient
} from "./activeClientStore.js";

export type StripeCheckoutKind = "onboarding" | "setup_fee" | "subscription";

export type StripeBillingStatus = {
  configured: boolean;
  mode: "test" | "live" | "unknown";
  publishableKeyConfigured: boolean;
  webhookConfigured: boolean;
  liveModeAllowed: boolean;
  missing: string[];
};

const PLAN_PRICE_ENV: Record<string, { monthly: string; setup: string }> = {
  starter: {
    monthly: "STRIPE_STARTER_MONTHLY_PRICE_ID",
    setup: "STRIPE_STARTER_SETUP_PRICE_ID"
  },
  growth: {
    monthly: "STRIPE_GROWTH_MONTHLY_PRICE_ID",
    setup: "STRIPE_GROWTH_SETUP_PRICE_ID"
  },
  pro: {
    monthly: "STRIPE_PRO_MONTHLY_PRICE_ID",
    setup: "STRIPE_PRO_SETUP_PRICE_ID"
  }
};

let cachedStripe: Stripe | null = null;
let cachedSecretKey = "";

function stripeSecretKey() {
  return String(process.env.STRIPE_SECRET_KEY ?? "").trim();
}

function stripeModeFromKey(key: string): StripeBillingStatus["mode"] {
  if (key.startsWith("sk_test_")) return "test";
  if (key.startsWith("sk_live_")) return "live";
  return "unknown";
}

export function getStripeBillingStatus(): StripeBillingStatus {
  const key = stripeSecretKey();
  const mode = stripeModeFromKey(key);
  const liveModeAllowed = String(process.env.STRIPE_ALLOW_LIVE_MODE ?? "").trim() === "1";
  const missing: string[] = [];
  if (!key) missing.push("STRIPE_SECRET_KEY");
  if (mode === "live" && !liveModeAllowed) missing.push("STRIPE_ALLOW_LIVE_MODE=1");
  return {
    configured: !!key && (mode !== "live" || liveModeAllowed),
    mode,
    publishableKeyConfigured: !!String(process.env.STRIPE_PUBLISHABLE_KEY ?? "").trim(),
    webhookConfigured: !!String(process.env.STRIPE_WEBHOOK_SECRET ?? "").trim(),
    liveModeAllowed,
    missing
  };
}

function stripeClient() {
  const key = stripeSecretKey();
  if (!key) throw new Error("STRIPE_SECRET_KEY is not configured.");
  const mode = stripeModeFromKey(key);
  if (mode === "live" && String(process.env.STRIPE_ALLOW_LIVE_MODE ?? "").trim() !== "1") {
    throw new Error("Live Stripe key refused. Set STRIPE_ALLOW_LIVE_MODE=1 only after live billing approval.");
  }
  if (!cachedStripe || cachedSecretKey !== key) {
    cachedStripe = new Stripe(key);
    cachedSecretKey = key;
  }
  return cachedStripe;
}

function clean(value: unknown) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function dashboardUrlForCustomer(customerId: string) {
  const mode = getStripeBillingStatus().mode === "live" ? "" : "/test";
  return `https://dashboard.stripe.com${mode}/customers/${encodeURIComponent(customerId)}`;
}

function moneyToCents(value: unknown) {
  const text = clean(value);
  const match = text.match(/-?\d[\d,]*(?:\.\d{1,2})?/);
  if (!match) return 0;
  const dollars = Number(match[0].replace(/,/g, ""));
  return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : 0;
}

function dollars(cents: number, currency = "usd") {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2
  });
}

function planKey(client: ActiveClient) {
  const value = clean(client.plan).toLowerCase();
  if (value.includes("starter")) return "starter";
  if (value.includes("growth")) return "growth";
  if (value.includes("pro")) return "pro";
  return "";
}

function configuredPriceId(client: ActiveClient, type: "monthly" | "setup") {
  const key = planKey(client);
  const envName = key ? PLAN_PRICE_ENV[key]?.[type] : "";
  return envName ? clean(process.env[envName]) : "";
}

function metadata(input: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(input)
      .map(([key, value]) => [key, clean(value)])
      .filter(([, value]) => value)
  ) as Record<string, string>;
}

function commandBaseUrl() {
  return clean(process.env.COMMAND_BASE_URL || process.env.PUBLIC_COMMAND_BASE_URL || process.env.APP_BASE_URL || "https://www.leadrider.ai")
    .replace(/\/+$/, "");
}

function successUrl(client: ActiveClient) {
  const configured = clean(process.env.STRIPE_CHECKOUT_SUCCESS_URL);
  if (configured) return configured;
  return `${commandBaseUrl()}/command/clients?stripe=success&client=${encodeURIComponent(client.id)}`;
}

function cancelUrl(client: ActiveClient) {
  const configured = clean(process.env.STRIPE_CHECKOUT_CANCEL_URL);
  if (configured) return configured;
  return `${commandBaseUrl()}/command/clients?stripe=cancel&client=${encodeURIComponent(client.id)}`;
}

function recurringLineItem(client: ActiveClient): Stripe.Checkout.SessionCreateParams.LineItem | null {
  const price = configuredPriceId(client, "monthly");
  if (price) return { price, quantity: 1 };
  const amount = moneyToCents(client.monthlyFee);
  if (!amount) return null;
  return {
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: amount,
      recurring: { interval: "month" },
      product_data: {
        name: `LeadRider ${client.plan || "Monthly"}`,
        description: [client.dealerName, client.monthlyFee].filter(Boolean).join(" - ")
      }
    }
  };
}

function setupLineItem(client: ActiveClient): Stripe.Checkout.SessionCreateParams.LineItem | null {
  const price = configuredPriceId(client, "setup");
  if (price) return { price, quantity: 1 };
  const amount = moneyToCents(client.setupFee);
  if (!amount) return null;
  return {
    quantity: 1,
    price_data: {
      currency: "usd",
      unit_amount: amount,
      product_data: {
        name: `LeadRider ${client.plan || ""} Setup Fee`.replace(/\s+/g, " ").trim(),
        description: `One-time setup fee for ${client.dealerName}.`
      }
    }
  };
}

function checkoutMode(kind: StripeCheckoutKind, hasMonthly: boolean) {
  if (kind === "subscription") return "subscription";
  if (kind === "setup_fee") return "payment";
  return hasMonthly ? "subscription" : "payment";
}

function isLineItem(item: Stripe.Checkout.SessionCreateParams.LineItem | null): item is Stripe.Checkout.SessionCreateParams.LineItem {
  return !!item;
}

async function ensureStripeCustomer(client: ActiveClient) {
  const stripe = stripeClient();
  if (client.stripeCustomerId) return client.stripeCustomerId;
  const customer = await stripe.customers.create({
    name: client.dealerName,
    email: client.billingContactEmail || client.primaryContactEmail || undefined,
    phone: client.billingContactPhone || client.primaryContactPhone || undefined,
    metadata: metadata({
      activeClientId: client.id,
      dealerSetupId: client.dealerSetupId,
      dealerName: client.dealerName
    })
  });
  await updateActiveClient(client.id, {
    stripeMode: getStripeBillingStatus().mode === "live" ? "live" : "test",
    stripeCustomerId: customer.id,
    stripeBillingStatusUpdatedAt: new Date().toISOString()
  });
  return customer.id;
}

export async function createStripeCheckoutForActiveClient(clientId: string, kind: StripeCheckoutKind = "onboarding") {
  const client = await getActiveClient(clientId);
  if (!client) throw new Error("Active client not found.");
  const stripe = stripeClient();
  const customerId = await ensureStripeCustomer(client);
  const monthly = recurringLineItem(client);
  const setup = setupLineItem(client);
  const lineItems = kind === "setup_fee"
    ? [setup].filter(isLineItem)
    : kind === "subscription"
      ? [monthly].filter(isLineItem)
      : [monthly, setup].filter(isLineItem);
  if (!lineItems.length) throw new Error("No Stripe checkout line items could be created. Add a setup fee, monthly fee, or Stripe price IDs.");
  const mode = checkoutMode(kind, !!monthly);
  const baseMetadata = metadata({
    activeClientId: client.id,
    dealerSetupId: client.dealerSetupId,
    dealerName: client.dealerName,
    plan: client.plan,
    checkoutKind: kind
  });

  const session = await stripe.checkout.sessions.create({
    mode,
    customer: customerId,
    line_items: lineItems,
    success_url: successUrl(client),
    cancel_url: cancelUrl(client),
    allow_promotion_codes: true,
    customer_update: { name: "auto", address: "auto" },
    metadata: baseMetadata,
    subscription_data: mode === "subscription" ? { metadata: baseMetadata } : undefined,
    payment_intent_data: mode === "payment" ? { metadata: baseMetadata } : undefined
  });

  const refreshed = await updateActiveClient(client.id, {
    stripeMode: getStripeBillingStatus().mode === "live" ? "live" : "test",
    stripeCustomerId: customerId,
    stripeLatestCheckoutSessionId: session.id,
    stripeLatestCheckoutSessionUrl: session.url ?? undefined,
    stripeLastPaymentStatus: session.payment_status ?? undefined,
    stripeBillingStatusUpdatedAt: new Date().toISOString()
  });

  return {
    client: refreshed,
    checkout: {
      id: session.id,
      url: session.url,
      mode,
      customerId,
      dashboardCustomerUrl: dashboardUrlForCustomer(customerId)
    }
  };
}

function subscriptionPeriodEnd(subscription: Stripe.Subscription) {
  const end = (subscription as any).current_period_end;
  return typeof end === "number" ? new Date(end * 1000).toISOString() : undefined;
}

async function updateClientFromSubscription(subscription: Stripe.Subscription) {
  const customerId = typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id;
  const existing = await findActiveClientByStripeSubscriptionId(subscription.id)
    || (customerId ? await findActiveClientByStripeCustomerId(customerId) : null);
  if (!existing) return null;
  return updateActiveClient(existing.id, {
    stripeMode: getStripeBillingStatus().mode === "live" ? "live" : "test",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscription.id,
    stripeSubscriptionStatus: subscription.status,
    stripeCurrentPeriodEnd: subscriptionPeriodEnd(subscription),
    stripeBillingStatusUpdatedAt: new Date().toISOString()
  });
}

async function recordInvoicePayment(invoice: Stripe.Invoice) {
  const rawInvoice = invoice as any;
  const customerId = typeof rawInvoice.customer === "string" ? rawInvoice.customer : rawInvoice.customer?.id;
  const subscriptionId = typeof rawInvoice.subscription === "string" ? rawInvoice.subscription : rawInvoice.subscription?.id;
  const existing = (subscriptionId ? await findActiveClientByStripeSubscriptionId(subscriptionId) : null)
    || (customerId ? await findActiveClientByStripeCustomerId(customerId) : null);
  if (!existing) return null;
  const amountPaid = typeof rawInvoice.amount_paid === "number" ? rawInvoice.amount_paid : 0;
  const paidAt = typeof rawInvoice.status_transitions?.paid_at === "number"
    ? new Date(rawInvoice.status_transitions.paid_at * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);
  const updated = await updateActiveClient(existing.id, {
    stripeMode: getStripeBillingStatus().mode === "live" ? "live" : "test",
    stripeCustomerId: customerId,
    stripeSubscriptionId: subscriptionId || existing.stripeSubscriptionId,
    stripeLatestInvoiceId: rawInvoice.id,
    stripeLastPaymentStatus: rawInvoice.status,
    stripeBillingStatusUpdatedAt: new Date().toISOString()
  });
  if (amountPaid > 0 && rawInvoice.id) {
    await addActiveClientPaymentIfMissing(existing.id, {
      paidAt,
      amount: dollars(amountPaid, rawInvoice.currency || "usd"),
      method: "stripe",
      reference: rawInvoice.id,
      note: `Stripe invoice ${rawInvoice.status || "paid"}`
    });
  }
  return updated;
}

export async function syncStripeBillingForActiveClient(clientId: string) {
  const client = await getActiveClient(clientId);
  if (!client) throw new Error("Active client not found.");
  const stripe = stripeClient();
  if (!client.stripeCustomerId) {
    const customerId = await ensureStripeCustomer(client);
    const refreshed = await getActiveClient(client.id);
    return { client: refreshed, customerId, subscriptions: [] as Stripe.Subscription[] };
  }
  const subscriptions = await stripe.subscriptions.list({
    customer: client.stripeCustomerId,
    status: "all",
    limit: 10
  });
  const chosen = subscriptions.data.find(row => ["active", "trialing", "past_due"].includes(row.status)) ?? subscriptions.data[0];
  let updated = chosen ? await updateClientFromSubscription(chosen) : await updateActiveClient(client.id, {
    stripeBillingStatusUpdatedAt: new Date().toISOString()
  });
  const invoiceParams: Stripe.InvoiceListParams = {
    customer: client.stripeCustomerId,
    limit: 5
  };
  if (chosen?.id) (invoiceParams as any).subscription = chosen.id;
  const invoices = await stripe.invoices.list(invoiceParams);
  for (const invoice of invoices.data) {
    const paymentStatus = String((invoice as any).status ?? "").toLowerCase();
    if (paymentStatus === "paid" || paymentStatus === "open" || paymentStatus === "uncollectible") {
      updated = await recordInvoicePayment(invoice) ?? updated;
    }
  }
  return {
    client: updated,
    customerId: client.stripeCustomerId,
    subscriptions: subscriptions.data.map(row => ({
      id: row.id,
      status: row.status,
      currentPeriodEnd: subscriptionPeriodEnd(row)
    }))
  };
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string | undefined) {
  const stripe = stripeClient();
  const webhookSecret = clean(process.env.STRIPE_WEBHOOK_SECRET);
  const event = webhookSecret
    ? stripe.webhooks.constructEvent(rawBody, signature || "", webhookSecret)
    : JSON.parse(rawBody.toString("utf8")) as Stripe.Event;

  if (event.type === "checkout.session.completed") {
    const session = event.data.object as Stripe.Checkout.Session;
    const activeClientId = clean(session.metadata?.activeClientId);
    const update: Partial<ActiveClient> = {
      stripeMode: getStripeBillingStatus().mode === "live" ? "live" : "test",
      stripeCustomerId: typeof session.customer === "string" ? session.customer : session.customer?.id,
      stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : session.subscription?.id,
      stripeLatestCheckoutSessionId: session.id,
      stripeLastPaymentStatus: session.payment_status ?? undefined,
      stripeBillingStatusUpdatedAt: new Date().toISOString()
    };
    const client = activeClientId ? await updateActiveClient(activeClientId, update) : null;
    return { eventId: event.id, type: event.type, clientId: client?.id ?? (activeClientId || null) };
  }

  if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const client = await updateClientFromSubscription(event.data.object as Stripe.Subscription);
    return { eventId: event.id, type: event.type, clientId: client?.id ?? null };
  }

  if (event.type === "invoice.paid" || event.type === "invoice.payment_succeeded" || event.type === "invoice.payment_failed") {
    const client = await recordInvoicePayment(event.data.object as Stripe.Invoice);
    return { eventId: event.id, type: event.type, clientId: client?.id ?? null };
  }

  return { eventId: event.id, type: event.type, clientId: null };
}
