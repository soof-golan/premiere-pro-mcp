import { lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import nodePath, { posix, win32 } from "node:path";

/**
 * Server-side symlink confinement for UXP path arguments (issue #640).
 *
 * The UXP panel checks lexical containment inside the approved workspace, but
 * Premiere 26.5 UXP cannot see through links: `Entry.nativePath` reports the
 * link's own path and `lstat` is unimplemented. The MCP server runs on the same
 * machine as Premiere, so it walks every absolute path argument with Node's
 * real filesystem before a command is sent and refuses any symlinked or
 * junctioned segment. Segments that do not exist yet (new output files) end
 * the walk; they cannot redirect anything.
 */

const MAX_DEPTH = 8;
const MAX_STRINGS = 512;

/** macOS calibration links that always point into /private. */
const SYSTEM_LINK_TARGETS: Readonly<Record<string, readonly string[]>> = {
  "/tmp": ["private/tmp", "/private/tmp"],
  "/var": ["private/var", "/private/var"],
  "/etc": ["private/etc", "/private/etc"],
};

export class SymlinkPathError extends Error {
  readonly code = "UXP_PATH_SYMLINK_REFUSED";
  constructor(readonly argumentPath: string) {
    super(`${argumentPath} goes through a symbolic link or junction. Use the real folder inside the approved workspace. No command was sent to Premiere.`);
    this.name = "SymlinkPathError";
  }
}

type PathFlavor = typeof posix | typeof win32;

function absoluteFlavor(value: string): PathFlavor | null {
  if (/^[A-Za-z]:[\\/]/.test(value) || /^\\\\[^\\]/.test(value)) return win32;
  if (value.startsWith("/") && !value.startsWith("//")) return posix;
  return null;
}

function isSystemLink(segment: string): boolean {
  const targets = SYSTEM_LINK_TARGETS[segment];
  if (!targets || process.platform !== "darwin") return false;
  try { return targets.includes(readlinkSync(segment)); } catch { return false; }
}

/** Returns the first symlinked segment of an absolute path, or null. */
export function findSymlinkedSegment(value: string): string | null {
  const flavor = absoluteFlavor(value);
  if (!flavor || value.includes("\0")) return null;
  const normalized = flavor.normalize(value);
  const root = flavor.parse(normalized).root;
  const parts = normalized.slice(root.length).split(flavor.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = flavor.join(current, part);
    let stats;
    try { stats = lstatSync(current); } catch { return null; }
    if (stats.isSymbolicLink()) {
      if (!isSystemLink(current)) return current;
      // Keep walking below /tmp, /var and /etc: lstat of later segments
      // resolves through the calibration link and still sees user links.
      continue;
    }
    if (!stats.isDirectory()) return null;
  }
  return null;
}

function collectStrings(value: unknown, path: string, out: Array<[string, string]>, depth: number): void {
  if (out.length >= MAX_STRINGS || depth > MAX_DEPTH) return;
  if (typeof value === "string") {
    if (absoluteFlavor(value)) out.push([path, value]);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectStrings(entry, `${path}[${index}]`, out, depth + 1));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(entry, path ? `${path}.${key}` : key, out, depth + 1);
    }
  }
}

/** Throws SymlinkPathError when any absolute path argument crosses a link. */
export function assertNoSymlinkedPaths(args: unknown): void {
  const candidates: Array<[string, string]> = [];
  collectStrings(args, "", candidates, 0);
  for (const [argumentPath, value] of candidates) {
    if (findSymlinkedSegment(value)) throw new SymlinkPathError(argumentPath || "path");
  }
}

/**
 * Operator-configured server-side write confinement (hardening follow-up to
 * #640). `PREMIERE_MCP_WRITE_ROOTS` is a path.delimiter-separated allowlist of
 * directories this server may write, overwrite, or delete files inside. It is
 * optional: unset, every disk-writing tool keeps its current behavior exactly
 * (backward compatible). Set, every writer below is confined to the roots,
 * regardless of what a tool argument claims. In particular a model-supplied
 * "approved_workspace_path" (caption/EDL export) is NOT a security boundary by
 * itself -- it is just another argument the model can set to anything -- so
 * when roots are configured, approved_workspace_path must also resolve inside
 * them.
 */
export const WRITE_ROOTS_ENV_VAR = "PREMIERE_MCP_WRITE_ROOTS";

export class WriteRootViolationError extends Error {
  readonly code = "WRITE_PATH_OUTSIDE_ALLOWED_ROOTS";
  constructor(readonly targetPath: string, readonly roots: readonly string[]) {
    super(
      `${targetPath} is outside the directories allowed by ${WRITE_ROOTS_ENV_VAR} (${roots.join(nodePath.delimiter)}). ` +
      `A model-supplied path argument such as "approved_workspace_path" is not a security boundary by itself; only the ` +
      `operator-configured ${WRITE_ROOTS_ENV_VAR} is. No file was written.`,
    );
    this.name = "WriteRootViolationError";
  }
}

function normalizeForCompare(value: string): string {
  const normalized = nodePath.normalize(value);
  return process.platform === "win32" || process.platform === "darwin" ? normalized.toLowerCase() : normalized;
}

function resolveRootForCompare(root: string): string | null {
  const trimmed = root.trim();
  if (!trimmed) return null;
  let real: string;
  try { real = realpathSync(trimmed); } catch { real = nodePath.resolve(trimmed); }
  return normalizeForCompare(real);
}

let cachedRootsEnv: string | undefined;
let cachedRoots: string[] | null = null;

/** Parses `PREMIERE_MCP_WRITE_ROOTS`; returns null when unset or empty (no confinement configured). */
export function getConfiguredWriteRoots(): string[] | null {
  const raw = process.env[WRITE_ROOTS_ENV_VAR];
  if (raw === cachedRootsEnv) return cachedRoots;
  cachedRootsEnv = raw;
  if (!raw || !raw.trim()) {
    cachedRoots = null;
    return null;
  }
  const roots = raw
    .split(nodePath.delimiter)
    .map((entry) => resolveRootForCompare(entry))
    .filter((entry): entry is string => entry !== null);
  cachedRoots = roots.length > 0 ? roots : null;
  return cachedRoots;
}

function isInsideRoot(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root.endsWith(nodePath.sep) ? root : `${root}${nodePath.sep}`);
}

/**
 * Resolves a (possibly not-yet-existing) write target to its real path: the
 * realpath of the deepest existing ancestor, joined with the remaining
 * not-yet-created segments. This mirrors `findSymlinkedSegment`'s walk but
 * also returns the resolved path for the write-roots comparison, so a symlink
 * cannot be used to redirect a write outside the existing ancestor's real
 * location.
 */
export function resolveWriteTarget(targetPath: string): string {
  if (!nodePath.isAbsolute(targetPath)) throw new WriteRootViolationError(targetPath, getConfiguredWriteRoots() ?? []);
  let current = nodePath.resolve(targetPath);
  const remainder: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(current);
      return remainder.length > 0 ? nodePath.join(real, ...remainder) : real;
    } catch {
      const parent = nodePath.dirname(current);
      if (parent === current) return remainder.length > 0 ? nodePath.join(current, ...remainder) : current;
      remainder.unshift(nodePath.basename(current));
      current = parent;
    }
  }
}

/**
 * Central write-confinement check: every tool that writes, overwrites, or
 * deletes a file on disk (directly via Node `fs`, or indirectly by embedding
 * the path into ExtendScript the CEP panel executes) must call this before
 * doing so. Returns the resolved absolute path to use for the write. When
 * `PREMIERE_MCP_WRITE_ROOTS` is unset this only normalizes/resolves the path
 * and never throws for containment (backward compatible); when set, it also
 * refuses any target outside the configured roots.
 */
export function assertWritePathAllowed(targetPath: string, label = "output_path"): string {
  if (typeof targetPath !== "string" || !targetPath.trim()) {
    throw new WriteRootViolationError(String(targetPath), getConfiguredWriteRoots() ?? []);
  }
  if (!nodePath.isAbsolute(targetPath)) {
    throw new Error(`${label} must be an absolute path`);
  }
  const resolved = resolveWriteTarget(targetPath);
  const roots = getConfiguredWriteRoots();
  if (!roots) return resolved;
  const compare = normalizeForCompare(resolved);
  if (!roots.some((root) => isInsideRoot(compare, root))) {
    throw new WriteRootViolationError(targetPath, roots);
  }
  return resolved;
}

/** Test-only: forces re-reading `PREMIERE_MCP_WRITE_ROOTS` on the next call. */
export function resetWriteRootsCacheForTests(): void {
  cachedRootsEnv = undefined;
  cachedRoots = null;
}

const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;

/** True when `value` looks like a URL or ffmpeg protocol prefix (http:, concat:, pipe:, subfile:, data:, file:, ...) rather than a plain local path. A Windows drive path like `C:\foo` is not a scheme. */
export function hasUrlOrProtocolScheme(value: string): boolean {
  if (WINDOWS_DRIVE_PATTERN.test(value)) return false;
  return URL_SCHEME_PATTERN.test(value);
}

export class MediaPathError extends Error {
  readonly code = "MEDIA_PATH_REFUSED";
  constructor(message: string) {
    super(message);
    this.name = "MediaPathError";
  }
}

/**
 * Confines an ffmpeg/ffprobe input argument to an existing local regular
 * file. Rejects URL/protocol-prefixed values (http:, concat:, subfile:,
 * pipe:, data:, file:, ...) that could make ffmpeg fetch a remote resource or
 * read an unintended local file through a non-`file` protocol (SSRF / path
 * confusion), rejects NUL bytes, and rejects a path through a symlinked
 * segment. This does not apply `PREMIERE_MCP_WRITE_ROOTS`: that allowlist
 * confines where this server writes, not every file it may read for analysis.
 */
export function assertLocalMediaPath(mediaPath: unknown, label = "media_path"): string {
  if (typeof mediaPath !== "string" || !mediaPath.trim()) {
    throw new MediaPathError(`${label} must be a non-empty local file path`);
  }
  if (mediaPath.includes("\0")) throw new MediaPathError(`${label} is not a valid path`);
  if (hasUrlOrProtocolScheme(mediaPath)) {
    throw new MediaPathError(`${label} must be a local file path, not a URL or protocol-prefixed value: ${mediaPath}`);
  }
  const resolved = nodePath.resolve(mediaPath);
  let stats;
  try {
    stats = statSync(resolved);
  } catch {
    throw new MediaPathError(`${label} not found on disk: ${resolved}`);
  }
  if (!stats.isFile()) throw new MediaPathError(`${label} must be an existing regular file: ${resolved}`);
  const symlinked = findSymlinkedSegment(resolved);
  if (symlinked) throw new SymlinkPathError(resolved);
  return resolved;
}

/** ffmpeg/ffprobe CLI args that restrict input demuxing to plain local files. Insert once per `-i`/probe target. */
export const FFMPEG_PROTOCOL_WHITELIST_ARGS: readonly string[] = ["-protocol_whitelist", "file"];
