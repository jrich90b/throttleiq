export type Channel = "sms" | "email" | "web";

export type LeadStage =
  | "NEW"
  | "ENGAGED"
  | "QUALIFIED"
  | "APPOINTMENT_SET"
  | "SHOWED"
  | "NEGOTIATION"
  | "WON"
  | "LOST";

export type LeadIntent =
  | "AVAILABILITY"
  | "PRICING"
  | "FINANCING"
  | "TRADE_IN"
  | "TEST_RIDE"
  | "SPECS"
  | "GENERAL"
  | "UNSURE";

export type InboundMessageEvent = {
  channel: Channel;
  provider: "twilio" | "sendgrid_adf" | "sendgrid" | "debug" | "voice_transcript";
  from: string;
  to: string;
  body: string;
  providerMessageId?: string;
  receivedAt: string;
};

export type OrchestratorResult = {
  intent: LeadIntent;
  stage: LeadStage;
  shouldRespond: boolean;
  draft: string;
  smallTalk?: boolean;
  handoff?: { required: boolean; reason: "pricing" | "payments" | "approval" | "manager" | "other"; ack: string };
  autoClose?: { reason: "international" | "corporate" | "other" };
  pricingAttempted?: boolean;
  paymentsAnswered?: boolean;
  suggestedSlots?: any[];
  requestedTime?: { year: number; month: number; day: number; hour24: number; minute: number; dayOfWeek: string } | null;
  requestedAppointmentType?: string;
  memorySummary?: string | null;
  pickupUpdate?: {
    stage?: "need_town" | "need_street" | "need_time" | "ready";
    town?: string;
    street?: string;
    preferredTimeText?: string;
    distanceMiles?: number;
    eligible?: boolean;
  };
};
