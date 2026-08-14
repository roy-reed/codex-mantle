import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type MantleServerHandle, startMantleServer } from "../src/index.js";

interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(
  server: MantleServerHandle,
  path: string,
  options: { method?: string; headers?: Record<string, string> } = {},
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: server.host,
        port: server.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
        incoming.on("end", () => {
          resolve({
            status: incoming.statusCode ?? 0,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
}

const activeServers: MantleServerHandle[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...activeServers.splice(0).map((server) => server.close()),
    ...temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  ]);
});

describe("startMantleServer", () => {
  it("serves health metadata with hardened headers and no CORS", async () => {
    const server = await startMantleServer({ port: 0, productVersion: "0.1.0-test" });
    activeServers.push(server);

    const response = await send(server, "/api/v1/health");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body)).toEqual({
      ok: true,
      service: "codex-mantle",
      version: "0.1.0-test",
      readOnly: true,
    });
    expect(response.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rejects non-loopback binding", async () => {
    await expect(startMantleServer({ host: "0.0.0.0" as "127.0.0.1", port: 0 })).rejects.toThrow(
      "explicit loopback",
    );
  });

  it("rejects forged Host and cross-origin requests", async () => {
    const server = await startMantleServer({ port: 0 });
    activeServers.push(server);

    const forgedHost = await send(server, "/api/v1/status", {
      headers: { Host: "attacker.example" },
    });
    expect(forgedHost.status).toBe(403);
    expect(JSON.parse(forgedHost.body).error.code).toBe("host_not_allowed");

    const forgedOrigin = await send(server, "/api/v1/status", {
      headers: { Origin: "https://attacker.example" },
    });
    expect(forgedOrigin.status).toBe(403);
    expect(JSON.parse(forgedOrigin.body).error.code).toBe("origin_not_allowed");
  });

  it("requires both same-origin and the CSRF token for mutation methods", async () => {
    const server = await startMantleServer({ port: 0 });
    activeServers.push(server);

    const withoutToken = await send(server, "/api/v1/status", { method: "POST" });
    expect(withoutToken.status).toBe(403);

    const withToken = await send(server, "/api/v1/status", {
      method: "POST",
      headers: {
        Origin: server.origin,
        "X-Codex-Mantle-CSRF": server.csrfToken,
      },
    });
    expect(withToken.status).toBe(405);
    expect(JSON.parse(withToken.body).error.code).toBe("read_only_api");
  });

  it("serves only local static assets and falls back to the SPA entry point", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "codex-mantle-web-"));
    temporaryDirectories.push(webRoot);
    await writeFile(join(webRoot, "index.html"), "<main>local dashboard</main>", "utf8");
    await writeFile(join(webRoot, "app.js"), "globalThis.mantle = true;", "utf8");

    const server = await startMantleServer({ port: 0, webRoot });
    activeServers.push(server);

    const entry = await send(server, "/dashboard/settings");
    const asset = await send(server, "/app.js");
    const missingAsset = await send(server, "/missing.js");

    expect(entry.status).toBe(200);
    expect(entry.body).toContain("local dashboard");
    expect(entry.headers["content-type"]).toContain("text/html");
    expect(asset.status).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(missingAsset.status).toBe(404);
  });

  it("allowlists provider fields and redacts credentials and local paths", async () => {
    const server = await startMantleServer({
      port: 0,
      statusProvider: () =>
        ({
          codexVersion: "0.147.0-alpha.1",
          compatibility: { state: "limited", summary: "token=top-secret-value" },
          capabilities: [
            {
              id: "snapshot.restore",
              label: "Snapshot restore",
              state: "degraded",
              detail: "Read C:\\Users\\<user>\\secret.txt with sk-abcdefghijk",
            },
          ],
          warnings: ["github_pat_abcdefghijklmnopqrstuvwxyz"],
          internalToken: "must-never-appear",
        }) as never,
      snapshotProvider: () => [
        {
          id: "snapshot-001",
          createdAt: "2026-08-15T12:00:00.000Z",
          reason: "Before api_key=very-secret-value",
          fileCount: 2,
          byteCount: 42,
          sourcePath: "C:\\Users\\<user>\\.codex",
        } as never,
      ],
    });
    activeServers.push(server);

    const status = await send(server, "/api/v1/status");
    const snapshots = await send(server, "/api/v1/snapshots");
    const combined = `${status.body}\n${snapshots.body}`;

    expect(status.status).toBe(200);
    expect(snapshots.status).toBe(200);
    expect(combined).not.toContain("top-secret-value");
    expect(combined).not.toContain("abcdefghijk");
    expect(combined).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(combined).not.toContain("must-never-appear");
    expect(combined).not.toContain("sourcePath");
    expect(combined).not.toContain("very-secret-value");
    expect(combined).not.toContain("reason");
    expect(combined).not.toContain("someone");
    expect(combined).toContain("[redacted]");
  });

  it("does not expose provider failures", async () => {
    const server = await startMantleServer({
      port: 0,
      statusProvider: () => {
        throw new Error("secret failure details");
      },
    });
    activeServers.push(server);

    const response = await send(server, "/api/v1/status");
    expect(response.status).toBe(500);
    expect(response.body).toContain("provider_failed");
    expect(response.body).not.toContain("secret failure details");
  });
});
