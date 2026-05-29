export type InitialEmailInventoryStatus = "in_stock" | "on_hold" | "sold" | "not_found" | "unknown";

export type InitialInventoryEmailSegment = {
  helpLine: string;
  inventoryLine: string;
  buildLine: string;
  visitLine: string;
  actionLine: string;
  extraLine: string;
};

function withIndefiniteArticle(label: string): string {
  const clean = label.trim();
  if (!clean) return "that bike";
  return `${/^[aeiou]/i.test(clean) ? "an" : "a"} ${clean}`;
}

export function buildInitialUnavailableInventorySmsReply(args: {
  model?: string | null;
  status?: InitialEmailInventoryStatus | null;
}): string {
  const model = String(args.model ?? "").trim();
  const subject = model ? withIndefiniteArticle(model) : "that bike";
  if (args.status === "sold") {
    return `Thanks — that ${model || "bike"} is no longer available. I can check similar options, or I can keep an eye out and text you if one comes in.`;
  }
  return `Thanks — I’m not seeing ${subject} in stock right now. I can check similar options, or I can keep an eye out and text you if one comes in.`;
}

export function buildInitialInventoryEmailSegment(args: {
  model?: string | null;
  bookingUrl?: string | null;
  inventoryBrowseUrl?: string | null;
  inventoryNote?: string | null;
  inventoryStatus?: InitialEmailInventoryStatus | null;
  isCustomBuild?: boolean;
  buildInventoryAvailable?: boolean | null;
  isTestRide?: boolean;
  testRideInStock?: boolean;
}): InitialInventoryEmailSegment {
  const model = String(args.model ?? "").trim();
  const bookingLine = args.bookingUrl
    ? `You can book an appointment here: ${args.bookingUrl}`
    : "Just reply with a day and time that works for you.";
  const browseLine = args.inventoryBrowseUrl
    ? `You can view current inventory here: ${args.inventoryBrowseUrl}`
    : "Reply with the year range or budget you want and I can narrow down current options.";
  const status = args.inventoryStatus ?? "unknown";
  const inventoryLine = args.inventoryNote ? `Right now there’s ${args.inventoryNote} available.` : "";

  if (args.isCustomBuild) {
    const hasBuildInventory = args.buildInventoryAvailable === true;
    return {
      helpLine: "I’m happy to help with pricing, options, and availability.",
      inventoryLine,
      buildLine: hasBuildInventory
        ? "We do have one in stock if you’d like to check it out. I can also walk you through build options and next steps."
        : "I can walk you through build options and next steps.",
      visitLine: hasBuildInventory
        ? "If you want to stop in to check it out and go over build options, you can book an appointment below."
        : "If you want to stop in to go over build options, you can book an appointment below.",
      actionLine: bookingLine,
      extraLine: "If a walkaround or extra photos would help, just let me know."
    };
  }

  if (args.isTestRide) {
    const inStock = args.testRideInStock === true;
    return {
      helpLine: "I’m happy to help with pricing, options, and availability.",
      inventoryLine,
      buildLine: "",
      visitLine: inStock
        ? model
          ? "If you want to stop in for a test ride and go over options, you can book an appointment below."
          : "If you want to stop in for a test ride, you can book an appointment below."
        : model
          ? "I don’t want to schedule a test ride on a bike we don’t currently have in stock."
          : "I can line up a test ride once you pick an in-stock bike.",
      actionLine: inStock ? bookingLine : browseLine,
      extraLine: inStock
        ? "If a walkaround or extra photos would help before then, just let me know."
        : "Reply with the exact in-stock bike you want to ride and I’ll line up the test ride."
    };
  }

  if (model && status === "in_stock") {
    return {
      helpLine: "I’m happy to help with pricing, options, and availability.",
      inventoryLine,
      buildLine: "",
      visitLine: "If you want to stop in to check out the bike and go over options, you can book an appointment below.",
      actionLine: bookingLine,
      extraLine: "If a walkaround or extra photos would help, just let me know."
    };
  }

  if (model && status === "on_hold") {
    return {
      helpLine: "I’ll confirm current status, pricing, and similar options for you.",
      inventoryLine: `That ${model} appears to be on hold right now.`,
      buildLine: "",
      visitLine: "If you’re open to similar options, I can help narrow those down.",
      actionLine: browseLine,
      extraLine: "If it frees up, I can follow up with you."
    };
  }

  if (model && (status === "sold" || status === "not_found")) {
    return {
      helpLine: "I’ll check current availability, pricing, and similar options for you.",
      inventoryLine:
        status === "sold"
          ? `That ${model} is no longer available.`
          : `I’m not seeing a ${model} in stock right now.`,
      buildLine: "",
      visitLine: "If you’re open to nearby years or similar bikes, I can help narrow those down.",
      actionLine: browseLine,
      extraLine: "If you want me to keep an eye out for that exact bike, let me know."
    };
  }

  if (model) {
    return {
      helpLine: "I’ll check current availability, pricing, and options for you.",
      inventoryLine,
      buildLine: "",
      visitLine: "If you’re open to current options, I can help narrow those down.",
      actionLine: browseLine,
      extraLine: "If you want me to keep an eye out for that exact bike, let me know."
    };
  }

  return {
    helpLine: "I’m happy to help with pricing, options, and availability.",
    inventoryLine,
    buildLine: "",
    visitLine: "If you want to stop in to go over options, you can book an appointment below.",
    actionLine: bookingLine,
    extraLine: "If a walkaround or extra photos would help, just let me know."
  };
}
