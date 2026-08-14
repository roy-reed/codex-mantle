import { timingSafeEqual } from "node:crypto";

export type LoopbackHost = "127.0.0.1" | "::1";

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});

export function assertLoopbackHost(value: string): asserts value is LoopbackHost {
  if (value !== "127.0.0.1" && value !== "::1") {
    throw new Error("Codex Mantle only listens on an explicit loopback address.");
  }
}

function hostWithPort(host: string, port: number): string {
  const formatted = host.includes(":") ? `[${host}]` : host;
  return port === 80 ? formatted : `${formatted}:${port}`;
}

export function allowedHostHeaders(host: LoopbackHost, port: number): ReadonlySet<string> {
  return new Set([hostWithPort(host, port), hostWithPort("localhost", port)]);
}

export function allowedOrigins(host: LoopbackHost, port: number): ReadonlySet<string> {
  return new Set(Array.from(allowedHostHeaders(host, port), (entry) => `http://${entry}`));
}

export function isAllowedHost(
  header: string | undefined,
  host: LoopbackHost,
  port: number,
): boolean {
  if (header === undefined || header.includes("@") || /[\s/\\]/.test(header)) {
    return false;
  }
  return allowedHostHeaders(host, port).has(header.toLowerCase());
}

export function isAllowedOrigin(
  header: string | undefined,
  host: LoopbackHost,
  port: number,
): boolean {
  if (header === undefined) {
    return false;
  }

  try {
    const parsed = new URL(header);
    return parsed.href === `${parsed.origin}/` && allowedOrigins(host, port).has(parsed.origin);
  } catch {
    return false;
  }
}

export function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}
