// services/api/src/connectors/crm/tlpPlaywright.ts
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";

export type TlpLogCustomerContactArgs = {
  leadRef: string;          // Ref #
  phone?: string;            // customer phone fallback for quick lookup
  note: string;             // compiled transcript
  categoryValue?: string;   // default: "MOTORCYCLES"
  contactedValue?: "YES" | "NO"; // default: "YES"
};

export type TlpDealershipVisitDeliveredDetails = {
  firstName?: string;
  lastName?: string;
  phone?: string;
  email?: string;
  condition?: string;
  year?: string;
  manufacturer?: string;
  model?: string;
  color?: string;
  stockId?: string;
  vin?: string;
  salespersonName?: string;
  productCategoryValue?: string;
};

export type TlpDealershipVisitDeliveredArgs = {
  leadRef: string;
  phone?: string;
  note: string;
  details?: TlpDealershipVisitDeliveredDetails;
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const DEFAULT_TIMEOUT_MS = Number(process.env.TLP_TIMEOUT_MS ?? 45_000);
const SHORT_TIMEOUT_MS = Number(process.env.TLP_SHORT_TIMEOUT_MS ?? 15_000);
const NAV_TIMEOUT_MS = Number(process.env.TLP_NAV_TIMEOUT_MS ?? 60_000);
const DEBUG = process.env.TLP_DEBUG !== "0";
const DEBUG_DIR = process.env.TLP_DEBUG_DIR ?? "/tmp/tlp-debug";

type StepFn = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeDigits(value: string | undefined): string {
  return String(value ?? "").replace(/\D+/g, "");
}

async function captureDebugArtifacts(page: Page, step: string) {
  if (!DEBUG) return;
  try {
    await mkdir(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeStep = sanitizeLabel(step || "unknown");
    const base = resolve(DEBUG_DIR, `tlp_${ts}_${safeStep}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    const html = await page.content();
    await writeFile(`${base}.html`, html, "utf8");
  } catch {
    // ignore debug capture failures
  }
}

async function withBrowser<T>(fn: (browser: Browser) => Promise<T>): Promise<T> {
  const headless = (process.env.TLP_HEADLESS ?? "true").toLowerCase() === "true";
  const browser = await chromium.launch({ headless });
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

async function loginTlp(page: Page, step: StepFn) {
  const baseUrl = process.env.TLP_BASE_URL ?? "https://tlpcrm.com";
  const username = env("TLP_USERNAME");
  const password = env("TLP_PASSWORD");

  await step("login: goto", async () => {
    await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    try {
      await page.waitForLoadState("networkidle", { timeout: SHORT_TIMEOUT_MS });
    } catch {
      // best-effort
    }
  });

  // Login fields: try robust selectors
  const userField = page
    .locator('input[type="email"], input[name="email"], input[name="username"], input#Email, input#Username')
    .first();
  const passField = page.locator('input[type="password"], input[name="password"], input#Password').first();

  await step("login: wait user field", async () => {
    await userField.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
  await step("login: fill username", async () => {
    await userField.fill(username);
  });
  await step("login: fill password", async () => {
    await passField.fill(password);
  });

  // Submit
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  await step("login: submit", async () => {
    await submit.click();
  });

  // Wait for the quick lookup ref field (this is your known stable selector)
  await step("login: wait #QL_Ref", async () => {
    await page.locator("#QL_Ref").waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
}

async function findVisibleRowByDigits(page: Page, digits: string): Promise<Locator | null> {
  if (digits.length < 5) return null;
  const frames = page.frames();
  for (const frame of frames) {
    const rows = frame.locator("tr, [role='row']");
    const count = Math.min(await rows.count().catch(() => 0), 100);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const visible = await row.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await row.innerText().catch(() => "");
      if (normalizeDigits(text).includes(digits)) return row;
    }
  }
  return null;
}

async function findVisibleRowByRefAndPhone(page: Page, leadRef: string, phoneDigits: string): Promise<Locator | null> {
  if (!leadRef || phoneDigits.length < 7) return null;
  const refPattern = new RegExp(`(^|\\D)${escapeRegexLiteral(leadRef)}(\\D|$)`);
  const frames = page.frames();
  for (const frame of frames) {
    const rows = frame.locator("tr, [role='row']");
    const count = Math.min(await rows.count().catch(() => 0), 100);
    for (let i = 0; i < count; i++) {
      const row = rows.nth(i);
      const visible = await row.isVisible().catch(() => false);
      if (!visible) continue;
      const text = await row.innerText().catch(() => "");
      if (refPattern.test(text) && normalizeDigits(text).includes(phoneDigits)) return row;
    }
  }
  return null;
}

async function waitForLeadResultRow(page: Page, searchText: string, step: StepFn, searchLabel = "ref"): Promise<Locator> {
  try {
    await page.waitForLoadState("networkidle", { timeout: SHORT_TIMEOUT_MS });
  } catch {
    // Quick lookup often updates the table without a full network-idle state.
  }

  const rowSelectors = [
    'tr[id^="NOTEPAD_DATUM_"]',
    'tr[id*="NOTEPAD_DATUM"]',
    'tr:has(ul.pencilOnly a.action1)',
    'tr:has(a[title="Open Lead Actions Menu"])',
    'tr:has(td.actionListing.action_dt)'
  ];
  const refPattern = new RegExp(`(^|\\D)${escapeRegexLiteral(searchText)}(\\D|$)`);
  const searchDigits = normalizeDigits(searchText);
  const startedAt = Date.now();
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  let lastError = "";

  while (Date.now() < deadline) {
    const frames = page.frames();
    const frameLocators = frames.flatMap(frame => [
      frame.locator("tr").filter({ hasText: refPattern }).first(),
      frame.locator('[role="row"]').filter({ hasText: refPattern }).first()
    ]);
    const refRowLocators = [
      page.locator("tr").filter({ hasText: refPattern }).first(),
      page.locator('[role="row"]').filter({ hasText: refPattern }).first(),
      ...frameLocators
    ];

    for (const row of refRowLocators) {
      try {
        await row.waitFor({ state: "visible", timeout: 1500 });
        return row;
      } catch (err: any) {
        lastError = err?.message ?? String(err);
      }
    }

    const digitsRow = await findVisibleRowByDigits(page, searchDigits);
    if (digitsRow) return digitsRow;

    for (const selector of rowSelectors) {
      const locators = [page.locator(selector).first(), ...frames.map(frame => frame.locator(selector).first())];
      for (const row of locators) {
        try {
          await row.waitFor({ state: "visible", timeout: 1500 });
          return row;
        } catch (err: any) {
          lastError = err?.message ?? String(err);
        }
      }
    }

    let noResultVisible = await page
      .locator("text=/No matching records|No data available|No records found|No results/i")
      .first()
      .isVisible()
      .catch(() => false);
    if (!noResultVisible) {
      for (const frame of frames) {
        noResultVisible = await frame
          .locator("text=/No matching records|No data available|No records found|No results/i")
          .first()
          .isVisible()
          .catch(() => false);
        if (noResultVisible) break;
      }
    }
    if (noResultVisible && Date.now() - startedAt > 3000) {
      throw new Error(`lead: no quick-lookup result for ${searchLabel} ${searchText}`);
    }
    await page.waitForTimeout(500);
  }

  throw new Error(
    `lead: no visible quick-lookup row for ${searchLabel} ${searchText}; tried row text match plus ${rowSelectors.join(", ")}${
      lastError ? `; last error: ${lastError}` : ""
    }`
  );
}

async function waitForLeadResultRowByRefAndPhone(
  page: Page,
  leadRef: string,
  phoneDigits: string,
  step: StepFn
): Promise<Locator> {
  try {
    await page.waitForLoadState("networkidle", { timeout: SHORT_TIMEOUT_MS });
  } catch {
    // Quick lookup often updates the table without a full network-idle state.
  }

  const startedAt = Date.now();
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const row = await findVisibleRowByRefAndPhone(page, leadRef, phoneDigits);
    if (row) return row;

    const noResultVisible = await page
      .locator("text=/No matching records|No data available|No records found|No results/i")
      .first()
      .isVisible()
      .catch(() => false);
    if (noResultVisible && Date.now() - startedAt > 3000) {
      throw new Error(`lead: no quick-lookup result matching ref ${leadRef} and phone ${phoneDigits}`);
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`lead: no visible quick-lookup row matching ref ${leadRef} and phone ${phoneDigits}`);
}

async function findLeadActionsMenu(row: Locator): Promise<Locator | null> {
  const scopedSelectors = [
    "ul.pencilOnly a.action1[title='Open Lead Actions Menu']",
    'a[title="Open Lead Actions Menu"]',
    'a[title*="Lead Actions"]',
    'a[title*="Actions"]',
    "a.action1",
    'button[title*="Actions"]',
    '[role="button"][title*="Actions"]',
    '[aria-label*="Actions"]'
  ];
  for (const selector of scopedSelectors) {
    const candidate = row.locator(selector).first();
    try {
      await candidate.waitFor({ state: "visible", timeout: 1200 });
      return candidate;
    } catch {
      // try next selector
    }
  }
  return null;
}

async function clearQuickLookupFields(page: Page, step: StepFn) {
  await step("lead: clear quick lookup fields", async () => {
    const selectors = [
      "#QL_FirstName",
      "#QL_LastName",
      "#QL_Phone",
      "#QL_Email",
      "#QL_Ref",
      "input[name='QL_FirstName']",
      "input[name='QL_LastName']",
      "input[name='QL_Phone']",
      "input[name='QL_Email']",
      "input[name='QL_Ref']"
    ];
    for (const selector of selectors) {
      const field = page.locator(selector).first();
      try {
        if (await field.isVisible({ timeout: 200 })) await field.fill("");
      } catch {
        // keep clearing known quick lookup fields
      }
    }
    await page.evaluate(() => {
      const doc = (globalThis as any).document;
      const ref = doc?.querySelector?.("#QL_Ref, input[name='QL_Ref'], input[placeholder*='Ref']");
      if (!ref) return;
      const allInputs = Array.from(doc.querySelectorAll("input") ?? []) as any[];
      const refIndex = allInputs.indexOf(ref);
      const candidates = allInputs.filter((input, index) => {
        if (refIndex >= 0 && index > refIndex) return false;
        const rect = input.getBoundingClientRect?.();
        const style = (globalThis as any).getComputedStyle?.(input);
        return (
          style?.visibility !== "hidden" &&
          style?.display !== "none" &&
          (rect?.width ?? 0) > 40 &&
          (rect?.height ?? 0) > 20
        );
      });
      for (const input of candidates) {
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
    });
  });
}

async function findQuickLookupInput(
  page: Page,
  fieldLabel: "ref" | "phone",
  selectors: string[]
): Promise<Locator | null> {
  const direct = await firstVisibleLocator(page, selectors);
  if (direct || fieldLabel !== "phone") return direct;

  const tagged = await page
    .evaluate(() => {
      const doc = (globalThis as any).document;
      const previous = doc?.querySelector?.("[data-tlp-quick-phone-fallback='1']");
      previous?.removeAttribute?.("data-tlp-quick-phone-fallback");
      const ref = doc?.querySelector?.("#QL_Ref, input[name='QL_Ref'], input[placeholder*='Ref']");
      if (!ref) return false;
      const allInputs = Array.from(doc.querySelectorAll("input") ?? []) as any[];
      const refIndex = allInputs.indexOf(ref);
      if (refIndex < 2) return false;
      const visibleBeforeRef = allInputs.slice(0, refIndex).filter(input => {
        const rect = input.getBoundingClientRect?.();
        const style = (globalThis as any).getComputedStyle?.(input);
        return (
          style?.visibility !== "hidden" &&
          style?.display !== "none" &&
          (rect?.width ?? 0) > 80 &&
          (rect?.height ?? 0) > 20
        );
      });
      const phone = visibleBeforeRef.find(input => /phone/i.test([input.id, input.name, input.placeholder].join(" "))) ??
        visibleBeforeRef[visibleBeforeRef.length - 2];
      if (!phone) return false;
      phone.setAttribute("data-tlp-quick-phone-fallback", "1");
      return true;
    })
    .catch(() => false);
  if (!tagged) return null;

  const fallback = page.locator("[data-tlp-quick-phone-fallback='1']").first();
  try {
    await fallback.waitFor({ state: "visible", timeout: 1200 });
    return fallback;
  } catch {
    return null;
  }
}

async function submitQuickLookupValue(
  page: Page,
  value: string,
  fieldLabel: "ref" | "phone",
  selectors: string[],
  step: StepFn
) {
  await clearQuickLookupFields(page, step);
  const input = await findQuickLookupInput(page, fieldLabel, selectors);
  if (!input) {
    throw new Error(`lead: quick lookup ${fieldLabel} field not found`);
  }
  await step(`lead: fill quick lookup ${fieldLabel}`, async () => {
    await input.click({ force: true });
    await input.fill(value);
  });
  await step(`lead: dispatch quick lookup ${fieldLabel} change`, async () => {
    await input.evaluate((el: any, text) => {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(
        new (globalThis as any).KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter", keyCode: 13 })
      );
    }, value);
  });
  const clicked = await step("lead: submit quick lookup", async () => {
    const selectors = [
      "#QL_Submit",
      "#QL_Search",
      "#QL_Go",
      "#QL_Button",
      "#QL_SearchButton",
      "button[name='QL_Submit']",
      "input[name='QL_Submit']",
      "button[name*='QL']",
      "input[type='button'][name*='QL']",
      "input[type='submit'][name*='QL']",
      "button[id*='QL']",
      "input[type='button'][id*='QL']",
      "input[type='submit'][id*='QL']",
      "button:has-text('Submit')",
      "input[type='button'][value='Submit']",
      "input[type='submit'][value='Submit']"
    ];
    for (const selector of selectors) {
      const control = page.locator(selector).first();
      try {
        await control.waitFor({ state: "visible", timeout: 1200 });
        await control.click({ force: true });
        return true;
      } catch {
        // try next control
      }
    }
    return await input.evaluate((el: any) => {
      const form = el?.closest?.("form") as any;
      if (!form) return false;
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    });
  });

  if (!clicked) {
    await page.waitForTimeout(500);
  } else {
    await page
      .waitForLoadState("domcontentloaded", { timeout: 2500 })
      .catch(() => {});
    if (!page.isClosed()) {
      await page.waitForTimeout(1000);
    }
  }
}

async function submitQuickLookupRef(page: Page, leadRef: string, step: StepFn) {
  await submitQuickLookupValue(page, leadRef, "ref", ["#QL_Ref", "input[name='QL_Ref']", "input[placeholder*='Ref']"], step);
}

async function submitQuickLookupPhone(page: Page, phone: string, step: StepFn) {
  await submitQuickLookupValue(
    page,
    phone,
    "phone",
    ["#QL_Phone", "input[name='QL_Phone']", "input[placeholder*='Phone']", "input[type='tel']"],
    step
  );
}

async function findLeadRowByLookup(page: Page, leadRef: string, phone: string | undefined, step: StepFn): Promise<Locator> {
  const errors: string[] = [];
  try {
    await submitQuickLookupRef(page, leadRef, step);
    return await step("lead: wait quick lookup result row", async () => {
      return await waitForLeadResultRow(page, leadRef, step, "ref");
    });
  } catch (err: any) {
    errors.push(`ref ${leadRef}: ${err?.message ?? err}`);
  }

  const phoneDigits = normalizeDigits(phone);
  if (phoneDigits.length >= 7) {
    try {
      await submitQuickLookupPhone(page, phoneDigits, step);
      return await step("lead: wait quick lookup phone result row", async () => {
        return await waitForLeadResultRowByRefAndPhone(page, leadRef, phoneDigits, step);
      });
    } catch (err: any) {
      errors.push(`phone ${phoneDigits} with ref ${leadRef}: ${err?.message ?? err}`);
    }
  }

  throw new Error(`lead: quick lookup failed; ${errors.join(" | ")}`);
}

async function openLeadByRef(page: Page, leadRef: string, step: StepFn, phone?: string) {
  const row = await findLeadRowByLookup(page, leadRef, phone, step);

  // Click the Open Lead Actions Menu (pencilOnly -> action1)
  const actionCell = row.locator("td.actionListing.action_dt.min-mobile.noxls").first();
  const openActions = await findLeadActionsMenu(row);
  if (!openActions) {
    throw new Error("lead: actions menu not found in quick-lookup row");
  }
  await step("lead: wait actions menu", async () => {
    await openActions.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  });

  let popupVisible = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await step(`lead: open actions menu (attempt ${attempt + 1})`, async () => {
      await openActions.click({ force: true });
    });
    try {
      await step("lead: wait #pencilPopupInner", async () => {
        await page.locator("#pencilPopupInner").waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      });
      popupVisible = true;
      break;
    } catch {
      await step(`lead: click action cell (attempt ${attempt + 1})`, async () => {
        await actionCell.click({ force: true });
      });
    }
  }

  if (!popupVisible) {
    throw new Error("lead: menu did not open (#pencilPopupInner)");
  }

  const bubbleLoader = page.locator("#bubbleLoader");
  try {
    await step("lead: wait #bubbleLoader hidden", async () => {
      await bubbleLoader.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
    });
  } catch {
    // continue even if loader doesn't fully hide
  }

  // Now the bubble option should exist (selector can vary).
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const menuItem = page.locator("#pencilPopupInner #pencilOutboundButton").first();
      await step(`lead: wait outbound button (attempt ${attempt + 1})`, async () => {
        await menuItem.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      });
      await step(`lead: click outbound button (attempt ${attempt + 1})`, async () => {
        await menuItem.click({ force: true });
      });
      clicked = true;
      break;
    } catch {
      // If the menu didn't open, try clicking the action cell and open menu again
      await step(`lead: re-open actions menu (attempt ${attempt + 1})`, async () => {
        await actionCell.click({ force: true });
        await openActions.click({ force: true });
      });
      try {
        const fallback = page.locator("#pencilPopupInner #pencilOutboundButton, text=/Outbound Call/i").first();
        await step(`lead: wait outbound fallback (attempt ${attempt + 1})`, async () => {
          await fallback.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
        });
        await step(`lead: click outbound fallback (attempt ${attempt + 1})`, async () => {
          await fallback.click({ force: true });
        });
        clicked = true;
        break;
      } catch {
        await page.waitForTimeout(300);
      }
    }
  }

  if (!clicked) {
    // Last-resort: use JS to click the outbound call button if present
    const jsClicked = await step("lead: js click outbound button", async () => {
      return await page.evaluate(() => {
        const btn =
          (globalThis as any).document?.querySelector?.("#pencilPopupInner #pencilOutboundButton") ||
          Array.from((globalThis as any).document?.querySelectorAll?.("a") ?? []).find((a: any) =>
            /Outbound Call/i.test(a?.textContent || "")
          );
        if (btn && (btn as any).click) {
          (btn as any).click();
          return true;
        }
        return false;
      });
    });
    if (!jsClicked) {
      throw new Error("TLP menu click failed after retries");
    }
  }

  // Wait for the modal content to be ready by waiting for Submit
  await step("lead: wait #SubmitButton", async () => {
    await page.locator("#SubmitButton").waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
}

async function openDealershipVisitByRef(page: Page, leadRef: string, step: StepFn, phone?: string) {
  const row = await findLeadRowByLookup(page, leadRef, phone, step);

  const actionCell = row.locator("td.actionListing.action_dt.min-mobile.noxls").first();
  const openActions = await findLeadActionsMenu(row);
  if (!openActions) {
    throw new Error("lead: actions menu not found in quick-lookup row");
  }
  await step("lead: wait actions menu", async () => {
    await openActions.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
  });

  let popupVisible = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    await step(`lead: open actions menu (attempt ${attempt + 1})`, async () => {
      await openActions.click({ force: true });
    });
    try {
      await step("lead: wait #pencilPopupInner", async () => {
        await page.locator("#pencilPopupInner").waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      });
      popupVisible = true;
      break;
    } catch {
      await step(`lead: click action cell (attempt ${attempt + 1})`, async () => {
        await actionCell.click({ force: true });
      });
    }
  }
  if (!popupVisible) {
    throw new Error("lead: menu did not open (#pencilPopupInner)");
  }

  const bubbleLoader = page.locator("#bubbleLoader");
  try {
    await step("lead: wait #bubbleLoader hidden", async () => {
      await bubbleLoader.waitFor({ state: "hidden", timeout: SHORT_TIMEOUT_MS });
    });
  } catch {
    // best-effort
  }

  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const visitItem = page
        .locator("#pencilPopupInner")
        .locator("a, button, li")
        .filter({ hasText: /Dealership Visit/i })
        .first();
      await step(`lead: wait dealership visit (attempt ${attempt + 1})`, async () => {
        await visitItem.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
      });
      await step(`lead: click dealership visit (attempt ${attempt + 1})`, async () => {
        await visitItem.click({ force: true });
      });
      clicked = true;
      break;
    } catch {
      await step(`lead: re-open actions menu (attempt ${attempt + 1})`, async () => {
        await actionCell.click({ force: true });
        await openActions.click({ force: true });
      });
      await page.waitForTimeout(300);
    }
  }
  if (!clicked) {
    const jsClicked = await step("lead: js click dealership visit", async () => {
      return await page.evaluate(() => {
        const root = (globalThis as any).document?.querySelector?.("#pencilPopupInner");
        if (!root) return false;
        const btn = Array.from(root.querySelectorAll("a,button,li") ?? []).find((el: any) =>
          /Dealership Visit/i.test(el?.textContent || "")
        );
        if (btn && (btn as any).click) {
          (btn as any).click();
          return true;
        }
        return false;
      });
    });
    if (!jsClicked) throw new Error("lead: dealership visit menu item not found");
  }

  await step("visit: wait delivered form", async () => {
    const deliveredControl = await findVisibleDeliveredControl(page);
    if (deliveredControl) return;
    // Fallback readiness gate when TLP renders steps via hidden select options.
    await page.locator("text=/Purchaser/i").first().waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
}

async function findVisibleDeliveredControl(page: Page) {
  const selectors = [
    'button:has-text("9-Delivered")',
    'a:has-text("9-Delivered")',
    'li:has-text("9-Delivered")',
    '[role="button"]:has-text("9-Delivered")',
    '.btn:has-text("9-Delivered")'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 1200 });
      return locator;
    } catch {
      // try next
    }
  }
  const generic = page
    .locator("button, a, li, div, span")
    .filter({ hasText: /9[-\s]*Delivered/i })
    .first();
  try {
    await generic.waitFor({ state: "visible", timeout: 1200 });
    return generic;
  } catch {
    return null;
  }
}

async function selectDeliveredViaHiddenSelect(page: Page) {
  return await page.evaluate(`(() => {
    const selects = Array.from(globalThis.document?.querySelectorAll?.("select") ?? []);
    for (const select of selects) {
      const options = Array.from(select?.querySelectorAll?.("option") ?? []);
      let delivered = null;
      for (const opt of options) {
        const value = String(opt?.value || "").trim().toLowerCase();
        const text = String(opt?.textContent || "");
        if (value === "s9" || /9[\\s-]*delivered/i.test(text)) {
          delivered = opt;
          break;
        }
      }
      if (!delivered) continue;
      select.value = String(delivered.value || "s9");
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    return false;
  })()`);
}

async function firstVisibleLocator(page: Page, selectors: string[]) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 1200 });
      return locator;
    } catch {
      // keep trying
    }
  }
  return null;
}

function normalizeTextToken(value: string) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
}

async function bestEffortFillText(
  page: Page,
  step: StepFn,
  label: string,
  value: string | undefined,
  selectors: string[]
) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const field = await firstVisibleLocator(page, selectors);
  if (!field) return false;
  await step(`visit: fill ${label}`, async () => {
    await field.click({ force: true });
    await field.fill(text);
  });
  return true;
}

async function bestEffortSelect(
  page: Page,
  step: StepFn,
  label: string,
  value: string | undefined,
  selectors: string[]
) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const field = await firstVisibleLocator(page, selectors);
  if (!field) return false;

  const handled = await step(`visit: select ${label}`, async () => {
    const tag = (await field.evaluate((el: any) => String(el?.tagName ?? "").toLowerCase()).catch(() => "")) || "";
    if (tag === "select") {
      const exact = await field
        .selectOption({ label: text })
        .then(() => true)
        .catch(() => false);
      if (exact) return true;
      const normalizedTarget = normalizeTextToken(text);
      return await field.evaluate((el: any, target) => {
        const select = el as any;
        let option: any = null;
        const options = Array.from(select.options ?? []);
        for (const o of options as any[]) {
          const normalized = String(o?.textContent || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
          if (normalized === target) {
            option = o;
            break;
          }
        }
        if (!option) {
          for (const o of options as any[]) {
            const normalized = String(o?.textContent || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
            if (normalized.includes(target)) {
              option = o;
              break;
            }
          }
        }
        if (!option) return false;
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }, normalizedTarget);
    }

    await field.click({ force: true });
    const menuOption = page
      .locator("li, div[role='option'], span, a")
      .filter({ hasText: new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") })
      .first();
    await menuOption.waitFor({ state: "visible", timeout: SHORT_TIMEOUT_MS });
    await menuOption.click({ force: true });
    return true;
  });
  return !!handled;
}

async function bestEffortSelectFirstNonEmpty(
  page: Page,
  step: StepFn,
  label: string,
  selectors: string[]
) {
  const field = await firstVisibleLocator(page, selectors);
  if (!field) return false;

  const handled = await step(`visit: select first ${label}`, async () => {
    const tag = (await field.evaluate((el: any) => String(el?.tagName ?? "").toLowerCase()).catch(() => "")) || "";
    if (tag !== "select") return false;
    return await field.evaluate((el: any) => {
      const select = el as any;
      const options = Array.from(select.options ?? []);
      const option = (options as any[]).find(o => String(o?.value ?? "").trim() || String(o?.textContent ?? "").trim());
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event("input", { bubbles: true }));
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    });
  });
  return !!handled;
}

async function bestEffortCheckFieldByText(
  page: Page,
  step: StepFn,
  labelText: string
) {
  const escaped = labelText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(escaped, "i");

  const labelCheckbox = page.locator("label").filter({ hasText: regex }).locator("input[type='checkbox']").first();
  try {
    await labelCheckbox.waitFor({ state: "visible", timeout: 1200 });
    const checked = await labelCheckbox.isChecked().catch(() => false);
    if (!checked) {
      await step(`visit: check ${labelText}`, async () => {
        await labelCheckbox.check({ force: true });
      });
    }
    return true;
  } catch {
    // continue to fallback
  }

  const clicked = await page.evaluate(`(() => {
    const target = ${JSON.stringify(labelText)}.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    const root = globalThis.document;
    const nodes = Array.from(root?.querySelectorAll?.("label, div, span, td, li") ?? []);
    for (const node of nodes) {
      const text = String(node?.textContent || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!text || !text.includes(target)) continue;
      const scope = node?.closest?.("tr, li, div, section, fieldset, td") || node?.parentElement || node;
      const checkbox = scope?.querySelector?.("input[type='checkbox']") || node?.querySelector?.("input[type='checkbox']");
      if (!checkbox) continue;
      if (!checkbox.checked) checkbox.click();
      return true;
    }
    return false;
  })()`);

  if (clicked) {
    await step(`visit: check ${labelText} (fallback)`, async () => {
      // noop step for traceability
    });
  }
  return clicked;
}

async function requireCheckedFieldByText(
  page: Page,
  step: StepFn,
  labelText: string
): Promise<void> {
  const ok = await bestEffortCheckFieldByText(page, step, labelText);
  if (!ok) {
    throw new Error(`visit: required checkbox "${labelText}" not found`);
  }
}

async function requireFilledText(
  page: Page,
  step: StepFn,
  label: string,
  value: string | undefined,
  selectors: string[]
): Promise<void> {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`visit: required text value missing for "${label}"`);
  }
  const ok = await bestEffortFillText(page, step, label, text, selectors);
  if (!ok) {
    throw new Error(`visit: required text field "${label}" not found`);
  }
}

async function requireSelectedValue(
  page: Page,
  step: StepFn,
  label: string,
  value: string | undefined,
  selectors: string[]
): Promise<void> {
  const text = String(value ?? "").trim();
  if (!text) {
    throw new Error(`visit: required select value missing for "${label}"`);
  }
  const ok = await bestEffortSelect(page, step, label, text, selectors);
  if (!ok) {
    throw new Error(`visit: required select field "${label}" not found`);
  }
}

function normalizeVehicleCondition(value: string | undefined): string | undefined {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return undefined;
  if (v.includes("used") || v === "u") return "USED";
  if (v.includes("new") || v === "n") return "NEW";
  return undefined;
}

async function fillDealershipVisitDeliveredDetails(
  page: Page,
  step: StepFn,
  details: TlpDealershipVisitDeliveredDetails | undefined
) {
  if (!details) return;

  // TLP dealership-visit forms can vary by account and release.
  // Keep this best-effort so selector drift or optional fields do not block Step 9.
  await bestEffortCheckFieldByText(page, step, "First Name");
  await bestEffortCheckFieldByText(page, step, "Last Name");
  await bestEffortCheckFieldByText(page, step, "Phone");
  await bestEffortCheckFieldByText(page, step, "Email");

  await bestEffortFillText(page, step, "first name", details.firstName, [
    "#TLPLOG_first_name",
    "#first_name",
    "input[name='first_name']",
    "input[name*='first']"
  ]);
  await bestEffortFillText(page, step, "last name", details.lastName, [
    "#TLPLOG_last_name",
    "#last_name",
    "input[name='last_name']",
    "input[name*='last']"
  ]);
  await bestEffortFillText(page, step, "phone", details.phone, [
    "#TLPLOG_phone",
    "#phone",
    "input[name='phone']",
    "input[name*='phone']"
  ]);
  await bestEffortFillText(page, step, "email", details.email, [
    "#TLPLOG_email",
    "#email",
    "input[name='email']",
    "input[type='email']"
  ]);

  const condition = normalizeVehicleCondition(details.condition);
  await bestEffortSelect(page, step, "condition", condition, [
    "#TLPLOG_new_used",
    "#TLPLOG_vehicle_condition",
    "#TLPLOG_product_condition",
    "#TLPLOG_condition",
    "#vehicle_condition",
    "select[name*='new_used']",
    "select[name*='newused']",
    "select[name*='condition']"
  ]);

  const yearText = String(details.year ?? "").trim();
  if (yearText) {
    const yearSelected = await bestEffortSelect(page, step, "year", yearText, [
      "#TLPLOG_vehicle_year",
      "#TLPLOG_year",
      "#TLPLOG_model_year",
      "#vehicle_year",
      "select[placeholder*='Year']",
      "select[name*='year']"
    ]);
    if (!yearSelected) {
      await bestEffortFillText(page, step, "year", yearText, [
        "#TLPLOG_vehicle_year",
        "#TLPLOG_year",
        "#TLPLOG_model_year",
        "#vehicle_year",
        "input[placeholder*='Year']",
        "input[name*='year']"
      ]);
    }
  }

  await bestEffortSelect(page, step, "manufacturer", details.manufacturer, [
    "#TLPLOG_vehicle_make",
    "#TLPLOG_make",
    "#TLPLOG_manufacturer",
    "#vehicle_make",
    "select[placeholder*='Make']",
    "input[placeholder*='Make']",
    "select[name*='make']",
    "select[name*='manufacturer']"
  ]);

  await bestEffortSelect(page, step, "product category", details.productCategoryValue ?? "MOTORCYCLES", [
    "#TLPLOG_product_category",
    "#product_category",
    "select[placeholder*='Category']",
    "select[name*='product_category']",
    "select[name*='category']"
  ]);

  await bestEffortSelect(page, step, "product type", "Motorcycles", [
    "#TLPLOG_product_type",
    "#TLPLOG_vehicle_type",
    "#product_type",
    "#vehicle_type",
    "select[name*='product_type']",
    "select[name*='vehicle_type']",
    "select[name*='type']"
  ]);

  await bestEffortSelect(page, step, "model", details.model, [
    "#TLPLOG_vehicle_model",
    "#TLPLOG_model",
    "#TLPLOG_motorcycle_model",
    "#TLPLOG_product_model",
    "#vehicle_model",
    "select[placeholder*='Model']",
    "input[placeholder*='Model']",
    "select[name*='model']",
    "input[name*='model']"
  ]);

  await bestEffortFillText(page, step, "stock", details.stockId, [
    "#TLPLOG_stock",
    "#TLPLOG_stock_id",
    "#TLPLOG_stock_number",
    "#stock",
    "#stock_number",
    "input[placeholder='Stock Number']",
    "input[placeholder*='Stock']",
    "input[name*='stock']"
  ]);

  await bestEffortFillText(page, step, "vin", details.vin, [
    "#TLPLOG_vin",
    "#TLPLOG_vehicle_vin",
    "#vin",
    "input[placeholder='VIN']",
    "input[placeholder*='VIN']",
    "input[name*='vin']"
  ]);

  await bestEffortFillText(page, step, "color", details.color, [
    "#TLPLOG_color",
    "#TLPLOG_vehicle_color",
    "#color",
    "input[placeholder='Color']",
    "input[placeholder*='Color']",
    "input[name*='color']"
  ]);

  await bestEffortSelect(page, step, "salesperson", details.salespersonName, [
    "#TLPLOG_salesperson",
    "#TLPLOG_salesman",
    "#salesperson",
    "select[name*='salesperson']",
    "select[name*='salesman']",
    "select[name*='owner']"
  ]);

  await bestEffortSelect(page, step, "split deal", "No", [
    "#TLPLOG_split_deal",
    "#split_deal",
    "select[name*='split']"
  ]);

  await bestEffortSelectFirstNonEmpty(page, step, "salesperson role", [
    "#TLPLOG_salesperson_role",
    "#TLPLOG_role",
    "#salesperson_role",
    "select[name*='salesperson_role']",
    "select[name*='role']"
  ]);
}

async function markDeliveredStep(
  page: Page,
  step: StepFn,
  note: string,
  details?: TlpDealershipVisitDeliveredDetails
) {
  await fillDealershipVisitDeliveredDetails(page, step, details);

  await step("visit: set 9-Delivered", async () => {
    const deliveredControl = await findVisibleDeliveredControl(page);
    if (deliveredControl) {
      await deliveredControl.click({ force: true });
      return;
    }
    const setByHiddenSelect = await selectDeliveredViaHiddenSelect(page);
    if (!setByHiddenSelect) {
      throw new Error("visit: could not set 9-Delivered (control/select not found)");
    }
  });

  await fillComments(page, note, step);

  await step("visit: submit log", async () => {
    const submit = await findVisitSubmitControl(page);
    if (submit) {
      await submit.scrollIntoViewIfNeeded().catch(() => {});
      await submit.click({ force: true });
    } else {
      const clicked = await clickVisitSubmitFallback(page);
      if (!clicked) {
        throw new Error("visit: submit button not found");
      }
    }
    await waitForVisitSubmitProcessed(page);
  });
}

async function findVisitSubmitControl(page: Page): Promise<Locator | null> {
  const selectors = [
    "#SubmitButton",
    "#Submit",
    "#submit",
    'button:has-text("SUBMIT LOG")',
    'button:has-text("Submit Log")',
    'button:has-text("Submit")',
    'button:has-text("Save")',
    'button:has-text("Complete")',
    'input[type="submit"]',
    'input[type="button"][value*="Submit"]',
    'input[type="button"][value*="Save"]',
    'input[type="button"][value*="Complete"]',
    '[role="button"]:has-text("Submit")',
    '[role="button"]:has-text("Save")'
  ];
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    try {
      await locator.waitFor({ state: "visible", timeout: 1200 });
      return locator;
    } catch {
      // try next
    }
  }
  return null;
}

async function clickVisitSubmitFallback(page: Page): Promise<boolean> {
  return await page.evaluate(`(() => {
    const doc = globalThis.document;
    const controls = Array.from(doc?.querySelectorAll?.("button,input[type='button'],input[type='submit'],a,[role='button']") ?? []);
    for (const el of controls) {
      const style = globalThis.getComputedStyle?.(el);
      const rect = el.getBoundingClientRect?.();
      const visible = style?.visibility !== "hidden" &&
        style?.display !== "none" &&
        (el.offsetParent !== null || ((rect?.width ?? 0) > 0 && (rect?.height ?? 0) > 0));
      if (!visible) continue;
      const hay = [el.id, el.name, el.value, el.title, el.ariaLabel, el.textContent]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!/(submit|save|complete).*(log|visit|delivered)?|log.*(submit|save|complete)/i.test(hay)) continue;
      if (typeof el.click === "function") {
        el.click();
        return true;
      }
    }
    const form = doc?.querySelector?.("#SEC_Comments")?.closest?.("form") ?? doc?.querySelector?.("form");
    if (form) {
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();
      return true;
    }
    return false;
  })()`);
}

async function collectVisitSubmitFailureDetail(page: Page): Promise<string> {
  return await page
    .evaluate(() => {
      const root = globalThis as any;
      const doc = root.document;
      const isVisible = (el: any) => {
        if (!el) return false;
        const style = root.getComputedStyle?.(el);
        const rect = el.getBoundingClientRect?.();
        return (
          style?.visibility !== "hidden" &&
          style?.display !== "none" &&
          ((rect?.width ?? 0) > 0 || (rect?.height ?? 0) > 0)
        );
      };
      const normalize = (value: any) => String(value ?? "").replace(/\s+/g, " ").trim();
      const messages = new Set<string>();

      const messageNodes = Array.from(
        doc?.querySelectorAll?.(
          ".error,.errors,.invalid-feedback,.validation-error,.field-validation-error,.help-block,.alert,.alert-danger,.has-error,.is-invalid"
        ) ?? []
      );
      for (const node of messageNodes as any[]) {
        if (!isVisible(node)) continue;
        const text = normalize(node.textContent);
        if (text && /(required|invalid|please|missing|select|enter|error)/i.test(text)) messages.add(text);
      }

      const controls = Array.from(doc?.querySelectorAll?.("input,select,textarea") ?? []);
      for (const control of controls as any[]) {
        if (!isVisible(control)) continue;
        const validationMessage = normalize(control.validationMessage);
        if (validationMessage) messages.add(validationMessage);
        const required = control.required || control.getAttribute?.("aria-required") === "true";
        const value = normalize(control.value);
        if (required && !value) {
          const label =
            normalize(control.getAttribute?.("aria-label")) ||
            normalize(control.getAttribute?.("placeholder")) ||
            normalize(control.name) ||
            normalize(control.id) ||
            "required field";
          messages.add(`${label} is required`);
        }
      }

      if (messages.size) return Array.from(messages).slice(0, 5).join(" | ");
      return "";
    })
    .catch(() => "");
}

async function waitForVisitSubmitProcessed(page: Page): Promise<void> {
  try {
    await page.waitForLoadState("networkidle", { timeout: SHORT_TIMEOUT_MS });
  } catch {
    // TLP often updates modals without a full network-idle state.
  }
  await page.waitForTimeout(1500);

  const stillVisible = await findVisitSubmitControl(page);
  const validationVisible = await page
    .locator("text=/required|invalid|please select|please enter|missing/i")
    .first()
    .isVisible()
    .catch(() => false);
  if (stillVisible || validationVisible) {
    const detail = await collectVisitSubmitFailureDetail(page);
    throw new Error(
      detail
        ? `visit: submit blocked or did not close; ${detail}`
        : validationVisible
          ? "visit: submit appears blocked by validation"
          : "visit: submit did not close or advance the log form"
    );
  }
}

async function selectMotorcyclesCategory(page: Page, categoryValue: string, step: StepFn) {
  // Stable selector you provided:
  // <select id="TLPLOG_product_category"> with option value MOTORCYCLES
  const cat = page.locator("#TLPLOG_product_category");
  await step("log: wait #TLPLOG_product_category", async () => {
    await cat.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
  await step("log: select category", async () => {
    await cat.selectOption({ value: categoryValue });
  });
}

async function selectCustomerContacted(page: Page, contactedValue: "YES" | "NO", step: StepFn) {
  // <select id="TLPLOG_comments_contacted"> with option value YES
  const status = page.locator("#TLPLOG_comments_contacted");
  await step("log: wait #TLPLOG_comments_contacted", async () => {
    await status.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
  await step("log: select contacted", async () => {
    await status.selectOption({ value: contactedValue });
  });
}

async function fillComments(page: Page, note: string, step: StepFn) {
  // You provided stable comment selector:
  // #SEC_Comments > div > div  (likely contenteditable)
  const noteBox = page.locator("#SEC_Comments > div > div").first();
  await step("log: wait #SEC_Comments", async () => {
    await noteBox.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
  await step("log: focus comments", async () => {
    await noteBox.click();
  });

  // Select all (Mac = Meta; Windows/Linux = Control)
  const isMac = process.platform === "darwin";
  if (isMac) {
    await page.keyboard.down("Meta");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Meta");
  } else {
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
  }

  await step("log: type comments", async () => {
    await page.keyboard.type(note);
  });
}

async function submitLog(page: Page, step: StepFn) {
  const submit = page.locator("#SubmitButton");
  await step("log: wait #SubmitButton", async () => {
    await submit.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT_MS });
  });
  await step("log: submit", async () => {
    await submit.click();
  });

  // Give the UI a moment to process and close modal
  await page.waitForTimeout(1000);
}

export async function tlpLogCustomerContact(args: TlpLogCustomerContactArgs): Promise<void> {
  const categoryValue = args.categoryValue ?? "MOTORCYCLES";
  const contactedValue: "YES" | "NO" = args.contactedValue ?? "YES";

  await withBrowser(async (browser) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    let currentStep = "init";
    const step: StepFn = async (label, fn) => {
      currentStep = label;
      if (DEBUG) console.log(`[tlp] ${label}`);
      try {
        return await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label}: ${message}`);
      }
    };

    try {
      // 1) Login
      await loginTlp(page, step);

      // 2) Search by Ref # and open Event Customer Contact logging modal
      await openLeadByRef(page, args.leadRef, step, args.phone);

      // 3) Set contact outcome to "Customer Was Contacted"
      await selectCustomerContacted(page, contactedValue, step);

      // 4) Set category to Motorcycles
      await selectMotorcyclesCategory(page, categoryValue, step);

      // 5) Fill latest transcript
      await fillComments(page, args.note, step);

      // 6) Submit
      await submitLog(page, step);
      await context.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[tlp] log failed", { leadRef: args.leadRef, step: currentStep, error: message });
      await captureDebugArtifacts(page, currentStep);
      await context.close();
      throw error;
    }
  });
}

export async function tlpMarkDealershipVisitDelivered(args: TlpDealershipVisitDeliveredArgs): Promise<void> {
  await withBrowser(async (browser) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();
    page.setDefaultTimeout(DEFAULT_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);
    let currentStep = "init";
    const step: StepFn = async (label, fn) => {
      currentStep = label;
      if (DEBUG) console.log(`[tlp] ${label}`);
      try {
        return await fn();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label}: ${message}`);
      }
    };
    try {
      await loginTlp(page, step);
      await openDealershipVisitByRef(page, args.leadRef, step, args.phone ?? args.details?.phone);
      await markDeliveredStep(page, step, args.note, args.details);
      await context.close();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[tlp] delivered mark failed", { leadRef: args.leadRef, step: currentStep, error: message });
      await captureDebugArtifacts(page, currentStep);
      await context.close();
      throw error;
    }
  });
}
