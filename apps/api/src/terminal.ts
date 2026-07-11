/**
 * terminal.ts — PATCH for Task 3
 *
 * Find the place in your existing terminal.ts where node-pty spawns the shell.
 * It will look roughly like:
 *
 *   const pty = nodePty.spawn(shell, [], {
 *     name: "xterm-256color",
 *     cols: 80, rows: 24,
 *     cwd: process.cwd(),   // ← THIS LINE
 *     env: process.env as Record<string, string>,
 *   });
 *
 * Replace the `cwd` value with the room's workspace path:
 *
 *   import { ensureWorkspaceExists, getWorkspacePath } from "./services/workspace";
 *
 *   // When spawning the PTY for a room:
 *   ensureWorkspaceExists(roomId);
 *   const workDir = getWorkspacePath(roomId);
 *
 *   const pty = nodePty.spawn(shell, [], {
 *     name: "xterm-256color",
 *     cols: 80, rows: 24,
 *     cwd: workDir,          // ← workspace dir
 *     env: process.env as Record<string, string>,
 *   });
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * If your terminal manager has a getOrCreate(roomId, ...) method, the change
 * is in that function.  Below is a self-contained reference implementation
 * you can use to REPLACE your existing terminal.ts entirely if you prefer.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as nodePty from "node-pty";
import os           from "os";
import { ensureWorkspaceExists, getWorkspacePath } from "./services/workspace";

const MAX_HISTORY = 5000; // lines of scrollback to keep in memory

interface TerminalInstance {
  pty:     nodePty.IPty;
  workDir: string;
  history: string[];
}

class TerminalManager {
  private terminals = new Map<string, TerminalInstance>();

  // ── getOrCreate ─────────────────────────────────────────────────────────────
  getOrCreate(
    roomId:    string,
    onData:    (data: string) => void,
    onExit:    (code: number) => void,
  ): { terminal: TerminalInstance; isNew: boolean } {
    const existing = this.terminals.get(roomId);
    if (existing) return { terminal: existing, isNew: false };

    const inst = this._spawn(roomId, onData, onExit);
    return { terminal: inst, isNew: true };
  }

  // ── respawn ─────────────────────────────────────────────────────────────────
  respawn(
    roomId:  string,
    onData:  (data: string) => void,
    onExit:  (code: number) => void,
  ): TerminalInstance {
    this.kill(roomId);
    return this._spawn(roomId, onData, onExit);
  }

  // ── write ───────────────────────────────────────────────────────────────────
  write(roomId: string, data: string): void {
    this.terminals.get(roomId)?.pty.write(data);
  }

  // ── resize ──────────────────────────────────────────────────────────────────
  resize(roomId: string, cols: number, rows: number): void {
    const inst = this.terminals.get(roomId);
    if (!inst) return;
    try { inst.pty.resize(Math.max(2, cols), Math.max(2, rows)); } catch { /* ignore */ }
  }

  // ── getHistory ──────────────────────────────────────────────────────────────
  getHistory(roomId: string): string[] {
    return this.terminals.get(roomId)?.history ?? [];
  }

  // ── syncFiles ───────────────────────────────────────────────────────────────
  // Writes in-memory files to the workspace directory on disk.
  // This ensures the terminal always sees the latest editor state.
  syncFiles(roomId: string, files: Record<string, string>): void {
    ensureWorkspaceExists(roomId);
    const { writeFile } = require("./services/workspace") as typeof import("./services/workspace");
    for (const [filePath, content] of Object.entries(files)) {
      try {
        writeFile(roomId, filePath, content);
      } catch (err) {
        console.error(`[terminal] syncFiles error (${roomId}/${filePath}):`, err);
      }
    }
  }

  // ── kill ────────────────────────────────────────────────────────────────────
  kill(roomId: string): void {
    const inst = this.terminals.get(roomId);
    if (!inst) return;
    try { inst.pty.kill(); } catch { /* ignore */ }
    this.terminals.delete(roomId);
  }

  // ── killAll ─────────────────────────────────────────────────────────────────
  killAll(): void {
    this.terminals.forEach((_, roomId) => this.kill(roomId));
  }

  // ── _spawn (private) ────────────────────────────────────────────────────────
  private _spawn(
    roomId:  string,
    onData:  (data: string) => void,
    onExit:  (code: number) => void,
  ): TerminalInstance {
    // ── TASK 3: Use workspace dir as cwd ─────────────────────────────────────
    ensureWorkspaceExists(roomId);
    const workDir = getWorkspacePath(roomId);

    const shell = os.platform() === "win32" ? "cmd.exe" : (process.env.SHELL ?? "/bin/bash");

    const ptyProcess = nodePty.spawn(shell, [], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: workDir,   // ← workspace directory for this room
      env:  process.env as Record<string, string>,
    });

    const inst: TerminalInstance = { pty: ptyProcess, workDir, history: [] };
    this.terminals.set(roomId, inst);

    ptyProcess.onData((data) => {
      // Accumulate scrollback history (cap to MAX_HISTORY chars total)
      inst.history.push(data);
      const totalLen = inst.history.reduce((s, c) => s + c.length, 0);
      while (inst.history.length > 1 && totalLen > MAX_HISTORY) {
        inst.history.shift();
      }
      onData(data);
    });

    ptyProcess.onExit(({ exitCode }) => {
      this.terminals.delete(roomId);
      onExit(exitCode ?? 0);
    });

    console.log(`[terminal] Spawned shell for room ${roomId} → cwd: ${workDir}`);
    return inst;
  }
}

export const terminalManager = new TerminalManager();