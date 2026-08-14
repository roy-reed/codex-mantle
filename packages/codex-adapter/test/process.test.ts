import { describe, expect, it } from "vitest";
import { processSucceeded, runProcess } from "../src/process.js";

describe("runProcess", () => {
  it("passes shell metacharacters as literal arguments", async () => {
    const marker = "literal & echo SHOULD_NOT_RUN";
    const result = await runProcess(process.execPath, [
      "-e",
      "console.log(process.argv[1])",
      marker,
    ]);

    expect(processSucceeded(result)).toBe(true);
    expect(result.stdout.trim()).toBe(marker);
    expect(result.stdout).not.toContain("\nSHOULD_NOT_RUN");
  });

  it("terminates a process after the configured timeout", async () => {
    const result = await runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeoutMs: 50,
    });

    expect(result.timedOut).toBe(true);
    expect(processSucceeded(result)).toBe(false);
  });

  it("rejects NUL bytes before spawning", async () => {
    await expect(runProcess(process.execPath, ["bad\0argument"])).rejects.toThrow(/NUL/u);
  });
});
