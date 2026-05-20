import Link from "next/link";

export default function LeadRiderLandingPage() {
  return (
    <main className="min-h-screen bg-[#090b10] text-white">
      <section className="mx-auto flex min-h-screen w-full max-w-6xl flex-col px-6 py-6">
        <header className="flex items-center justify-between border-b border-white/10 pb-5">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-lg bg-[#f47c20] font-bold text-black">
              LR
            </div>
            <div>
              <div className="text-sm font-semibold tracking-[0.18em] text-[#f5a45a]">LEADRIDER</div>
              <div className="text-xs text-white/55">Dealership AI command system</div>
            </div>
          </div>
          <Link
            className="rounded-md border border-white/20 px-4 py-2 text-sm text-white/85 transition hover:border-[#f47c20] hover:text-white"
            href="/command"
          >
            Command sign in
          </Link>
        </header>

        <div className="grid flex-1 items-center gap-10 py-14 lg:grid-cols-[1.08fr_0.92fr]">
          <div>
            <p className="mb-4 text-sm font-semibold uppercase tracking-[0.22em] text-[#f5a45a]">
              Built for powersports dealers
            </p>
            <h1 className="max-w-3xl text-5xl font-semibold leading-[1.02] tracking-normal md:text-7xl">
              Keep every lead moving without losing the human touch.
            </h1>
            <p className="mt-6 max-w-2xl text-lg leading-8 text-white/68">
              LeadRider helps dealerships manage inbound leads, AI-assisted replies, follow-up tasks,
              appointments, campaigns, and issue review from one focused workspace.
            </p>
            <div className="mt-9 flex flex-wrap gap-3">
              <a
                className="rounded-md bg-[#f47c20] px-5 py-3 text-sm font-semibold text-black transition hover:bg-[#ff963f]"
                href="mailto:support@leadrider.ai?subject=LeadRider demo"
              >
                Request demo
              </a>
              <Link
                className="rounded-md border border-white/20 px-5 py-3 text-sm font-semibold text-white/85 transition hover:border-white/45 hover:text-white"
                href="/privacy"
              >
                Privacy
              </Link>
            </div>
          </div>

          <div className="rounded-lg border border-white/12 bg-[#101722] p-5 shadow-2xl shadow-black/30">
            <div className="mb-5 flex items-center justify-between border-b border-white/10 pb-4">
              <div>
                <div className="text-xs uppercase tracking-[0.18em] text-[#f5a45a]">Live workspace</div>
                <div className="mt-1 text-2xl font-semibold">Dealer operations</div>
              </div>
              <span className="rounded-full bg-emerald-300 px-3 py-1 text-xs font-semibold text-emerald-950">
                Active
              </span>
            </div>
            {[
              ["Inbox", "AI drafts, human review, owner routing"],
              ["Task queue", "Follow-ups, appointment outcomes, support issues"],
              ["Campaigns", "SMS, email, creative, audience lists"],
              ["Command", "Client setup, agreements, agents, approvals"]
            ].map(([title, body]) => (
              <div key={title} className="border-b border-white/10 py-4 last:border-b-0">
                <div className="text-lg font-semibold">{title}</div>
                <div className="mt-1 text-sm text-white/58">{body}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
