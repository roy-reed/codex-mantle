import { describe, expect, it } from "vitest";
import { runDoctor } from "../src/doctor.js";
import type { ProcessResult, ProcessRunner } from "../src/process.js";

function result(
  command: string,
  args: readonly string[],
  stdout: string,
  exitCode = 0,
): ProcessResult {
  return {
    command,
    args,
    exitCode,
    signal: null,
    stdout,
    stderr: "",
    timedOut: false,
    truncated: false,
    durationMs: 1,
  };
}

describe("runDoctor", () => {
  it("checks versions without invoking credential-bearing auth commands", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const runner: ProcessRunner = async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "--version" && command === "codex") {
        return result(command, args, "codex-cli 0.147.0-alpha.1.2");
      }
      if (args[0] === "--version" && command.includes("node"))
        return result(command, args, "v24.0.0");
      if (args[0] === "--version" && command === "git")
        return result(command, args, "git version 2.50.0");
      if (args[0] === "--version" && command === "gh")
        return result(command, args, "gh version 2.90.0");
      if (command === "pwsh") return result(command, args, "7.5.0");
      if (args.includes("generate-json-schema")) {
        return result(
          command,
          args,
          "Usage: codex app-server generate-json-schema [OPTIONS] --out <DIR>",
        );
      }
      if (args[0] === "app-server") {
        return result(command, args, "Usage: codex app-server [OPTIONS]\ngenerate-json-schema");
      }
      if (args[0] === "--help") {
        return result(command, args, "Usage: codex [OPTIONS]\napp-server");
      }
      return result(command, args, "help");
    };

    const report = await runDoctor({
      runner,
      platform: "win32",
      commands: { node: "node", git: "git", powershell7: "pwsh", gh: "gh", codex: "codex" },
    });

    expect(report.ok).toBe(true);
    expect(report.readOnly).toBe(false);
    expect(calls.every((call) => !call.args.includes("auth"))).toBe(true);
    expect(calls.every((call) => !call.args.includes("status"))).toBe(true);
  });

  it("flags PowerShell below version 7", async () => {
    const runner: ProcessRunner = async (command, args) => {
      if (command === "pwsh") return result(command, args, "5.1.0");
      if (args[0] === "--version" && command === "codex") {
        return result(command, args, "codex-cli 0.147.0-alpha.1.2");
      }
      if (args[0] === "--version" && command.includes("node"))
        return result(command, args, "v24.0.0");
      if (args.includes("generate-json-schema")) {
        return result(
          command,
          args,
          "Usage: codex app-server generate-json-schema [OPTIONS] --out <DIR>",
        );
      }
      if (args[0] === "app-server") {
        return result(command, args, "Usage: codex app-server [OPTIONS]\ngenerate-json-schema");
      }
      if (args[0] === "--help") {
        return result(command, args, "Usage: codex [OPTIONS]\napp-server");
      }
      return result(command, args, "version 9.0.0");
    };

    const report = await runDoctor({
      runner,
      platform: "win32",
      commands: { node: "node", git: "git", powershell7: "pwsh", gh: "gh", codex: "codex" },
    });

    expect(report.ok).toBe(false);
    expect(report.tools.find((tool) => tool.name === "powershell7")?.status).toBe("error");
  });

  it("treats PowerShell as optional outside Windows", async () => {
    const runner: ProcessRunner = async (command, args) => {
      if (command === "pwsh") return result(command, args, "", 1);
      if (args[0] === "--version" && command === "codex") {
        return result(command, args, "codex-cli 0.147.0-alpha.1.2");
      }
      if (args.includes("generate-json-schema")) {
        return result(
          command,
          args,
          "Usage: codex app-server generate-json-schema [OPTIONS] --out <DIR>",
        );
      }
      if (args[0] === "app-server") {
        return result(command, args, "Usage: codex app-server [OPTIONS]\ngenerate-json-schema");
      }
      if (args[0] === "--help") return result(command, args, "Usage: codex [OPTIONS]\napp-server");
      if (args[0] === "--version" && command.includes("node")) {
        return result(command, args, "v24.0.0");
      }
      return result(command, args, "version 9.0.0");
    };

    const report = await runDoctor({ runner, platform: "linux" });
    const powershell = report.tools.find((tool) => tool.name === "powershell7");

    expect(report.ok).toBe(true);
    expect(powershell).toMatchObject({ required: false, status: "warning" });
  });
});
