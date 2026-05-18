import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Cookie Policy | Lead Rider",
  description: "Cookie Policy for Lead Rider dealership messaging and campaign tools."
};

const updated = "May 18, 2026";

export default function CookiePolicyPage() {
  return (
    <main className="min-h-screen bg-[#f6f3ee] text-[#1f2933]">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/" className="text-sm font-semibold text-[#9a3412] hover:underline">
          Back
        </Link>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">Cookie Policy</h1>
        <p className="mt-2 text-sm text-[#59636f]">Last updated: {updated}</p>

        <section className="mt-8 space-y-4 text-sm leading-6">
          <p>
            Cookies and similar technologies help Lead Rider operate securely, remember preferences,
            understand product usage, and support dealership marketing when configured.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Types of Cookies</h2>
          <p>
            Necessary cookies support authentication, session security, routing, form protection, and
            basic product functionality. These cookies are required for the service to work.
          </p>
          <p>
            Analytics cookies may help measure page visits, feature usage, and performance. Advertising
            or pixel technologies may help dealerships measure campaigns or deliver relevant ads when
            those tools are installed on public pages.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Your Choices</h2>
          <p>
            You can control cookies through browser settings. If a public site uses optional analytics
            or advertising cookies, it should provide a cookie notice or preference control before those
            tools are used where required by law.
          </p>

          <h2 className="pt-4 text-xl font-semibold">More Information</h2>
          <p>
            See the <Link href="/privacy" className="font-semibold text-[#9a3412] hover:underline">Privacy Policy</Link> for more detail about information collection and use.
          </p>
        </section>
      </div>
    </main>
  );
}
