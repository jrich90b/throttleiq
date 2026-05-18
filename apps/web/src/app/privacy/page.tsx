import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy | Lead Rider",
  description: "Privacy Policy for Lead Rider dealership messaging and campaign tools."
};

const updated = "May 18, 2026";

export default function PrivacyPolicyPage() {
  return (
    <main className="min-h-screen bg-[#f6f3ee] text-[#1f2933]">
      <div className="mx-auto max-w-3xl px-6 py-10">
        <Link href="/" className="text-sm font-semibold text-[#9a3412] hover:underline">
          Back
        </Link>
        <h1 className="mt-6 text-3xl font-semibold tracking-tight">Privacy Policy</h1>
        <p className="mt-2 text-sm text-[#59636f]">Last updated: {updated}</p>

        <section className="mt-8 space-y-4 text-sm leading-6">
          <p>
            Lead Rider helps dealerships manage inbound leads, customer conversations, appointments,
            inventory interest, and marketing campaigns. This policy explains the personal information
            we collect, how we use it, and the choices available to customers and users.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Information We Collect</h2>
          <p>
            We may collect contact details such as name, phone number, email address, lead source,
            vehicle interest, trade or finance context supplied by the customer, appointment details,
            message history, call notes, and related dealership workflow information.
          </p>
          <p>
            We may also collect technical information such as IP address, browser details, device
            identifiers, pages visited, timestamps, and cookie or session data used to secure and
            operate the service.
          </p>

          <h2 className="pt-4 text-xl font-semibold">How We Use Information</h2>
          <p>
            We use information to respond to customer inquiries, send requested calls, texts, emails,
            appointment reminders, inventory updates, campaign messages, support dealership workflows,
            maintain records, secure the service, improve product performance, and comply with legal
            obligations.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Text and Email Communications</h2>
          <p>
            If a customer provides a mobile number or email address, the dealership may contact that
            customer about their inquiry, appointment, vehicle interest, or marketing campaign where
            permitted. Message and data rates may apply. Customers can reply STOP to text messages or
            use unsubscribe links in marketing emails.
          </p>
          <p>
            Text message opt-in data and consent records are used to provide requested dealership
            communications and are not sold or shared with third parties for their own marketing or
            promotional purposes.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Sharing Information</h2>
          <p>
            We may share information with the dealership using Lead Rider and service providers that
            help deliver the service, including messaging, email, hosting, analytics, scheduling, CRM,
            inventory, advertising, and security providers. We do not sell customer conversation
            content as a standalone product.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Cookies and Tracking</h2>
          <p>
            We use necessary cookies for login, security, and preferences. Public landing pages or
            dealership sites may also use analytics or advertising tools such as pixels, depending on
            the dealership configuration. See our <Link href="/cookies" className="font-semibold text-[#9a3412] hover:underline">Cookie Policy</Link>.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Your Choices</h2>
          <p>
            Customers may request access, correction, deletion, or opt-out of marketing where required
            by applicable law. Requests should be directed to the dealership that collected the lead or
            to the service administrator.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Data Security and Retention</h2>
          <p>
            We use reasonable safeguards designed to protect personal information. We retain information
            for as long as needed for dealership operations, legal obligations, security, dispute
            resolution, and service improvement.
          </p>

          <h2 className="pt-4 text-xl font-semibold">Contact</h2>
          <p>
            For privacy questions, contact the dealership using the service or the Lead Rider service
            administrator responsible for your account.
          </p>
        </section>
      </div>
    </main>
  );
}
