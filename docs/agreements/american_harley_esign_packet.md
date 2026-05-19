# American Harley E-Sign Packet

Status: Draft

Use this checklist to send the American Harley dealer agreement for signature.

## Recommended Tool

Use one of:

- DocuSign for the most professional dealer-facing flow.
- Dropbox Sign for a simpler/cheaper first workflow.
- PandaDoc if you want proposal + pricing + signature in one sales document.

Recommendation for the first signed dealer: **DocuSign**.

## Files

Agreement draft:

```text
docs/agreements/american_harley_dealer_agreement_draft.md
```

Final signed PDF storage location:

```text
LeadRider / Dealers / American Harley / Agreements
```

## Fields to Complete Before Sending

- LeadRider legal entity name.
- LeadRider business address.
- American Harley-Davidson legal entity name.
- American Harley-Davidson business address.
- Dealer billing/contact email.
- Setup fee.
- Billing start date.
- Initial term: month-to-month or 12 months.
- Payment method: Stripe card, ACH, or invoice.
- Governing state.
- Venue county/state.
- LeadRider signer name/title.
- American Harley signer name/title.

## Suggested American Harley Starting Terms

- Plan: Starter.
- Monthly fee: `$995/month`.
- Included leads: `250/month`.
- Setup fee: choose one:
  - `$0` first-client launch discount.
  - `$1,500` discounted setup.
  - `$3,000` standard setup.
- Included mass SMS: `1,000 SMS segments/month`.
- SMS overage: `$0.05/segment`.
- MMS overage: `$0.20/message`.
- Initial term: month-to-month for first-client pilot, or 12 months if they are ready to commit.

## Send Workflow

1. Copy the draft agreement into Google Docs or Word.
2. Fill all placeholders.
3. Export as PDF.
4. Upload the PDF to DocuSign.
5. Add signature fields:
   - LeadRider signature.
   - LeadRider name/title/date.
   - American Harley signature.
   - American Harley name/title/date.
6. Add email recipients:
   - LeadRider signer: `[your signing email]`.
   - American Harley signer: `[dealer signer email]`.
7. Email subject:

```text
LeadRider Dealer Services Agreement - American Harley-Davidson
```

8. Email message:

```text
Hi [Name],

Attached is the LeadRider Dealer Services Agreement for American Harley-Davidson.

This covers the platform setup, monthly service, included messaging usage, AI-assisted suggest-mode workflow, and support terms we discussed.

Please review and sign when ready. If you want any business terms adjusted before signature, just let me know.

Thanks,
Joe
```

9. After signing, download the completed PDF.
10. Save the signed PDF to:

```text
LeadRider / Dealers / American Harley / Agreements
```

11. Update the dealer dashboard status to `Signed`.

## After Signature

- Create or confirm Stripe customer.
- Create subscription for selected plan.
- Add billing start date.
- Record agreement effective date.
- Attach signed PDF to dealer record.
- Set platform billing status to `active` once paywall exists.

