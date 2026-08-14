import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";

export class PathBoundaryError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PathBoundaryError";
  }
}

function isOutside(relativePath: string): boolean {
  return relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath);
}

/**
 * Produces a conservative path identity key. Windows paths are case-folded on
 * purpose: this can reject two distinct files in a case-sensitive Windows
 * directory, but it never treats a normal NTFS case alias as two mutations.
 */
export function pathIdentityKey(
  path: string,
  currentPlatform: NodeJS.Platform = process.platform,
): string {
  const pathApi = currentPlatform === "win32" ? win32 : posix;
  const normalized = pathApi.resolve(path).normalize("NFC");
  return currentPlatform === "win32" ? normalized.toLowerCase() : normalized;
}

export function samePathIdentity(
  left: string,
  right: string,
  currentPlatform: NodeJS.Platform = process.platform,
): boolean {
  return pathIdentityKey(left, currentPlatform) === pathIdentityKey(right, currentPlatform);
}

async function exists(path: string): Promise<boolean> {
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

/**
 * Binds file operations to one existing real directory. Existing symbolic links
 * and Windows junctions are rejected rather than followed.
 */
export class PathBoundary {
  public readonly root: string;
  readonly #canonicalRoot: string;

  private constructor(root: string, canonicalRoot: string) {
    this.root = root;
    this.#canonicalRoot = canonicalRoot;
  }

  public static async create(root: string): Promise<PathBoundary> {
    if (!isAbsolute(root)) {
      throw new PathBoundaryError("Allowed root must be absolute");
    }

    const normalizedRoot = resolve(root);
    const rootInfo = await lstat(normalizedRoot).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        throw new PathBoundaryError(`Allowed root does not exist: ${normalizedRoot}`);
      }
      throw error;
    });

    if (rootInfo.isSymbolicLink()) {
      throw new PathBoundaryError(
        `Allowed root cannot be a symbolic link or junction: ${normalizedRoot}`,
      );
    }
    if (!rootInfo.isDirectory()) {
      throw new PathBoundaryError(`Allowed root is not a directory: ${normalizedRoot}`);
    }

    const canonicalRoot = await realpath(normalizedRoot);
    if (relative(normalizedRoot, canonicalRoot) !== "") {
      throw new PathBoundaryError(
        `Allowed root cannot contain a symbolic link or junction: ${normalizedRoot}`,
      );
    }

    return new PathBoundary(resolve(canonicalRoot), resolve(canonicalRoot));
  }

  public resolve(relativePath: string): string {
    assertPortableRelativePath(relativePath);
    return resolve(this.root, ...relativePath.replaceAll("\\", "/").split("/"));
  }

  public identity(target: string): string {
    if (!isAbsolute(target)) {
      throw new PathBoundaryError("Target path must be absolute");
    }
    const normalizedTarget = resolve(target);
    const relativeTarget = relative(this.root, normalizedTarget);
    if (isOutside(relativeTarget)) {
      throw new PathBoundaryError(`Target escapes allowed root: ${normalizedTarget}`);
    }
    return pathIdentityKey(resolve(this.#canonicalRoot, relativeTarget));
  }

  public async assert(target: string, options: { allowRoot?: boolean } = {}): Promise<string> {
    if (!isAbsolute(target)) {
      throw new PathBoundaryError("Target path must be absolute");
    }

    const normalizedTarget = resolve(target);
    const relativeTarget = relative(this.root, normalizedTarget);
    if (isOutside(relativeTarget)) {
      throw new PathBoundaryError(`Target escapes allowed root: ${normalizedTarget}`);
    }
    if (relativeTarget === "" && options.allowRoot !== true) {
      throw new PathBoundaryError("The allowed root itself is not a valid file target");
    }

    if (process.platform === "win32") {
      for (const component of relativeTarget.split(sep)) {
        if (component.includes(":")) {
          throw new PathBoundaryError(
            `NTFS alternate data streams are not allowed: ${normalizedTarget}`,
          );
        }
      }
    }

    let cursor = this.root;
    const components = relativeTarget === "" ? [] : relativeTarget.split(sep);
    for (const component of components) {
      cursor = resolve(cursor, component);
      if (!(await exists(cursor))) {
        break;
      }

      const info = await lstat(cursor);
      if (info.isSymbolicLink()) {
        throw new PathBoundaryError(`Symbolic links and junctions are not allowed: ${cursor}`);
      }
    }

    let existingAncestor = normalizedTarget;
    while (!(await exists(existingAncestor))) {
      const parent = resolve(existingAncestor, "..");
      if (parent === existingAncestor) {
        throw new PathBoundaryError(`No existing ancestor for target: ${normalizedTarget}`);
      }
      existingAncestor = parent;
    }

    const ancestorCanonical = await realpath(existingAncestor);
    if (isOutside(relative(this.#canonicalRoot, ancestorCanonical))) {
      throw new PathBoundaryError(`Target resolves outside allowed root: ${normalizedTarget}`);
    }

    if (await exists(normalizedTarget)) {
      const targetInfo = await lstat(normalizedTarget);
      if (!targetInfo.isFile()) {
        throw new PathBoundaryError(`Only regular file targets are allowed: ${normalizedTarget}`);
      }
    }

    return normalizedTarget;
  }
}

export function assertPortableRelativePath(relativePath: string): void {
  if (relativePath.trim() === "" || isAbsolute(relativePath)) {
    throw new PathBoundaryError("Profile paths must be non-empty relative paths");
  }

  const normalized = relativePath.replaceAll("\\", "/");
  const components = normalized.split("/");
  if (components.some((component) => component === "" || component === "." || component === "..")) {
    throw new PathBoundaryError(`Unsafe relative path: ${relativePath}`);
  }
  if (components.some((component) => component.includes(":"))) {
    throw new PathBoundaryError(`Portable profile paths cannot contain a colon: ${relativePath}`);
  }
}
