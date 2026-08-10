import { Layer } from "effect"
import { OtlpLogger } from "effect/unstable/observability"
import { Flag } from "../flag/flag"
import { InstallationChannel, InstallationVersion } from "../installation/version"
import { runID } from "./shared"

const endpoint = Flag.OTEL_EXPORTER_OTLP_ENDPOINT

// Parse the OTEL_EXPORTER_OTLP_HEADERS env var (`k=v,k=v`) into a header map.
// Rejects entries with CRLF (HTTP header-injection guard) or oversized
// keys/values. Exported so the parsing is unit-testable.
export function parseOtlpHeaders(raw: string): Record<string, string> {
  return raw.split(',').reduce(
    (acc, entry) => {
      const [key, ...value] = entry.split('=');
      const val = value.join('=');
      if (!key || /[\r\n]/.test(key) || /[\r\n]/.test(val)) {
        return acc;
      }
      if (key.length > 1024 || val.length > 8192) {
        return acc;
      }
      acc[key] = val;
      return acc;
    },
    {} as Record<string, string>,
  );
}

const headers = Flag.OTEL_EXPORTER_OTLP_HEADERS ? parseOtlpHeaders(Flag.OTEL_EXPORTER_OTLP_HEADERS) : undefined;

function resourceAttributes() {
  const value = process.env.OTEL_RESOURCE_ATTRIBUTES
  if (!value) return {}
  try {
    return Object.fromEntries(
      value.split(",").map((entry) => {
        const index = entry.indexOf("=")
        if (index < 1) throw new Error("Invalid OTEL_RESOURCE_ATTRIBUTES entry")
        return [decodeURIComponent(entry.slice(0, index)), decodeURIComponent(entry.slice(index + 1))]
      }),
    )
  } catch {
    return {}
  }
}

export function resource(): { serviceName: string; serviceVersion: string; attributes: Record<string, string> } {
  return {
    serviceName: "opencode",
    serviceVersion: InstallationVersion,
    attributes: {
      ...resourceAttributes(),
      "deployment.environment.name": InstallationChannel,
      "opencode.client": Flag.DEVECO_CLIENT,
      "opencode.run": runID,
      "service.instance.id": runID,
    },
  }
}

export function loggers() {
  if (!endpoint) return []
  return [OtlpLogger.make({ url: `${endpoint}/v1/logs`, resource: resource(), headers })]
}

export async function tracingLayer() {
  if (!endpoint) return Layer.empty
  const NodeSdk = await import("@effect/opentelemetry/NodeSdk")
  const OTLP = await import("@opentelemetry/exporter-trace-otlp-http")
  const SdkBase = await import("@opentelemetry/sdk-trace-base")
  const { AsyncLocalStorageContextManager } = await import("@opentelemetry/context-async-hooks")
  const { context } = await import("@opentelemetry/api")

  // The Effect Node SDK does not register a global context manager, but the AI SDK uses it to parent spans.
  const manager = new AsyncLocalStorageContextManager()
  manager.enable()
  context.setGlobalContextManager(manager)

  return NodeSdk.layer(() => ({
    resource: resource(),
    spanProcessor: new SdkBase.BatchSpanProcessor(
      new OTLP.OTLPTraceExporter({
        url: `${endpoint}/v1/traces`,
        headers,
      }),
    ),
  }))
}

export * as Otlp from "./otlp"
