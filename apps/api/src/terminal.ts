/**
 * terminal.ts — Per-socket PTY manager (Windows + Linux/Mac compatible)
 *
 * Each socket gets its own independent PTY session keyed by socketId.
 * Files are written to /workspaces/{roomId}/ — NOT synced on every join.
 *
 * Windows fix: node-pty on Windows requires useConpty:false to avoid
 * "AttachConsole failed" errors. We also use cmd.exe as the shell since
 * PowerShell has ConPTY compatibility issues with node-pty on Windows.
 */

import * as nodePty from "node-pty";
import os           from "os";
import fs           from "fs";
import path         from "path";
import { ensureWorkspaceExists, getWorkspacePath, writeFile } from "./services/workspace";

const MAX_HISTORY_BYTES = 200_000;
const IS_WIN = os.platform() === "win32";

// ─── Types ────────────────────────────────────────────────────────────────────

interface TerminalSession {
  pty:      nodePty.IPty;
  roomId:   string;
  socketId: string;
  workDir:  string;
  history:  string;
  cols:     number;
  rows:     number;
}

// ─── Manager ─────────────────────────────────────────────────────────────────

class TerminalManager {
  private sessions    = new Map<string, TerminalSession>();
  private roomSockets = new Map<string, Set<string>>();

  // ── getOrCreate ─────────────────────────────────────────────────────────────
  getOrCreate(
    socketId: string,
    roomId:   string,
    onData:   (data: string) => void,
    onExit:   (code: number) => void,
    cols = 120,
    rows = 30,
  ): { session: TerminalSession; isNew: boolean } {
    const existing = this.sessions.get(socketId);
    if (existing) return { session: existing, isNew: false };
    const session = this._spawn(socketId, roomId, onData, onExit, cols, rows);
    return { session, isNew: true };
  }

  // ── write ───────────────────────────────────────────────────────────────────
  write(socketId: string, data: string): void {
    this.sessions.get(socketId)?.pty.write(data);
  }

  // ── resize ──────────────────────────────────────────────────────────────────
  resize(socketId: string, cols: number, rows: number): void {
    const s = this.sessions.get(socketId);
    if (!s) return;
    const c = Math.max(2, Math.min(cols, 500));
    const r = Math.max(2, Math.min(rows, 200));
    try { s.pty.resize(c, r); s.cols = c; s.rows = r; } catch { }
  }

  // ── getHistory ──────────────────────────────────────────────────────────────
  getHistory(socketId: string): string {
    return this.sessions.get(socketId)?.history ?? "";
  }

  // ── kill ────────────────────────────────────────────────────────────────────
  kill(socketId: string): void {
    const s = this.sessions.get(socketId);
    if (!s) return;
    try { s.pty.kill(); } catch { }
    this.sessions.delete(socketId);
    this.roomSockets.get(s.roomId)?.delete(socketId);
    console.log(`[terminal] Killed session for socket ${socketId}`);
  }

  // ── killAllForRoom ──────────────────────────────────────────────────────────
  killAllForRoom(roomId: string): void {
    const sockets = this.roomSockets.get(roomId);
    if (!sockets) return;
    for (const sid of [...sockets]) this.kill(sid);
    this.roomSockets.delete(roomId);
  }

  // ── killAll ─────────────────────────────────────────────────────────────────
  killAll(): void {
    for (const socketId of [...this.sessions.keys()]) this.kill(socketId);
  }

  // ── hasSession ──────────────────────────────────────────────────────────────
  hasSession(socketId: string): boolean {
    return this.sessions.has(socketId);
  }

  // ── getSession ──────────────────────────────────────────────────────────────
  getSession(socketId: string): TerminalSession | undefined {
    return this.sessions.get(socketId);
  }

  // ── respawn ─────────────────────────────────────────────────────────────────
  respawn(
    socketId: string,
    roomId:   string,
    onData:   (data: string) => void,
    onExit:   (code: number) => void,
  ): TerminalSession {
    const old = this.sessions.get(socketId);
    const cols = old?.cols ?? 120;
    const rows = old?.rows ?? 30;
    this.kill(socketId);
    return this._spawn(socketId, roomId, onData, onExit, cols, rows);
  }

  // ── syncFiles (async, non-blocking) ─────────────────────────────────────────
  syncFiles(roomId: string, files: Record<string, string>): void {
    ensureWorkspaceExists(roomId);
    this._syncFilesAsync(roomId, files).catch(err =>
      console.error(`[terminal] syncFiles error (${roomId}):`, err)
    );
  }

  private async _syncFilesAsync(
    roomId: string,
    files: Record<string, string>
  ): Promise<void> {
    const entries = Object.entries(files);
    if (!entries.length) return;
    const BATCH = 20;
    for (let i = 0; i < entries.length; i += BATCH) {
      const batch = entries.slice(i, i + BATCH);
      await Promise.all(batch.map(([filePath, content]) =>
        new Promise<void>(resolve => {
          try { writeFile(roomId, filePath, content); } catch { }
          resolve();
        })
      ));
      if (i + BATCH < entries.length) {
        await new Promise(r => setImmediate(r));
      }
    }
  }

  // ── _spawn (private) ────────────────────────────────────────────────────────
  private _spawn(
    socketId: string,
    roomId:   string,
    onData:   (data: string) => void,
    onExit:   (code: number) => void,
    cols:     number,
    rows:     number,
  ): TerminalSession {
    ensureWorkspaceExists(roomId);
    const workDir = getWorkspacePath(roomId);
    const shell   = this._detectShell();

    // ── node-pty spawn options ────────────────────────────────────────────────
    // Windows: useConpty MUST be false to avoid "AttachConsole failed" error.
    // This error happens because node-pty tries to attach to the current
    // console before creating the ConPTY — which fails in server contexts.
    // With useConpty:false, node-pty uses the legacy winpty backend which
    // works reliably on Windows servers.
    const spawnOptions: nodePty.IWindowsPtyForkOptions & nodePty.IPtyForkOptions = {
      name: "xterm-256color",
      cols: Math.max(10, cols),
      rows: Math.max(2, rows),
      cwd:  workDir,
      env:  {
        ...(process.env as Record<string, string>),
        TERM:        "xterm-256color",
        COLORTERM:   "truecolor",
        FORCE_COLOR: "1",
        // Prevent bash warning about terminal process groups in Linux containers
        BASH_ENV:    "",
      },
      // Windows-only: disable ConPTY, use winpty backend
      ...(IS_WIN ? { useConpty: false } : {}),
    };

    let pty: nodePty.IPty;
    try {
      pty = nodePty.spawn(shell, [], spawnOptions);
    } catch (err) {
      // If the preferred shell fails, fall back to the safest option
      const fallback = IS_WIN ? "cmd.exe" : "/bin/sh";
      console.error(`[terminal] Failed to spawn ${shell}, falling back to ${fallback}:`, err);
      pty = nodePty.spawn(fallback, [], { ...spawnOptions, name: "xterm-color" });
    }

    const session: TerminalSession = {
      pty, roomId, socketId, workDir, history: "", cols, rows,
    };
    this.sessions.set(socketId, session);

    if (!this.roomSockets.has(roomId)) this.roomSockets.set(roomId, new Set());
    this.roomSockets.get(roomId)!.add(socketId);

    pty.onData((data: string) => {
      session.history += data;
      if (session.history.length > MAX_HISTORY_BYTES) {
        session.history = session.history.slice(session.history.length - MAX_HISTORY_BYTES);
      }
      onData(data);
    });

    pty.onExit(({ exitCode }) => {
      // Only clean up if this session is still current
      // (avoids double-cleanup from kill() + onExit racing)
      if (this.sessions.get(socketId) === session) {
        this.sessions.delete(socketId);
        this.roomSockets.get(roomId)?.delete(socketId);
      }
      onExit(exitCode ?? 0);
    });

    console.log(`[terminal] Spawned ${shell} for socket ${socketId} in room ${roomId} → ${workDir}`);
    return session;
  }

  // ── _detectShell ─────────────────────────────────────────────────────────────
  private _detectShell(): string {
    if (IS_WIN) {
      // On Windows, cmd.exe works most reliably with node-pty's winpty backend.
      // PowerShell can be used but requires ConPTY which fails in server mode.
      // Users can still run powershell by typing "powershell" in the terminal.
      const candidates = [
        process.env.COMSPEC,                                                         // usually cmd.exe
        process.env.SYSTEMROOT + "\\System32\\cmd.exe",
        "cmd.exe",
      ];
      for (const c of candidates) {
        if (c && fs.existsSync(c)) return c;
      }
      return "cmd.exe";
    }

    // Unix: honour $SHELL env var, fall back through common shells
    const envShell = process.env.SHELL;
    if (envShell && fs.existsSync(envShell)) return envShell;

    for (const s of ["/bin/bash", "/usr/bin/bash", "/bin/zsh", "/usr/bin/zsh", "/bin/sh"]) {
      if (fs.existsSync(s)) return s;
    }
    return "/bin/sh";
  }
}

export const terminalManager = new TerminalManager();