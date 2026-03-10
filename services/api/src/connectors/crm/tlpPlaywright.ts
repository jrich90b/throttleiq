// services/api/src/connectors/crm/tlpPlaywright.ts
import { chromium, type Browser, type Page } from "playwright";

export type TlpLogCustomerContactArgs = {
  leadRef: string;          // Ref #
  note: string;             // compiled transcript
  categoryValue?: string;   // default: "MOTORCYCLES"
};

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
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

async function loginTlp(page: Page) {
  const baseUrl = process.env.TLP_BASE_URL ?? "https://tlpcrm.com";
  const username = env("TLP_USERNAME");
  const password = env("TLP_PASSWORD");

  await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });

  // Login fields: try robust selectors
  const userField = page
    .locator('input[type="email"], input[name="email"], input[name="username"], input#Email, input#Username')
    .first();
  const passField = page.locator('input[type="password"], input[name="password"], input#Password').first();

  await userField.waitFor({ state: "visible", timeout: 30_000 });
  await userField.fill(username);
  await passField.fill(password);

  // Submit
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  await submit.click();

  // Wait for the quick lookup ref field (this is your known stable selector)
  await page.locator("#QL_Ref").waitFor({ state: "visible", timeout: 30_000 });
}

async function openLeadByRef(page: Page, leadRef: string) {
  const refInput = page.locator("#QL_Ref");
  await refInput.fill(leadRef);
  await refInput.press("Enter");

  // Wait for a results row to appear.
  // You showed row ids like NOTEPAD_DATUM_<hash>, so use prefix selector.
  const row = page.locator('tr[id^="NOTEPAD_DATUM_"]').first();
  await row.waitFor({ state: "visible", timeout: 20_000 });

  // Click the Open Lead Actions Menu (pencilOnly -> action1)
  const actionCell = row.locator("td.actionListing.action_dt.min-mobile.noxls").first();
  const openActions = row
    .locator("ul.pencilOnly a.action1[title='Open Lead Actions Menu']")
    .first();
  await openActions.waitFor({ state: "visible", timeout: 10_000 });
  await openActions.click();
  await openActions.waitFor({ state: "visible", timeout: 10_000 });
  await openActions.click();

  // If the bubble backdrop/loader is intercepting clicks, dismiss it before selecting the menu item.
  const bubbleBackdrop = page.locator("#bubbleBackdrop");
  const bubbleLoader = page.locator("#bubbleLoader");
  try {
    if (await bubbleBackdrop.isVisible({ timeout: 1000 })) {
      await bubbleBackdrop.click({ force: true });
      await bubbleBackdrop.waitFor({ state: "hidden", timeout: 8_000 });
    }
  } catch {
    // best-effort: continue even if we couldn't dismiss the backdrop
  }
  try {
    await bubbleLoader.waitFor({ state: "hidden", timeout: 8_000 });
  } catch {
    // continue even if loader doesn't fully hide
  }

  // Now the bubble option should exist (selector can vary).
  let clicked = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const menuItem = page.locator("#pencilPopupInner #pencilEventButton").first();
      await menuItem.waitFor({ state: "visible", timeout: 10_000 });
      await menuItem.click({ force: true });
      clicked = true;
      break;
    } catch {
      // If the menu didn't open, try clicking the action cell and open menu again
      await actionCell.click({ force: true });
      await openActions.click({ force: true });
      try {
        const fallback = page.locator("#pencilPopupInner #pencilEventButton, text=/Event Customer Contact/i").first();
        await fallback.waitFor({ state: "visible", timeout: 10_000 });
        await fallback.click({ force: true });
        clicked = true;
        break;
      } catch {
        await page.waitForTimeout(300);
      }
    }
  }

  if (!clicked) {
    // Last-resort: use JS to click the event button if present
    const jsClicked = await page.evaluate(() => {
      const btn =
        (globalThis as any).document?.querySelector?.("#pencilPopupInner #pencilEventButton") ||
        Array.from((globalThis as any).document?.querySelectorAll?.("a") ?? []).find((a: any) =>
          /Event Customer Contact/i.test(a?.textContent || "")
        );
      if (btn && (btn as any).click) {
        (btn as any).click();
        return true;
      }
      return false;
    });
    if (!jsClicked) {
      throw new Error("TLP menu click failed after retries");
    }
  }

  // Wait for the modal content to be ready by waiting for Submit
  await page.locator("#SubmitButton").waitFor({ state: "visible", timeout: 15_000 });
}

async function selectMotorcyclesCategory(page: Page, categoryValue: string) {
  // Stable selector you provided:
  // <select id="TLPLOG_product_category"> with option value MOTORCYCLES
  const cat = page.locator("#TLPLOG_product_category");
  await cat.waitFor({ state: "visible", timeout: 15_000 });
  await cat.selectOption({ value: categoryValue });
}

async function fillComments(page: Page, note: string) {
  // You provided stable comment selector:
  // #SEC_Comments > div > div  (likely contenteditable)
  const noteBox = page.locator("#SEC_Comments > div > div").first();
  await noteBox.waitFor({ state: "visible", timeout: 15_000 });

  await noteBox.click();

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

  await page.keyboard.type(note);
}

async function submitLog(page: Page) {
  const submit = page.locator("#SubmitButton");
  await submit.waitFor({ state: "visible", timeout: 15_000 });
  await submit.click();

  // Give the UI a moment to process and close modal
  await page.waitForTimeout(1000);
}

export async function tlpLogCustomerContact(args: TlpLogCustomerContactArgs): Promise<void> {
  const categoryValue = args.categoryValue ?? "MOTORCYCLES";

  await withBrowser(async (browser) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    });
    const page = await context.newPage();

    // 1) Login
    await loginTlp(page);

    // 2) Search by Ref # and open Event Customer Contact logging modal
    await openLeadByRef(page, args.leadRef);

    // 3) Set category to Motorcycles
    await selectMotorcyclesCategory(page, categoryValue);

    // 4) Fill latest transcript
    await fillComments(page, args.note);

    // 5) Submit
    await submitLog(page);
    await context.close();
  });
}
