export type SideNavIconName =
  | "pipeline"
  | "inbox"
  | "todos"
  | "contacts"
  | "suppressions"
  | "calendar"
  | "inventory"
  | "watches"
  | "campaigns"
  | "mdf"
  | "kpi"
  | "questions"
  | "settings"
  | "menu"
  | "edit"
  | "trash"
  | "paperclip"
  | "phone"
  | "chat"
  | "user"
  | "mic"
  | "thumbsUp"
  | "thumbsDown"
  | "close"
  | "check"
  | "flame"
  | "thermo"
  | "snowflake"
  | "clock"
  | "bell"
  | "bolt"
  | "tag"
  | "creditCard";

export function SideNavIcon({ name, className = "w-5 h-5" }: { name: SideNavIconName; className?: string }) {
  const commonProps = {
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.9,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true
  };

  if (name === "pipeline") {
    return (
      <svg {...commonProps}>
        <path d="M4 5h16l-5.5 6.5V18l-5 2v-8.5L4 5Z" />
      </svg>
    );
  }
  if (name === "inbox") {
    return (
      <svg {...commonProps}>
        <path d="M3 11.5 5.6 6a2 2 0 0 1 1.8-1.1h9.2a2 2 0 0 1 1.8 1.1L21 11.5v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <path d="M3 12h5l1.8 2h4.4L16 12h5" />
      </svg>
    );
  }
  if (name === "todos") {
    return (
      <svg {...commonProps}>
        <rect x="4" y="3.5" width="16" height="17" rx="2.5" />
        <path d="m8 12 2.1 2.1L16 8.3" />
        <path d="M8 17h8" />
      </svg>
    );
  }
  if (name === "contacts") {
    return (
      <svg {...commonProps}>
        <circle cx="9" cy="9" r="2.5" />
        <path d="M4.5 17a4.5 4.5 0 0 1 9 0" />
        <circle cx="16.5" cy="10" r="2" />
        <path d="M14 17.5a3.5 3.5 0 0 1 6.5-1.6" />
      </svg>
    );
  }
  if (name === "suppressions") {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8" />
        <path d="m7.2 16.8 9.6-9.6" />
      </svg>
    );
  }
  if (name === "calendar") {
    return (
      <svg {...commonProps}>
        <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
        <path d="M7 3.5V7M17 3.5V7M3.5 9.5h17" />
        <path d="M8.5 13h3.5v3.5H8.5z" />
      </svg>
    );
  }
  if (name === "inventory") {
    return (
      <svg {...commonProps}>
        <circle cx="6.5" cy="17.5" r="2.4" />
        <circle cx="17.5" cy="17.5" r="2.4" />
        <path d="M9 17.5h4.8l-2.2-4.2h3.2l2.7 4.2" />
        <path d="M11.5 13.3 9.6 9.7H7" />
      </svg>
    );
  }
  if (name === "watches") {
    return (
      <svg {...commonProps}>
        <path d="M2.5 12s3.5-5.5 9.5-5.5 9.5 5.5 9.5 5.5-3.5 5.5-9.5 5.5-9.5-5.5-9.5-5.5z" />
        <circle cx="12" cy="12" r="2.3" />
      </svg>
    );
  }
  if (name === "campaigns") {
    return (
      <svg {...commonProps}>
        <path d="M4 13.5V10l10-4v12L4 14z" />
        <path d="M14 10h2.2a3.8 3.8 0 0 1 0 7.6H14" />
        <path d="M7.5 14.5 9 20h3" />
      </svg>
    );
  }
  if (name === "mdf") {
    return (
      <svg {...commonProps}>
        <path d="M6 3.5h8l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 20z" />
        <path d="M14 3.5V8h4" />
        <path d="M8.5 12h7M8.5 15h7M8.5 18h4" />
      </svg>
    );
  }
  if (name === "kpi") {
    return (
      <svg {...commonProps}>
        <path d="M4 18.5h16" />
        <path d="M6 16V11M11 16V8M16 16v-4" />
        <path d="m5.5 9.5 4-3.2 4 2.2 4.5-4.3" />
      </svg>
    );
  }
  if (name === "questions" || name === "bell") {
    return (
      <svg {...commonProps}>
        <path d="M18 8.5a6 6 0 0 0-12 0c0 2-1 3.5-2 4.5h16c-1-1-2-2.5-2-4.5Z" />
        <path d="M9.5 17.5a2.5 2.5 0 0 0 5 0" />
      </svg>
    );
  }
  if (name === "menu") {
    return (
      <svg {...commonProps}>
        <path d="M4 7h16M4 12h16M4 17h16" />
      </svg>
    );
  }
  if (name === "edit") {
    return (
      <svg {...commonProps}>
        <path d="m16.7 4.1 3.2 3.2L8.6 18.6l-4.3 1.1 1.1-4.3z" />
        <path d="m14.4 6.4 3.2 3.2" />
      </svg>
    );
  }
  if (name === "trash") {
    return (
      <svg {...commonProps}>
        <path d="M5 6.8h14" />
        <path d="M9.3 6.8V5.4A1.4 1.4 0 0 1 10.7 4h2.6a1.4 1.4 0 0 1 1.4 1.4v1.4" />
        <path d="m6.6 6.8.8 11.7A1.7 1.7 0 0 0 9.1 20h5.8a1.7 1.7 0 0 0 1.7-1.5l.8-11.7" />
        <path d="M10.1 10.5v6M13.9 10.5v6" />
      </svg>
    );
  }
  if (name === "paperclip") {
    return (
      <svg {...commonProps}>
        <path d="m19.5 11.7-7.6 7.6a4.8 4.8 0 0 1-6.8-6.8l7.9-7.9a3.2 3.2 0 0 1 4.5 4.5l-7.7 7.7a1.6 1.6 0 0 1-2.3-2.3l7-7" />
      </svg>
    );
  }
  if (name === "phone") {
    return (
      <svg {...commonProps}>
        <path d="M5.4 4h3.1l1.5 4.1-2 1.5a12.3 12.3 0 0 0 6.4 6.4l1.5-2L20 15.5v3.1a1.4 1.4 0 0 1-1.6 1.4C11 19.2 4.8 13 4 6.6 3.9 5.2 4.6 4 5.4 4Z" />
      </svg>
    );
  }
  if (name === "chat") {
    return (
      <svg {...commonProps}>
        <path d="M4 6.7A2.7 2.7 0 0 1 6.7 4h10.6A2.7 2.7 0 0 1 20 6.7v6.6a2.7 2.7 0 0 1-2.7 2.7H9.4L4 20z" />
        <path d="M8 9h8M8 12.3h5.5" />
      </svg>
    );
  }
  if (name === "user") {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="8.2" r="3.4" />
        <path d="M5.2 20a6.8 6.8 0 0 1 13.6 0" />
      </svg>
    );
  }
  if (name === "mic") {
    return (
      <svg {...commonProps}>
        <rect x="9" y="3.5" width="6" height="11" rx="3" />
        <path d="M5.8 11.8a6.2 6.2 0 0 0 12.4 0" />
        <path d="M12 18v2.5" />
      </svg>
    );
  }
  if (name === "thumbsUp") {
    return (
      <svg {...commonProps}>
        <path d="M7.5 11 11 4.3a2 2 0 0 1 2 2.4l-.6 2.8h4.9a2 2 0 0 1 2 2.4l-1.1 5.5a2 2 0 0 1-2 1.6H7.5z" />
        <path d="M7.5 11H4.5V19h3" />
      </svg>
    );
  }
  if (name === "thumbsDown") {
    return (
      <svg {...commonProps}>
        <path d="m16.5 13-3.5 6.7a2 2 0 0 1-2-2.4l.6-2.8H6.7a2 2 0 0 1-2-2.4l1.1-5.5a2 2 0 0 1 2-1.6h8.7z" />
        <path d="M16.5 13h3V5h-3" />
      </svg>
    );
  }
  if (name === "close") {
    return (
      <svg {...commonProps}>
        <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
      </svg>
    );
  }
  if (name === "check") {
    return (
      <svg {...commonProps}>
        <path d="m5 12.8 4.4 4.4L19 7.5" />
      </svg>
    );
  }
  if (name === "flame") {
    return (
      <svg {...commonProps}>
        <path d="M12 3.5c.5 2.5 1.9 3.9 3.5 5.5A6.6 6.6 0 0 1 18 13.7 6 6 0 0 1 6 13.7c0-2.1 1-3.5 2.1-4.7.4 1 .9 1.6 1.8 2.2-.3-2.5.6-5.5 2.1-7.7Z" />
      </svg>
    );
  }
  if (name === "thermo") {
    return (
      <svg {...commonProps}>
        <path d="M10.5 4.7a1.5 1.5 0 0 1 3 0v8.4a3.9 3.9 0 1 1-3 0Z" />
        <path d="M12 9.5v6" />
      </svg>
    );
  }
  if (name === "snowflake") {
    return (
      <svg {...commonProps}>
        <path d="M12 3.5v17M4.6 7.8l14.8 8.4M19.4 7.8 4.6 16.2" />
        <path d="m9.9 4.6 2.1 2 2.1-2M9.9 19.4l2.1-2 2.1 2" />
      </svg>
    );
  }
  if (name === "clock") {
    return (
      <svg {...commonProps}>
        <circle cx="12" cy="12" r="8.2" />
        <path d="M12 7.5V12l3 2" />
      </svg>
    );
  }
  if (name === "bolt") {
    return (
      <svg {...commonProps}>
        <path d="M13.2 3 5.5 13.4h5L10.8 21l7.7-10.4h-5z" />
      </svg>
    );
  }
  if (name === "tag") {
    return (
      <svg {...commonProps}>
        <path d="M3.5 12.3 11 4.8a2 2 0 0 1 1.4-.6l4.6.1a2 2 0 0 1 2 2l.1 4.6a2 2 0 0 1-.6 1.4l-7.5 7.5a1.8 1.8 0 0 1-2.6 0l-4.4-4.4a1.8 1.8 0 0 1 0-2.6z" />
        <circle cx="15.4" cy="8.6" r="1.1" />
      </svg>
    );
  }
  if (name === "creditCard") {
    return (
      <svg {...commonProps}>
        <rect x="3" y="5.5" width="18" height="13" rx="2.2" />
        <path d="M3 9.5h18M6.5 14.5h3" />
      </svg>
    );
  }
  return (
    <svg {...commonProps}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v2M12 18v2M4 12h2M18 12h2M6.3 6.3l1.4 1.4M16.3 16.3l1.4 1.4M6.3 17.7l1.4-1.4M16.3 7.7l1.4-1.4" />
    </svg>
  );
}
