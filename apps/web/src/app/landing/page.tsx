import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Bricolage_Grotesque } from "next/font/google";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["500", "700", "800"],
  variable: "--font-marketing"
});

export const metadata: Metadata = {
  title: "LeadRider — AI lead response for powersports dealers",
  description:
    "LeadRider answers every dealership lead in seconds, qualifies it, follows up, and books the appointment — even after close."
};

const DEMO_MAILTO = "mailto:support@leadrider.ai?subject=LeadRider demo";

const heroProof = [
  "First reply in seconds",
  "Works nights and weekends",
  "Opt-out compliance built in"
];

const conversation: Array<{
  from: "lead" | "rider" | "event";
  body: string;
  meta?: string;
}> = [
  { from: "event", body: "New lead — website form · Tuesday 9:41 PM" },
  {
    from: "lead",
    body: "Hi, is the matte-black 2024 cruiser I saw on your site still available?",
    meta: "IN • SMS • Tue 9:41 PM"
  },
  {
    from: "rider",
    body:
      "Hi Mike — This is Alex at Hometown Powersports. Yes — it’s still on the floor. I can set up a time to stop in for a test ride and go over options, or answer anything else you want to know first.",
    meta: "OUT • SMS • Tue 9:41 PM"
  },
  { from: "lead", body: "Could I come by Saturday morning?", meta: "IN • SMS • Tue 9:46 PM" },
  {
    from: "rider",
    body: "Saturday works — we open at 9. Would 10:30 or 11:15 work for a test ride?",
    meta: "OUT • SMS • Tue 9:46 PM"
  },
  { from: "lead", body: "10:30 works", meta: "IN • SMS • Tue 9:52 PM" },
  {
    from: "rider",
    body:
      "You’re set for Saturday at 10:30. I’ll text you a reminder that morning. Anything you want ready when you get here?",
    meta: "OUT • SMS • Tue 9:52 PM"
  },
  { from: "event", body: "Appointment booked — Saturday 10:30 AM · on the calendar" }
];

const steps = [
  {
    title: "A lead comes in",
    body:
      "ADF email, website form, walk-in note, or inbound text — LeadRider picks it up from the systems you already use."
  },
  {
    title: "LeadRider answers in seconds",
    body:
      "It qualifies the customer, answers availability and pricing within your rules, and offers appointment times only when the customer asks."
  },
  {
    title: "Your team takes the handoff",
    body:
      "Appointments land on the calendar, tasks land in the inbox, and staff can take over any thread with one click."
  }
];

const features = [
  {
    title: "Instant lead response",
    body: "Every lead gets a first reply in seconds, by text or email, in your dealership’s voice."
  },
  {
    title: "Inventory watch",
    body: "Customer wants a bike you don’t have yet? LeadRider watches inventory and texts them the moment it lands."
  },
  {
    title: "Appointment booking",
    body: "Test rides and stop-ins land on your calendar with reminders — no back-and-forth."
  },
  {
    title: "Compliance built in",
    body: "Opt-outs honored instantly, suppression lists enforced on every send, no exceptions."
  },
  {
    title: "Campaign Studio",
    body: "SMS, email, and creative campaigns generated from your inventory, events, and offers."
  },
  {
    title: "Human handoff",
    body: "Suggest mode, approvals, and one-click takeover keep your team in control of every thread."
  }
];

const faqs = [
  {
    q: "Will customers know it’s AI?",
    a: "LeadRider introduces itself with your dealership’s name and a real point of contact, and writes the way your best salesperson would. Your staff can step into any conversation at any time, and the customer never has to repeat themselves."
  },
  {
    q: "What does it plug into?",
    a: "ADF lead feeds (OEM and third-party), email, SMS, and Google Calendar. If your leads arrive by ADF email today, going live is mostly configuration — not an IT project."
  },
  {
    q: "Do we stay in control?",
    a: "Yes. Run LeadRider in suggest mode, where staff approve every draft before it sends, or live mode with strict guardrails. Every thread supports instant human takeover."
  },
  {
    q: "How does it handle opt-outs?",
    a: "STOP requests and unsubscribes are honored immediately, confirmed to the customer, and enforced across every future send — texts and email campaigns alike."
  },
  {
    q: "How long does setup take?",
    a: "Most stores are answering leads with LeadRider within days. We configure your lead sources, your voice, and your rules — then you watch it work in suggest mode before letting it ride."
  }
];

const displayFont = "[font-family:var(--font-marketing)]";

export default function LeadRiderLandingPage() {
  return (
    <main className={`${display.variable} lr-marketing min-h-screen bg-[#090b10] text-white`}>
      <div className="mx-auto w-full max-w-6xl px-6">
        <header className="flex items-center justify-between gap-4 border-b border-white/10 py-5">
          <div className="flex items-center gap-3">
            <Image src="/brand/lr-mark.svg" alt="LeadRider" width={40} height={40} priority />
            <span className={`${displayFont} text-[15px] font-bold tracking-[0.16em]`}>
              LEAD<span className="text-[#fb7f04]">RIDER</span>
            </span>
          </div>
          <nav className="hidden items-center gap-7 text-sm text-white/65 md:flex">
            <a className="transition hover:text-white" href="#conversation">
              See it work
            </a>
            <a className="transition hover:text-white" href="#features">
              Features
            </a>
            <a className="transition hover:text-white" href="#faq">
              FAQ
            </a>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              className="rounded-md border border-white/20 px-4 py-2 text-sm text-white/85 transition hover:border-[#fb7f04] hover:text-white"
              href="/command"
            >
              Sign in
            </Link>
            <a
              className="rounded-md bg-[#fb7f04] px-4 py-2 text-sm font-semibold text-[#111827] transition hover:bg-[#ff963f]"
              href={DEMO_MAILTO}
            >
              Book a demo
            </a>
          </div>
        </header>

        <section className="grid items-center gap-12 py-16 lg:grid-cols-[1.05fr_0.95fr] lg:py-20">
          <div>
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-[#fbaf64]">
              AI lead response for powersports dealers
            </p>
            <h1 className={`${displayFont} max-w-2xl text-5xl font-extrabold leading-[1.04] md:text-6xl`}>
              Leads don’t wait for Monday. Neither does LeadRider.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-8 text-white/65">
              LeadRider answers every lead in seconds — by text and email — qualifies it, follows up,
              and books the appointment while your floor is closed.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a
                className="rounded-md bg-[#fb7f04] px-5 py-3 text-sm font-semibold text-[#111827] transition hover:bg-[#ff963f]"
                href={DEMO_MAILTO}
              >
                Book a demo
              </a>
              <a
                className="rounded-md border border-white/20 px-5 py-3 text-sm font-semibold text-white/85 transition hover:border-white/45 hover:text-white"
                href="#conversation"
              >
                See a live conversation
              </a>
            </div>
            <ul className="mt-10 flex flex-wrap gap-x-7 gap-y-3 text-sm text-white/60">
              {heroProof.map((item) => (
                <li key={item} className="flex items-center gap-2.5">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-[#fb7f04]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/12">
            {/* Placeholder reel — swap the source for real dealership footage when it exists */}
            <video
              className="h-full w-full object-cover"
              poster="/landing/hero.jpg"
              controls
              preload="none"
              playsInline
            >
              <source src="/landing/hero-loop.mp4" type="video/mp4" />
            </video>
          </div>
        </section>
      </div>

      <section className="border-y border-white/10 bg-[#0d1320]">
        <div className="mx-auto grid w-full max-w-6xl items-center gap-10 px-6 py-16 lg:grid-cols-2">
          <div className="overflow-hidden rounded-xl border border-white/12">
            <Image
              src="/landing/night.jpg"
              alt="Motorcycle headlight glowing in a dark showroom"
              width={1920}
              height={1080}
              className="h-full w-full object-cover"
            />
          </div>
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-[#fbaf64]">
              Speed wins the sale
            </p>
            <h2 className={`${displayFont} max-w-lg text-3xl font-bold leading-tight md:text-4xl`}>
              Most leads show up when the lights are off.
            </h2>
            <p className="mt-5 max-w-lg leading-7 text-white/65">
              And the first store to answer usually wins the deal. LeadRider texts back instantly,
              in your dealership’s voice, and keeps the conversation moving until your team walks
              in.
            </p>
            <ul className="mt-7 space-y-3 text-sm text-white/75">
              {[
                "Instant first reply to every lead, any hour",
                "Follow-up cadence that never forgets a thread",
                "Clean handoff to your team the moment they’re in"
              ].map((item) => (
                <li key={item} className="flex items-start gap-3">
                  <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[#fb7f04]" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      <section id="conversation" className="mx-auto w-full max-w-6xl scroll-mt-8 px-6 py-16 lg:py-20">
        <div className="grid items-start gap-12 lg:grid-cols-[0.9fr_1.1fr]">
          <div>
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.22em] text-[#fbaf64]">
              See it work
            </p>
            <h2 className={`${displayFont} max-w-md text-3xl font-bold leading-tight md:text-4xl`}>
              This is LeadRider talking to a lead.
            </h2>
            <p className="mt-5 max-w-md leading-7 text-white/65">
              A sample thread, start to booked, exactly as your team sees it in the LeadRider
              inbox — your dealership’s name, your inventory, your voice. The whole exchange
              happens after closing time.
            </p>
            <div className="mt-8 grid grid-cols-3 gap-3">
              {[
                ["9:41 PM", "lead arrives"],
                ["11 min", "to booked"],
                ["0", "staff involved"]
              ].map(([value, label]) => (
                <div key={label} className="rounded-lg border border-white/10 bg-[#0d1320] p-4">
                  <div className={`${displayFont} text-xl font-bold text-[#fb7f04]`}>{value}</div>
                  <div className="mt-1 text-xs text-white/55">{label}</div>
                </div>
              ))}
            </div>
          </div>
          <div className="overflow-hidden rounded-xl border border-white/14 bg-[#0f1827]">
            <div className="flex items-center justify-between gap-3 border-b border-white/10 px-5 py-3.5">
              <div className="flex items-center gap-2.5">
                <Image src="/brand/lr-mark.svg" alt="" width={20} height={20} />
                <span className="text-sm font-semibold text-white/90">Inbox — Mike R.</span>
                <span className="text-xs text-white/45">website lead</span>
              </div>
              <span className="rounded-full bg-[#d9fbe3] px-2.5 py-1 text-xs font-semibold text-[#166534]">
                Booked
              </span>
            </div>
            <div className="space-y-4 p-5">
              {conversation.map((msg, i) =>
                msg.from === "event" ? (
                  <div key={i} className="flex justify-center">
                    <span className="rounded-full border border-[#fb7f04]/35 bg-[#fb7f04]/10 px-3.5 py-1.5 text-center text-xs font-medium text-[#fbaf64]">
                      {msg.body}
                    </span>
                  </div>
                ) : (
                  <div key={i} className={msg.from === "rider" ? "text-right" : ""}>
                    <div className="text-xs text-gray-500">{msg.meta}</div>
                    <div
                      className={`mt-1 inline-block max-w-[85%] rounded-2xl border px-3 py-2 text-left text-sm font-medium leading-6 ${
                        msg.from === "rider"
                          ? "border-blue-600 bg-blue-600 text-white"
                          : "border-gray-200 bg-gray-100 text-gray-900"
                      }`}
                    >
                      {msg.body}
                    </div>
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-white/10 bg-[#0d1320]">
        <div className="mx-auto w-full max-w-6xl px-6 py-16">
          <h2 className={`${displayFont} text-3xl font-bold md:text-4xl`}>How it works</h2>
          <div className="mt-10 grid gap-6 md:grid-cols-3">
            {steps.map((step, i) => (
              <div key={step.title} className="rounded-xl border border-white/10 bg-[#090b10] p-6">
                <div className={`${displayFont} text-sm font-bold text-[#fb7f04]`}>0{i + 1}</div>
                <h3 className={`${displayFont} mt-3 text-xl font-bold`}>{step.title}</h3>
                <p className="mt-3 text-sm leading-6 text-white/60">{step.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section id="features" className="mx-auto w-full max-w-6xl scroll-mt-8 px-6 py-16 lg:py-20">
        <div className="max-w-2xl">
          <h2 className={`${displayFont} text-3xl font-bold md:text-4xl`}>
            Everything between the lead and the handshake.
          </h2>
          <p className="mt-4 leading-7 text-white/65">
            LeadRider runs the unglamorous middle of the sale — the replies, the reminders, the
            scheduling — so your team spends their time on the floor, not the inbox.
          </p>
        </div>
        <div className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-white/10 bg-[#0d1320] p-6 transition hover:border-[#fb7f04]/50"
            >
              <h3 className={`${displayFont} text-lg font-bold`}>{feature.title}</h3>
              <p className="mt-3 text-sm leading-6 text-white/60">{feature.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="relative overflow-hidden border-y border-white/10">
        <Image
          src="/landing/ride.jpg"
          alt="Rider on an open highway at dusk"
          width={1920}
          height={1080}
          className="h-[420px] w-full object-cover"
        />
        <div className="absolute inset-0 flex items-center bg-gradient-to-r from-[#090b10]/90 via-[#090b10]/40 to-transparent">
          <div className="mx-auto w-full max-w-6xl px-6">
            <h2 className={`${displayFont} max-w-lg text-3xl font-bold leading-tight md:text-5xl`}>
              The store closes. The conversations don’t.
            </h2>
            <a
              className="mt-8 inline-block rounded-md bg-[#fb7f04] px-5 py-3 text-sm font-semibold text-[#111827] transition hover:bg-[#ff963f]"
              href={DEMO_MAILTO}
            >
              Book a demo
            </a>
          </div>
        </div>
      </section>

      <section id="faq" className="mx-auto w-full max-w-3xl scroll-mt-8 px-6 py-16 lg:py-20">
        <h2 className={`${displayFont} text-3xl font-bold md:text-4xl`}>Questions dealers ask</h2>
        <div className="mt-8 space-y-3">
          {faqs.map((faq) => (
            <details
              key={faq.q}
              className="group rounded-xl border border-white/10 bg-[#0d1320] px-5 py-4 open:border-[#fb7f04]/40"
            >
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 text-[15px] font-semibold marker:hidden">
                {faq.q}
                <span
                  aria-hidden
                  className="text-[#fb7f04] transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-3 text-sm leading-7 text-white/65">{faq.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="border-t border-white/10 bg-[#0d1320]">
        <div className="mx-auto w-full max-w-6xl px-6 py-16 text-center">
          <h2 className={`${displayFont} mx-auto max-w-xl text-3xl font-bold leading-tight md:text-4xl`}>
            Ready to catch every lead?
          </h2>
          <p className="mx-auto mt-4 max-w-md text-white/60">
            See LeadRider answer your own leads, live, before you commit to anything.
          </p>
          <a
            className="mt-8 inline-block rounded-md bg-[#fb7f04] px-6 py-3.5 text-sm font-semibold text-[#111827] transition hover:bg-[#ff963f]"
            href={DEMO_MAILTO}
          >
            Book a demo
          </a>
        </div>
      </section>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-6 py-10 md:flex-row md:items-center md:justify-between">
          <div className="flex items-center gap-3">
            <Image src="/brand/lr-mark.svg" alt="" width={30} height={30} />
            <div>
              <div className={`${displayFont} text-sm font-bold tracking-[0.16em]`}>
                LEAD<span className="text-[#fb7f04]">RIDER</span>
              </div>
              <div className="text-xs text-white/45">AI lead response for powersports dealers</div>
            </div>
          </div>
          <nav className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm text-white/55">
            <Link className="transition hover:text-white" href="/privacy">
              Privacy
            </Link>
            <Link className="transition hover:text-white" href="/terms">
              Terms
            </Link>
            <Link className="transition hover:text-white" href="/cookies">
              Cookies
            </Link>
            <a className="transition hover:text-white" href="mailto:support@leadrider.ai">
              support@leadrider.ai
            </a>
          </nav>
          <div className="text-xs text-white/40">© 2026 LeadRider</div>
        </div>
      </footer>
    </main>
  );
}
