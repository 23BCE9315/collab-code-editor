/**
 * workspace.ts — Filesystem-backed workspace service
 *
 * Each room gets a real directory on disk:
 *   /workspaces/{roomId}/
 *
 * All file operations go through this service.
 * MongoDB is still used for metadata (room name, roles, activity, chat).
 * File CONTENTS are no longer stored in MongoDB — they live on disk.
 */

import fs   from "fs";
import path from "path";

// Root directory where all room workspaces live.
// Can be overridden via WORKSPACES_ROOT env var.
const WORKSPACES_ROOT = process.env.WORKSPACES_ROOT
  ? path.resolve(process.env.WORKSPACES_ROOT)
  : path.resolve(process.cwd(), "workspaces");

// ─── Path helpers ─────────────────────────────────────────────────────────────

/**
 * Returns the absolute path to a room's workspace directory.
 *   getWorkspacePath("abc123") → "/abs/path/workspaces/abc123"
 */
export function getWorkspacePath(roomId: string): string {
  // Sanitize roomId — only allow alphanumeric, dash, underscore
  const safe = roomId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(WORKSPACES_ROOT, safe);
}

/**
 * Resolves a file path relative to the room workspace.
 * Guards against path traversal attacks.
 */
function safeResolve(roomId: string, filePath: string): string {
  const wsRoot  = getWorkspacePath(roomId);
  // Normalize and strip any leading slashes / ".." segments
  const cleaned = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  const abs     = path.resolve(wsRoot, cleaned);

  // Prevent escaping the workspace root
  if (!abs.startsWith(wsRoot + path.sep) && abs !== wsRoot) {
    throw new Error(`Path traversal detected: ${filePath}`);
  }
  return abs;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures the workspace directory for a room exists.
 * Safe to call multiple times (idempotent).
 */
export function ensureWorkspaceExists(roomId: string): void {
  const wsPath = getWorkspacePath(roomId);
  if (!fs.existsSync(wsPath)) {
    fs.mkdirSync(wsPath, { recursive: true });
    console.log(`[workspace] Created workspace: ${wsPath}`);
  }
}

/**
 * Recursively reads all files in the workspace and returns them as a flat map:
 *   { "src/index.ts": "..content..", "README.md": "..content.." }
 *
 * Binary files are skipped (returns empty string for unreadable files).
 * Max file size: 2 MB per file (larger files skipped with a comment).
 */
export function readWorkspace(roomId: string): Record<string, string> {
  ensureWorkspaceExists(roomId);
  const wsPath = getWorkspacePath(roomId);
  const result: Record<string, string> = {};

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      // Skip hidden dirs (.git, .cache, etc.) and node_modules
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

      const absPath     = path.join(dir, entry.name);
      const relPath     = path.relative(wsPath, absPath).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        try {
          const stat = fs.statSync(absPath);
          if (stat.size > 2 * 1024 * 1024) {
            // File too large — show placeholder so tree still renders it
            result[relPath] = `// [File too large to display: ${stat.size} bytes]`;
            continue;
          }
          const content = fs.readFileSync(absPath, "utf8");
          result[relPath] = content;
        } catch {
          // Binary or unreadable file — include empty string so tree shows it
          result[relPath] = "";
        }
      }
    }
  }

  walk(wsPath);
  return result;
}

/**
 * Writes content to a file inside the workspace, creating parent dirs as needed.
 */
export function writeFile(roomId: string, filePath: string, content: string): void {
  ensureWorkspaceExists(roomId);
  const abs = safeResolve(roomId, filePath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/**
 * Deletes a single file from the workspace.
 * Silently succeeds if the file doesn't exist.
 */
export function deleteFile(roomId: string, filePath: string): void {
  const abs = safeResolve(roomId, filePath);
  try {
    fs.unlinkSync(abs);
    // Remove empty parent directories (up to workspace root)
    _removeEmptyDirs(path.dirname(abs), getWorkspacePath(roomId));
  } catch (err: any) {
    if (err.code !== "ENOENT") throw err;
  }
}

/**
 * Renames/moves a file within the workspace.
 * Creates target parent directories if needed.
 */
export function renameFile(roomId: string, oldPath: string, newPath: string): void {
  const absOld = safeResolve(roomId, oldPath);
  const absNew = safeResolve(roomId, newPath);
  fs.mkdirSync(path.dirname(absNew), { recursive: true });
  fs.renameSync(absOld, absNew);
  // Clean up any empty parent dirs left behind
  _removeEmptyDirs(path.dirname(absOld), getWorkspacePath(roomId));
}

/**
 * Deletes an entire folder and all its contents from the workspace.
 * Returns the list of file paths that were deleted (relative to workspace root).
 */
export function deleteFolder(roomId: string, folderPath: string): string[] {
  ensureWorkspaceExists(roomId);
  const wsPath  = getWorkspacePath(roomId);
  const absDir  = safeResolve(roomId, folderPath);
  const deleted: string[] = [];

  if (!fs.existsSync(absDir)) return deleted;

  function collectAndDelete(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        collectAndDelete(abs);
        fs.rmdirSync(abs);
      } else {
        deleted.push(path.relative(wsPath, abs).replace(/\\/g, "/"));
        fs.unlinkSync(abs);
      }
    }
  }

  collectAndDelete(absDir);
  try { fs.rmdirSync(absDir); } catch { /* may already be gone */ }
  return deleted;
}

/**
 * Renames a folder by renaming all files under oldPath → newPath.
 * Returns a map of { oldFilePath → newFilePath } for all affected files.
 */
export function renameFolder(
  roomId:  string,
  oldPath: string,
  newPath: string
): Record<string, string> {
  ensureWorkspaceExists(roomId);
  const wsPath    = getWorkspacePath(roomId);
  const absOld    = safeResolve(roomId, oldPath);
  const absNew    = safeResolve(roomId, newPath);
  const renamedFiles: Record<string, string> = {};

  if (!fs.existsSync(absOld)) return renamedFiles;

  fs.mkdirSync(path.dirname(absNew), { recursive: true });
  fs.renameSync(absOld, absNew);

  // Build the old→new map by walking the new location
  function walkNew(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkNew(abs);
      } else {
        const newRelPath = path.relative(wsPath, abs).replace(/\\/g, "/");
        const oldRelPath = newRelPath.replace(newPath + "/", oldPath + "/");
        renamedFiles[oldRelPath] = newRelPath;
      }
    }
  }

  walkNew(absNew);
  return renamedFiles;
}

/**
 * Checks whether a file exists in the workspace.
 */
export function fileExists(roomId: string, filePath: string): boolean {
  try {
    const abs = safeResolve(roomId, filePath);
    return fs.existsSync(abs);
  } catch {
    return false;
  }
}

/**
 * Reads a single file's content from the workspace.
 */
export function readFile(roomId: string, filePath: string): string {
  const abs = safeResolve(roomId, filePath);
  return fs.readFileSync(abs, "utf8");
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Walks up from `dir` removing empty directories, stopping at `stopAt`. */
function _removeEmptyDirs(dir: string, stopAt: string): void {
  if (dir === stopAt || !dir.startsWith(stopAt)) return;
  try {
    const entries = fs.readdirSync(dir);
    if (entries.length === 0) {
      fs.rmdirSync(dir);
      _removeEmptyDirs(path.dirname(dir), stopAt);
    }
  } catch { /* ignore */ }
}