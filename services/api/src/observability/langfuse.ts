import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startActiveObservation } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";

type TraceOptions<T> = {
  input?: unknown;
  metadata?: Record<string, unknown>;
  tags?: string[];
  sessionId?: string;
  userId?: string;
  output?: (result: T) => unknown;
};

let sdk: NodeSDK | null = null;
let initAttempted = false;
let initWarned = false;
let traceWarned = false;

function envEnabled(): boolean {
  const explicit = String(process.env.LANGFUSE_ENABLED ?? "").trim().toLowerCase();
  if (explicit === "0" || explicit === "false" || explicit === "off") return false;
  return !!process.env.LANGFUSE_PUBLIC_KEY && !!process.env.LANGFUSE_SECRET_KEY;
}

function nodeMajor(): number {
  const major = Number.parseInt(String(process.versions.node ?? "0").split(".")[0] ?? "0", 10);
  return Number.isFinite(major) ? major : 0;
}

export function isLangfuseEnabled(): boolean {
  return envEnabled() && nodeMajor() >= 20;
}

export function initializeLangfuse(): boolean {
  if (initAttempted) return !!sdk;
  initAttempted = true;
  if (!envEnabled()) return false;
  if (nodeMajor() < 20) {
    console.warn("[langfuse] disabled: @langfuse JS SDK requires Node.js >= 20");
    return false;
  }
  try {
    sdk = new NodeSDK({
      spanProcessors: [new LangfuseSpanProcessor()]
    });
    sdk.start();
    console.log("[langfuse] tracing enabled", {
      baseUrl: process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com"
    });
    return true;
  } catch (err: any) {
    if (!initWarned) {
      initWarned = true;
      console.warn("[langfuse] tracing init failed:", err?.message ?? err);
    }
    sdk = null;
    return false;
  }
}

export async function withLangfuseObservation<T>(
  name: string,
  options: TraceOptions<T>,
  fn: () => Promise<T>
): Promise<T> {
  if (!initializeLangfuse()) return fn();

  let callbackStarted = false;
  try {
    return await startActiveObservation(name, async (span: any) => {
      callbackStarted = true;
      span.update({
        input: options.input,
        metadata: options.metadata,
        tags: options.tags,
        sessionId: options.sessionId,
        userId: options.userId
      });

      try {
        const result = await fn();
        span.update({
          output: options.output ? options.output(result) : undefined
        });
        return result;
      } catch (err: any) {
        span.update({
          level: "ERROR",
          statusMessage: err?.message ?? String(err ?? "unknown error")
        });
        throw err;
      }
    });
  } catch (err: any) {
    if (callbackStarted) throw err;
    if (!traceWarned) {
      traceWarned = true;
      console.warn("[langfuse] trace wrapper failed; continuing without trace:", err?.message ?? err);
    }
    return fn();
  }
}

export async function shutdownLangfuse(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
}
