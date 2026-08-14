import { randomBytes } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { PRODUCT_VERSION } from "@codex-mantle/core";
import {
  type SnapshotProviderValue,
  type StatusProviderValue,
  toPublicSnapshots,
  toPublicStatus,
} from "./contracts.js";
import {
  assertLoopbackHost,
  isAllowedHost,
  isAllowedOrigin,
  type LoopbackHost,
  SECURITY_HEADERS,
  tokensEqual,
} from "./security.js";

const DEFAULT_PORT = 41_237;
const MAX_STATIC_BYTES = 8 * 1024 * 1024;

export type StatusProvider = () => StatusProviderValue | Promise<StatusProviderValue>;
export type SnapshotProvider = () =>
  | readonly SnapshotProviderValue[]
  | Promise<readonly SnapshotProviderValue[]>;

export interface MantleServerOptions {
  host?: LoopbackHost;
  port?: number;
  productVersion?: string;
  webRoot?: string;
  csrfToken?: string;
  statusProvider?: StatusProvider;
  snapshotProvider?: SnapshotProvider;
}

export interface MantleServerHandle {
  host: LoopbackHost;
  port: number;
  origin: string;
  csrfToken: string;
  close(): Promise<void>;
}

function setSecurityHeaders(response: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
  head = false,
): void {
  const body = Buffer.from(`${JSON.stringify(payload)}\n`);
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", body.byteLength);
  response.end(head ? undefined : body);
}

function writeError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  head = false,
): void {
  writeJson(response, statusCode, { error: { code } }, head);
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) && !pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== "..")
  );
}

async function resolveStaticFile(root: string, pathname: string): Promise<string | undefined> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined;
  }

  if (decoded.includes("\0") || decoded.includes("\\")) {
    return undefined;
  }

  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = resolve(root, relativePath);
  if (isAbsolute(relativePath) || !isInside(root, candidate)) {
    return undefined;
  }

  try {
    const candidateRealPath = await realpath(candidate);
    const metadata = await stat(candidateRealPath);
    return metadata.isFile() &&
      metadata.size <= MAX_STATIC_BYTES &&
      isInside(root, candidateRealPath)
      ? candidateRealPath
      : undefined;
  } catch {
    if (extname(relativePath) !== "") {
      return undefined;
    }

    try {
      const fallback = await realpath(resolve(root, "index.html"));
      const metadata = await stat(fallback);
      return metadata.isFile() && metadata.size <= MAX_STATIC_BYTES && isInside(root, fallback)
        ? fallback
        : undefined;
    } catch {
      return undefined;
    }
  }
}

async function prepareWebRoot(webRoot: string | undefined): Promise<string | undefined> {
  if (webRoot === undefined) {
    return undefined;
  }

  const resolved = await realpath(resolve(webRoot));
  const metadata = await stat(resolved);
  if (!metadata.isDirectory()) {
    throw new Error("The configured web root is not a directory.");
  }
  return resolved;
}

function validatePort(port: number): void {
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Port must be an integer between 0 and 65535.");
  }
}

export async function startMantleServer(
  options: MantleServerOptions = {},
): Promise<MantleServerHandle> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? DEFAULT_PORT;
  assertLoopbackHost(host);
  validatePort(requestedPort);

  const productVersion = toPublicStatus(undefined, options.productVersion ?? PRODUCT_VERSION)
    .product.version;
  const csrfToken = options.csrfToken ?? randomBytes(32).toString("base64url");
  if (csrfToken.length < 32) {
    throw new Error("The CSRF token must contain at least 32 characters.");
  }

  const webRoot = await prepareWebRoot(options.webRoot);
  const statusProvider = options.statusProvider ?? (() => ({}));
  const snapshotProvider = options.snapshotProvider ?? (() => []);
  let activePort = requestedPort;

  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (request, response) => {
    setSecurityHeaders(response);
    response.setHeader("X-Codex-Mantle-Read-Only", "true");

    const method = request.method ?? "GET";
    const head = method === "HEAD";
    if (!isAllowedHost(request.headers.host, host, activePort)) {
      writeError(response, 403, "host_not_allowed", head);
      return;
    }

    const origin = request.headers.origin;
    if (origin !== undefined && !isAllowedOrigin(origin, host, activePort)) {
      writeError(response, 403, "origin_not_allowed", head);
      return;
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      writeError(response, 403, "cross_site_request_blocked", head);
      return;
    }

    if (isMutation(method)) {
      const suppliedToken = request.headers["x-codex-mantle-csrf"];
      if (
        !isAllowedOrigin(origin, host, activePort) ||
        typeof suppliedToken !== "string" ||
        !tokensEqual(suppliedToken, csrfToken)
      ) {
        writeError(response, 403, "csrf_validation_failed", head);
        return;
      }
    }

    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    } catch {
      writeError(response, 400, "invalid_request_url", head);
      return;
    }

    if (method === "OPTIONS") {
      response.setHeader("Allow", "GET, HEAD");
      writeError(response, 405, "method_not_allowed", head);
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (method !== "GET" && method !== "HEAD") {
        response.setHeader("Allow", "GET, HEAD");
        writeError(response, 405, "read_only_api", head);
        return;
      }

      try {
        if (url.pathname === "/api/v1/health") {
          writeJson(
            response,
            200,
            {
              ok: true,
              service: "codex-mantle",
              version: productVersion,
              readOnly: true,
            },
            head,
          );
          return;
        }
        if (url.pathname === "/api/v1/status") {
          writeJson(response, 200, toPublicStatus(await statusProvider(), productVersion), head);
          return;
        }
        if (url.pathname === "/api/v1/snapshots") {
          writeJson(response, 200, toPublicSnapshots(await snapshotProvider()), head);
          return;
        }
        writeError(response, 404, "api_route_not_found", head);
      } catch {
        writeError(response, 500, "provider_failed", head);
      }
      return;
    }

    if (method !== "GET" && method !== "HEAD") {
      response.setHeader("Allow", "GET, HEAD");
      writeError(response, 405, "read_only_server", head);
      return;
    }
    if (webRoot === undefined) {
      writeError(response, 404, "dashboard_not_configured", head);
      return;
    }

    const filePath = await resolveStaticFile(webRoot, url.pathname);
    if (filePath === undefined) {
      writeError(response, 404, "static_asset_not_found", head);
      return;
    }

    try {
      const body = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader(
        "Cache-Control",
        filePath.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable",
      );
      response.setHeader("Content-Type", contentType(filePath));
      response.setHeader("Content-Length", body.byteLength);
      response.end(head ? undefined : body);
    } catch {
      writeError(response, 500, "static_asset_read_failed", head);
    }
  });

  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (error: Error): void => rejectListen(error);
    server.once("error", onError);
    server.listen({ host, port: requestedPort, exclusive: true }, () => {
      server.off("error", onError);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) {
    server.close();
    throw new Error("The server started without a network address.");
  }
  activePort = address.port;
  const formattedHost = host === "::1" ? `[${host}]` : host;

  return {
    host,
    port: activePort,
    origin: `http://${formattedHost}:${activePort}`,
    csrfToken,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}
