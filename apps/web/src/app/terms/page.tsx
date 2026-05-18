import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms of Use | Lead Rider",
  description: "Terms of Use for Lead Rider dealership messaging and campaign tools."
};

const updated = "May 18, 2026";

export default function TermsOfUsePage() {
  return (
    <main className="min-h-screen bg-[#f6f3ee] text-[#1f2933]">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/" className="text-sm font-semibold text-[#9a3412] hover:underline">
          Back
        </Link>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">Terms of Use</h1>
        <p className="mt-2 text-sm text-[#59636f]">Last updated: {updated}</p>

        <section className="mt-8 space-y-4 text-sm leading-6">
          <p>
            These terms govern access to Lead Rider websites, landing pages, and dealership messaging
            tools. By using the service, you agree to use it only for lawful dealership communication
            and related business purposes.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Use of the Service</h2>
          <p>
            Users are responsible for providing accurate information, maintaining the confidentiality
            of account credentials, and complying with applicable laws and communication rules,
            including consent and opt-out requirements for calls, texts, and emails.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Customer Communications</h2>
          <p>
            Dealerships are responsible for the content they send through Lead Rider and for honoring
            customer opt-out, unsubscribe, and privacy requests. Customers may reply STOP to text
            messages to opt out or HELP for assistance.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Content and Availability</h2>
          <p>
            Inventory, pricing, payment, appointment, and campaign information may change and should
            be confirmed with the dealership. We may modify, suspend, or discontinue parts of the
            service as needed for maintenance, security, legal, or business reasons.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Privacy</h2>
          <p>
            Use of the service is also governed by our{" "}
            <Link href="/privacy" className="font-semibold text-[#9a3412] hover:underline">
              Privacy Policy
            </Link>
            .
          </p>

          <h2 className="pt-4 text-xl font-semibold">Contact</h2>
          <p>
            Questions about these terms should be directed to the dealership using the service or the
            Lead Rider service administrator responsible for the account.
          </p>
        </section>
      </div>
    </main>
  );
}
