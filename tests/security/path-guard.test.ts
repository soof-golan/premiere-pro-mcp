import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertLocalMediaPath,
  assertNoSymlinkedPaths,
  assertWritePathAllowed,
  findSymlinkedSegment,
  getConfiguredWriteRoots,
  hasUrlOrProtocolScheme,
  MediaPathError,
  resetWriteRootsCacheForTests,
  SymlinkPathError,
  WriteRootViolationError,
} from "../../src/security/path-guard.js";

// Directory junctions need no elevation on Windows; POSIX uses plain symlinks.
const base = mkdtempSync(join(tmpdir(), "path-guard-"));
const workspace = join(base, "workspace");
const outside = join(base, "outside");
mkdirSync(join(workspace, "media"), { recursive: true });
mkdirSync(outside);
writeFileSync(join(workspace, "media", "clip.mp4"), "x");
writeFileSync(join(outside, "secret.mp4"), "x");
const linkedDir = join(workspace, "linked");
symlinkSync(outside, linkedDir, process.platform === "win32" ? "junction" : "dir");

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("server-side symlink confinement for UXP paths (#640)", () => {
  it("allows real files, new output files, and non-path strings", () => {
    expect(findSymlinkedSegment(join(workspace, "media", "clip.mp4"))).toBeNull();
    expect(findSymlinkedSegment(join(workspace, "media", "new-export.png"))).toBeNull();
    expect(findSymlinkedSegment(join(workspace, "not-yet", "deeper", "out.mov"))).toBeNull();
    expect(() => assertNoSymlinkedPaths({
      mediaPath: join(workspace, "media", "clip.mp4"),
      caption: "Hello / world",
      url: "file:///tmp/x",
      relative: "media/clip.mp4",
      count: 3,
    })).not.toThrow();
  });

  it("refuses a file reached through a linked directory", () => {
    expect(findSymlinkedSegment(join(linkedDir, "secret.mp4"))).toBe(linkedDir);
  });

  it("refuses a linked output directory even when the leaf does not exist yet", () => {
    expect(findSymlinkedSegment(join(linkedDir, "frame.png"))).toBe(linkedDir);
  });

  it("finds linked paths nested in arrays and objects and names only the argument", () => {
    let caught: unknown;
    try {
      assertNoSymlinkedPaths({ items: [{ path: join(workspace, "media", "clip.mp4") }, { path: join(linkedDir, "secret.mp4") }] });
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(SymlinkPathError);
    expect((caught as SymlinkPathError).code).toBe("UXP_PATH_SYMLINK_REFUSED");
    expect((caught as Error).message).toContain("items[1].path");
    expect((caught as Error).message).not.toContain(outside);
    expect((caught as Error).message).toContain("No command was sent");
  });

  it("refuses a linked file on hosts that allow file symlinks", () => {
    const linkedFile = join(workspace, "media", "linked.mp4");
    try { symlinkSync(join(outside, "secret.mp4"), linkedFile, "file"); }
    catch { return; } // Windows without Developer Mode cannot create file symlinks.
    expect(findSymlinkedSegment(linkedFile)).toBe(linkedFile);
  });

  it("ignores strings that are not absolute local paths", () => {
    expect(findSymlinkedSegment("relative/linked/secret.mp4")).toBeNull();
    expect(findSymlinkedSegment("//server/share")).toBeNull();
    expect(findSymlinkedSegment(`${linkedDir}\0`)).toBeNull();
  });
});

describe("PREMIERE_MCP_WRITE_ROOTS server-side write confinement", () => {
  const originalEnv = process.env.PREMIERE_MCP_WRITE_ROOTS;
  const allowedRoot = join(workspace, "media");
  const otherAllowedRoot = join(base, "other-allowed");
  mkdirSync(otherAllowedRoot, { recursive: true });

  beforeEach(() => {
    resetWriteRootsCacheForTests();
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.PREMIERE_MCP_WRITE_ROOTS;
    else process.env.PREMIERE_MCP_WRITE_ROOTS = originalEnv;
    resetWriteRootsCacheForTests();
  });

  it("is unset by default and does not confine writes (backward compatible)", () => {
    delete process.env.PREMIERE_MCP_WRITE_ROOTS;
    expect(getConfiguredWriteRoots()).toBeNull();
    const outside = join(base, "outside", "new-export.mov");
    expect(() => assertWritePathAllowed(outside)).not.toThrow();
    expect(assertWritePathAllowed(outside)).toBe(outside);
  });

  it("allows a target inside a configured root, including a not-yet-created file", () => {
    process.env.PREMIERE_MCP_WRITE_ROOTS = allowedRoot;
    resetWriteRootsCacheForTests();
    const target = join(allowedRoot, "new-export.mov");
    expect(() => assertWritePathAllowed(target)).not.toThrow();
  });

  it("allows a target inside any of several delimited roots", () => {
    process.env.PREMIERE_MCP_WRITE_ROOTS = [allowedRoot, otherAllowedRoot].join(delimiter);
    resetWriteRootsCacheForTests();
    expect(() => assertWritePathAllowed(join(otherAllowedRoot, "out.mov"))).not.toThrow();
  });

  it("refuses a target outside the configured roots", () => {
    process.env.PREMIERE_MCP_WRITE_ROOTS = allowedRoot;
    resetWriteRootsCacheForTests();
    const target = join(outside, "new-export.mov");
    let caught: unknown;
    try { assertWritePathAllowed(target); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(WriteRootViolationError);
    expect((caught as WriteRootViolationError).code).toBe("WRITE_PATH_OUTSIDE_ALLOWED_ROOTS");
    expect((caught as Error).message).toContain("approved_workspace_path");
  });

  it("refuses a .. escape even when the literal string starts with an allowed root", () => {
    process.env.PREMIERE_MCP_WRITE_ROOTS = allowedRoot;
    resetWriteRootsCacheForTests();
    const target = join(allowedRoot, "..", "..", "outside", "escape.mov");
    expect(() => assertWritePathAllowed(target)).toThrow(WriteRootViolationError);
  });

  it("refuses a symlinked directory used to escape a configured root", () => {
    process.env.PREMIERE_MCP_WRITE_ROOTS = workspace;
    resetWriteRootsCacheForTests();
    const target = join(linkedDir, "escape.mov");
    expect(() => assertWritePathAllowed(target)).toThrow(WriteRootViolationError);
  });

  it("refuses a relative path", () => {
    process.env.PREMIERE_MCP_WRITE_ROOTS = allowedRoot;
    resetWriteRootsCacheForTests();
    expect(() => assertWritePathAllowed("relative/export.mov")).toThrow(/absolute/);
  });
});

describe("assertLocalMediaPath (ffmpeg/ffprobe input confinement)", () => {
  const clip = join(workspace, "media", "clip.mp4");

  it("accepts an existing local regular file", () => {
    expect(assertLocalMediaPath(clip)).toBe(clip);
  });

  it("rejects a missing file", () => {
    expect(() => assertLocalMediaPath(join(workspace, "media", "missing.mp4"))).toThrow(MediaPathError);
  });

  it("rejects a directory", () => {
    expect(() => assertLocalMediaPath(workspace)).toThrow(MediaPathError);
  });

  it("rejects URL and ffmpeg-protocol-prefixed values", () => {
    for (const value of ["http://example.com/evil.mp4", "https://example.com/x.mp4", "concat:a.mp4|b.mp4", "pipe:0", "subfile:,start,0,end,10,:clip.mp4", "data:text/plain,x"]) {
      expect(() => assertLocalMediaPath(value)).toThrow(MediaPathError);
    }
  });

  it("rejects a NUL byte", () => {
    expect(() => assertLocalMediaPath(`${clip}\0`)).toThrow(MediaPathError);
  });

  it("rejects a non-string value", () => {
    expect(() => assertLocalMediaPath(undefined)).toThrow(MediaPathError);
  });

  it("rejects a path through a symlinked directory", () => {
    expect(() => assertLocalMediaPath(join(linkedDir, "secret.mp4"))).toThrow(SymlinkPathError);
  });
});

describe("hasUrlOrProtocolScheme", () => {
  it("does not treat a Windows drive path as a protocol scheme", () => {
    expect(hasUrlOrProtocolScheme("C:\\Users\\me\\clip.mp4")).toBe(false);
    expect(hasUrlOrProtocolScheme("C:/Users/me/clip.mp4")).toBe(false);
  });

  it("recognizes common URL and ffmpeg protocol prefixes", () => {
    for (const value of ["http://x", "https://x", "file:///x", "concat:a|b", "pipe:1", "data:,x"]) {
      expect(hasUrlOrProtocolScheme(value)).toBe(true);
    }
  });

  it("treats a plain absolute path as not having a scheme", () => {
    expect(hasUrlOrProtocolScheme("/Users/me/clip.mp4")).toBe(false);
  });
});
