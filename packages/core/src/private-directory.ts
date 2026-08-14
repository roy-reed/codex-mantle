import { spawn } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { PathBoundary, PathBoundaryError } from "./path-boundary.js";

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function nearestExistingAncestor(target: string): Promise<string> {
  let cursor = resolve(target);
  while (!(await pathExists(cursor))) {
    const parent = dirname(cursor);
    if (parent === cursor) {
      throw new PathBoundaryError(`No existing ancestor for directory: ${target}`);
    }
    cursor = parent;
  }
  return cursor;
}

async function runWindowsAclHardening(target: string): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  if (!isAbsolute(systemRoot)) {
    throw new Error("SystemRoot must be absolute before ACL hardening");
  }
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const encodedPath = Buffer.from(target, "utf8").toString("base64");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `$path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}'))`,
    "$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User",
    "$security = New-Object Security.AccessControl.DirectorySecurity",
    "$security.SetAccessRuleProtection($true, $false)",
    "$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'",
    "$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)",
    "$null = $security.AddAccessRule($rule)",
    "$directory = [IO.DirectoryInfo]::new($path)",
    // Windows PowerShell 5.1 exposes these methods directly on DirectoryInfo;
    // the FileSystemAclExtensions type used by modern .NET is not universal.
    "$directory.SetAccessControl($security)",
    "$check = $directory.GetAccessControl()",
    "$rules = @($check.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))",
    "if (-not $check.AreAccessRulesProtected) { throw 'DACL inheritance remains enabled' }",
    'if ($rules.Count -ne 1) { throw "Expected one DACL rule, found $($rules.Count)" }',
    "if ($rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or (($rules[0].FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -ne [Security.AccessControl.FileSystemRights]::FullControl)) { throw 'DACL verification failed' }",
  ].join("\n");
  const encodedCommand = Buffer.from(script, "utf16le").toString("base64");

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedCommand],
      { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let output = "";
    const append = (chunk: Buffer): void => {
      if (output.length < 8192) {
        output += chunk.toString("utf8").slice(0, 8192 - output.length);
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        reject(
          new Error(
            `Refused to use private directory because Windows ACL hardening failed (${String(code)}): ${output.trim()}`,
          ),
        );
      }
    });
  });
}

export interface EnsureRealDirectoryOptions {
  readonly privateDirectory?: boolean;
}

/**
 * Checks the nearest existing ancestor before mkdir and validates the complete
 * result again afterwards. A hostile reparse-point swap during those checks is
 * outside the portable filesystem guarantees provided here.
 */
export async function ensureRealDirectory(
  target: string,
  options: EnsureRealDirectoryOptions = {},
): Promise<string> {
  if (!isAbsolute(target)) {
    throw new PathBoundaryError("Directory path must be absolute");
  }
  const normalized = resolve(target);
  const ancestor = await nearestExistingAncestor(normalized);
  await PathBoundary.create(ancestor);
  await mkdir(normalized, { mode: 0o700, recursive: true });
  const boundary = await PathBoundary.create(normalized);

  if (options.privateDirectory === true) {
    if (process.platform === "win32") {
      await runWindowsAclHardening(boundary.root);
    } else {
      await chmod(boundary.root, 0o700);
    }
  }
  return boundary.root;
}
