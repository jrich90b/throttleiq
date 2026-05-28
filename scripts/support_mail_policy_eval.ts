import {
  classifySupportMailAutoTrash,
  isSupportMailSummarySafeToAutoTrash
} from "../services/api/src/domain/supportMailPolicy.ts";

type Case = {
  id: string;
  expected: boolean;
  run: () => boolean;
};

const oldDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const cases: Case[] = [
  {
    id: "google_workspace_recommendation_auto_trash",
    expected: true,
    run: () =>
      !!classifySupportMailAutoTrash({
        from: "The Google Workspace Team <workspace-noreply@google.com>",
        subject: "Your recommendations: Save time with AI in Google Workspace",
        snippet: "Boost your team's productivity."
      })
  },
  {
    id: "google_workspace_trial_auto_trash",
    expected: true,
    run: () =>
      !!classifySupportMailAutoTrash({
        from: "The Google Workspace Team <workspace-noreply@google.com>",
        subject: "Explore your Google Workspace trial for leadrider.ai",
        snippet: "Explore what you can do with Google Workspace."
      })
  },
  {
    id: "expired_docusign_code_auto_trash",
    expected: true,
    run: () =>
      !!classifySupportMailAutoTrash({
        from: "DocuSign <dse@docusign.net>",
        subject: "Your verification code",
        snippet: "Use this one-time code to continue.",
        date: oldDate
      })
  },
  {
    id: "billing_email_not_auto_trash",
    expected: false,
    run: () =>
      !!classifySupportMailAutoTrash({
        from: "Google Workspace <workspace-noreply@google.com>",
        subject: "Billing information for leadrider.ai",
        snippet: "Your payment method needs attention."
      })
  },
  {
    id: "client_support_request_not_auto_trash",
    expected: false,
    run: () =>
      !!classifySupportMailAutoTrash({
        from: "dealer@example.com",
        subject: "Need help with Twilio",
        snippet: "Customer replies are not showing in LeadRider and we need support."
      })
  },
  {
    id: "claude_non_support_promo_safe_to_trash",
    expected: true,
    run: () =>
      isSupportMailSummarySafeToAutoTrash(
        "Classification: non_support\nSummary: Google Workspace promotional onboarding email."
      )
  },
  {
    id: "claude_non_support_promo_ignores_policy_text",
    expected: true,
    run: () =>
      isSupportMailSummarySafeToAutoTrash(
        "Classification: non_support\nSummary: Google Workspace promotional onboarding email.",
        [
          "Do not use non_support for billing, invoices, payments, security/login, domains/DNS, contracts, API/integration failures, outages, dealer/client/user support, or anything uncertain.",
          "From: The Google Workspace Team <workspace-noreply@google.com>",
          "Subject: Your recommendations: Save time with AI in Google Workspace",
          "Snippet: Boost your team's productivity."
        ].join("\n")
      )
  },
  {
    id: "claude_non_support_billing_not_safe_to_trash",
    expected: false,
    run: () =>
      isSupportMailSummarySafeToAutoTrash(
        "Classification: non_support\nSummary: Automated billing notice about an invoice."
      )
  },
  {
    id: "claude_non_support_integration_not_safe_to_trash",
    expected: false,
    run: () =>
      isSupportMailSummarySafeToAutoTrash(
        "Classification: non_support\nSummary: Automated SendGrid integration failure alert."
      )
  }
];

let failures = 0;
for (const testCase of cases) {
  const actual = testCase.run();
  if (actual !== testCase.expected) {
    failures += 1;
    console.error(`FAIL ${testCase.id}: expected ${testCase.expected}, got ${actual}`);
  } else {
    console.log(`PASS ${testCase.id}`);
  }
}

if (failures > 0) {
  console.error(`${failures} support mail policy eval case(s) failed.`);
  process.exit(1);
}

console.log(`support mail policy eval passed (${cases.length} cases)`);
