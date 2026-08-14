export type CapabilityState = "available" | "degraded" | "unavailable" | "unknown";

export interface CapabilityInput {
  id: string;
  label: string;
  state: CapabilityState;
  detail?: string;
}

export interface CompatibilityInput {
  state: "compatible" | "limited" | "unknown";
  summary: string;
}

export interface StatusProviderValue {
  codexVersion?: string | null;
  compatibility?: CompatibilityInput;
  capabilities?: readonly CapabilityInput[];
  warnings?: readonly string[];
}

export interface SnapshotProviderValue {
  id: string;
  createdAt: string;
  reason?: string;
  fileCount?: number;
  byteCount?: number;
}

export interface PublicCapability {
  id: string;
  label: string;
  state: CapabilityState;
  detail?: string;
}

export interface PublicStatus {
  schemaVersion: 1;
  product: {
    name: "Codex Mantle";
    version: string;
    channel: "alpha";
    readOnly: true;
  };
  runtime: {
    platform: NodeJS.Platform;
    nodeVersion: string;
    codexVersion?: string;
  };
  compatibility: CompatibilityInput;
  capabilities: PublicCapability[];
  warnings: string[];
  generatedAt: string;
}

export interface PublicSnapshot {
  id: string;
  createdAt: string;
  fileCount?: number;
  byteCount?: number;
}

export interface PublicSnapshots {
  schemaVersion: 1;
  total: number;
  items: PublicSnapshot[];
  generatedAt: string;
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{8,}\b/g, "[redacted]"],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/g, "[redacted]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]"],
  [/(\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*)\S+/gi, "$1[redacted]"],
  [/[A-Za-z]:\\(?:[^\\\s]+\\)*[^\\\s]*/g, "[local path]"],
  [/\/(?:Users|home)\/[^\s]+/g, "[local path]"],
];

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function redact(value: string): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function cleanText(value: unknown, fallback: string, maxLength = 240): string {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = redact(
    Array.from(value, (character) => {
      const codePoint = character.charCodeAt(0);
      return codePoint <= 0x1f || codePoint === 0x7f ? " " : character;
    })
      .join("")
      .trim(),
  );
  if (normalized.length === 0) {
    return fallback;
  }
  return normalized.slice(0, maxLength);
}

function cleanVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function cleanNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isCapabilityState(value: unknown): value is CapabilityState {
  return (
    value === "available" || value === "degraded" || value === "unavailable" || value === "unknown"
  );
}

function cleanCompatibility(value: StatusProviderValue["compatibility"]): CompatibilityInput {
  const state =
    value?.state === "compatible" || value?.state === "limited" || value?.state === "unknown"
      ? value.state
      : "unknown";

  return {
    state,
    summary: cleanText(value?.summary, "Compatibility has not been evaluated yet."),
  };
}

function cleanCapabilities(value: StatusProviderValue["capabilities"]): PublicCapability[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const capabilities: PublicCapability[] = [];
  for (const candidate of value.slice(0, 64)) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
    if (!ID_PATTERN.test(id) || seen.has(id) || !isCapabilityState(candidate.state)) {
      continue;
    }

    seen.add(id);
    const capability: PublicCapability = {
      id,
      label: cleanText(candidate.label, id, 80),
      state: candidate.state,
    };
    if (candidate.detail !== undefined) {
      capability.detail = cleanText(candidate.detail, "No detail available.");
    }
    capabilities.push(capability);
  }
  return capabilities;
}

export function toPublicStatus(
  value: StatusProviderValue | undefined,
  productVersion: string,
  now = new Date(),
): PublicStatus {
  const runtime: PublicStatus["runtime"] = {
    platform: process.platform,
    nodeVersion: process.versions.node,
  };
  const codexVersion = cleanVersion(value?.codexVersion);
  if (codexVersion !== undefined) {
    runtime.codexVersion = codexVersion;
  }

  return {
    schemaVersion: 1,
    product: {
      name: "Codex Mantle",
      version: cleanVersion(productVersion) ?? "0.0.0-unknown",
      channel: "alpha",
      readOnly: true,
    },
    runtime,
    compatibility: cleanCompatibility(value?.compatibility),
    capabilities: cleanCapabilities(value?.capabilities),
    warnings: Array.isArray(value?.warnings)
      ? value.warnings.slice(0, 32).map((warning) => cleanText(warning, "Unknown warning."))
      : [],
    generatedAt: now.toISOString(),
  };
}

export function toPublicSnapshots(
  value: readonly SnapshotProviderValue[] | undefined,
  now = new Date(),
): PublicSnapshots {
  const items: PublicSnapshot[] = [];

  if (Array.isArray(value)) {
    for (const candidate of value.slice(0, 100)) {
      const id = typeof candidate?.id === "string" ? candidate.id.trim() : "";
      const timestamp = Date.parse(candidate?.createdAt ?? "");
      if (!ID_PATTERN.test(id) || !Number.isFinite(timestamp)) {
        continue;
      }

      const snapshot: PublicSnapshot = {
        id,
        createdAt: new Date(timestamp).toISOString(),
      };
      const fileCount = cleanNonNegativeInteger(candidate.fileCount);
      if (fileCount !== undefined) {
        snapshot.fileCount = fileCount;
      }
      const byteCount = cleanNonNegativeInteger(candidate.byteCount);
      if (byteCount !== undefined) {
        snapshot.byteCount = byteCount;
      }
      items.push(snapshot);
    }
  }

  items.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return {
    schemaVersion: 1,
    total: items.length,
    items,
    generatedAt: now.toISOString(),
  };
}
