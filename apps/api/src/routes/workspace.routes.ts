/**
 * workspace.routes.ts — REST endpoints for workspace operations
 *
 * POST /api/workspace/clone
 *   Clone a GitHub (or any public git) repo into a room's workspace.
 *   Body: { repoUrl: string, roomId: string }
 *   - Clones into /workspaces/{roomId}/
 *   - Emits updated file list to all users in the room via Socket.IO
 */

import { Router, type Request, type Response } from "express";
import { execSync } from "child_process";
import { Server }   from "socket.io";
import {
  ensureWorkspaceExists,
  getWorkspacePath,
  readWorkspace,
  deleteFolder,
} from "../services/workspace";
import fs from "fs";

// The router factory receives the Socket.IO server so it can emit events.
export function workspaceRouter(io: Server): Router {
  const router = Router();

  /**
   * POST /api/workspace/clone
   *
   * Clones a public git repo into the room's workspace folder.
   * If a workspace already exists for this room, it is cleared first
   * so we get a clean clone.
   *
   * On success: emits "room-files" to all sockets in the room with the
   * full file map, so every connected user's editor refreshes immediately.
   */
  router.post("/clone", async (req: Request, res: Response) => {
    const { repoUrl, roomId } = req.body as { repoUrl?: string; roomId?: string };

    // ── Validation ──────────────────────────────────────────────────────────
    if (!repoUrl || typeof repoUrl !== "string") {
      res.status(400).json({ error: "repoUrl is required" });
      return;
    }
    if (!roomId || typeof roomId !== "string") {
      res.status(400).json({ error: "roomId is required" });
      return;
    }
    // Very basic URL safety check — allow only http(s) git URLs
    if (!/^https?:\/\//i.test(repoUrl)) {
      res.status(400).json({ error: "Only http/https git URLs are supported" });
      return;
    }

    const wsPath = getWorkspacePath(roomId);

    try {
      // ── Clean existing workspace ──────────────────────────────────────────
      if (fs.existsSync(wsPath)) {
        fs.rmSync(wsPath, { recursive: true, force: true });
      }
      ensureWorkspaceExists(roomId);

      // ── Clone the repo ────────────────────────────────────────────────────
      // We clone into a temp sub-dir then move its contents up one level so
      // the workspace root IS the repo root (not workspace/repo-name/).
      const tmpDir  = `${wsPath}/__clone_tmp__`;
      const gitCmd  = `git clone --depth 1 "${repoUrl}" "${tmpDir}"`;

      console.log(`[workspace/clone] Running: ${gitCmd}`);
      execSync(gitCmd, { timeout: 60_000, stdio: "pipe" });

      // Move all contents from tmpDir up to wsPath
      const clonedEntries = fs.readdirSync(tmpDir);
      for (const entry of clonedEntries) {
        if (entry === ".git") {
          // Delete .git — we don't want version history cluttering the workspace
          fs.rmSync(`${tmpDir}/.git`, { recursive: true, force: true });
          continue;
        }
        fs.renameSync(`${tmpDir}/${entry}`, `${wsPath}/${entry}`);
      }
      fs.rmdirSync(tmpDir);

      // ── Read resulting file tree ──────────────────────────────────────────
      const fileMap = readWorkspace(roomId);

      // ── Emit to room ──────────────────────────────────────────────────────
      io.to(roomId).emit("room-files", fileMap);

      console.log(
        `[workspace/clone] Room ${roomId}: cloned ${repoUrl} → ${Object.keys(fileMap).length} files`
      );

      res.json({
        success:   true,
        roomId,
        fileCount: Object.keys(fileMap).length,
        files:     Object.keys(fileMap),
      });
    } catch (err: any) {
      console.error("[workspace/clone] Error:", err.message);
      // Return a user-friendly message; don't leak the full stderr
      const msg = err.message?.includes("not found")
        ? "Repository not found or is private"
        : err.message?.includes("already exists")
        ? "Clone target already exists"
        : "Failed to clone repository";
      res.status(500).json({ error: msg, detail: err.message });
    }
  });

  /**
   * GET /api/workspace/:roomId/files
   *
   * Returns the current file tree for a room's workspace.
   * Useful for debugging or for a future REST-based editor.
   */
  router.get("/:roomId/files", (req: Request, res: Response) => {
    const { roomId } = req.params;
    try {
      ensureWorkspaceExists(roomId);
      const fileMap = readWorkspace(roomId);
      res.json({ roomId, fileCount: Object.keys(fileMap).length, files: fileMap });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}