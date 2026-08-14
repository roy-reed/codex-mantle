import { homedir, platform } from "node:os";
import { isAbsolute, resolve } from "node:path";

export interface DirectoryEnvironment {
  readonly CODEX_HOME?: string;
  readonly CODEX_MANTLE_HOME?: string;
  readonly LOCALAPPDATA?: string;
  readonly XDG_STATE_HOME?: string;
}

function absoluteOverride(value: string | undefined, name: string): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  if (!isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path`);
  }

  return resolve(value);
}

export function resolveStateDir(
  environment: DirectoryEnvironment = process.env,
  currentPlatform: NodeJS.Platform = platform(),
  userHome: string = homedir(),
): string {
  const override = absoluteOverride(environment.CODEX_MANTLE_HOME, "CODEX_MANTLE_HOME");
  if (override !== undefined) {
    return override;
  }

  if (currentPlatform === "win32") {
    const localAppData = absoluteOverride(environment.LOCALAPPDATA, "LOCALAPPDATA");
    if (localAppData === undefined) {
      throw new Error("LOCALAPPDATA is required on Windows when CODEX_MANTLE_HOME is unset");
    }
    return resolve(localAppData, "CodexMantle");
  }

  const xdgStateHome = absoluteOverride(environment.XDG_STATE_HOME, "XDG_STATE_HOME");
  return xdgStateHome === undefined
    ? resolve(userHome, ".local", "state", "codex-mantle")
    : resolve(xdgStateHome, "codex-mantle");
}

export function resolveCodexHome(
  environment: DirectoryEnvironment = process.env,
  userHome: string = homedir(),
): string {
  return absoluteOverride(environment.CODEX_HOME, "CODEX_HOME") ?? resolve(userHome, ".codex");
}
