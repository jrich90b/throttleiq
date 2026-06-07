export type WebTextWidgetDepartment = "sales" | "service" | "parts" | "apparel";

export type WebTextWidgetClassification = {
  bucket: "inventory_interest" | "service" | "parts" | "apparel";
  cta: "check_availability" | "service_request" | "parts_request" | "apparel_request";
};

export function normalizeWebTextWidgetDepartment(raw?: string | null): WebTextWidgetDepartment | null {
  const t = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!t) return null;
  if (/\bsales?\b|inventory|bike|motorcycle/.test(t)) return "sales";
  if (/\bservice\b|repair|maintenance|oil change|inspection/.test(t)) return "service";
  if (/\bparts?\b|accessor/.test(t)) return "parts";
  if (/\bapparel\b|motor clothes|motorclothes|clothing|gear|helmet|merch/.test(t)) return "apparel";
  return null;
}

export function webTextWidgetDepartmentLabel(department: WebTextWidgetDepartment): string {
  if (department === "apparel") return "Motor Clothes";
  return department.replace(/^\w/, c => c.toUpperCase());
}

export function webTextWidgetClassification(
  department: WebTextWidgetDepartment
): WebTextWidgetClassification {
  if (department === "service") return { bucket: "service", cta: "service_request" };
  if (department === "parts") return { bucket: "parts", cta: "parts_request" };
  if (department === "apparel") return { bucket: "apparel", cta: "apparel_request" };
  return { bucket: "inventory_interest", cta: "check_availability" };
}

export function webTextWidgetTodoReason(
  department: WebTextWidgetDepartment
): "service" | "parts" | "apparel" | null {
  if (department === "service" || department === "parts" || department === "apparel") {
    return department;
  }
  return null;
}

export function buildWebTextWidgetInboundBody(args: {
  department: WebTextWidgetDepartment;
  name?: string | null;
  message: string;
  pageUrl?: string | null;
  pageTitle?: string | null;
}): string {
  const lines = [
    "WEB TEXT WIDGET",
    `Department: ${webTextWidgetDepartmentLabel(args.department)}`,
    args.name ? `Name: ${args.name}` : "",
    args.pageTitle ? `Page: ${args.pageTitle}` : "",
    args.pageUrl ? `URL: ${args.pageUrl}` : "",
    "",
    "Message:",
    args.message
  ];
  return lines.filter((line, idx) => idx >= 5 || String(line).trim()).join("\n").trim();
}
