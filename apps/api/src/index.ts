/**
 * index.ts — Collab Code Editor API Server
 *
 * Folder system architecture:
 *   Files are stored on disk under /workspaces/{roomId}/.
 *   MongoDB is still used for: room metadata, roles, activity log, chat.
 *   File CONTENTS are no longer stored in MongoDB (removed from Room.files Map).
 *
 * Socket events added/changed:
 *   join-room     → loads files from filesystem via readWorkspace()
 *   create-file   → writes file to disk
 *   delete-file   → deletes from disk
 *   rename-file   → renames on disk
 *   code-change   → debounced write to disk (replaces MongoDB file store)
 *   create-folder → creates dir + .gitkeep sentinel on disk
 *   delete-folder → deletes dir recursively from disk
 *   rename-folder → renames dir on disk
 *   move-file     → renames file across dirs on disk
 *
 * Everything else (chat, activity, roles, terminal, cursors) is unchanged.
 */

import dotenv from "dotenv";
dotenv.config({ override: true });

import express, { type Request, type Response, type NextFunction } from "express";
import cors          from "cors";
import http          from "http";
import mongoose      from "mongoose";
import { Server }    from "socket.io";
import runCodeRouter from "./runCode";
import roomsRouter   from "./routes/rooms";
import aiRouter      from "./routes/ai.routes";
import { workspaceRouter }  from "./routes/workspace.routes";
import { terminalManager }  from "./terminal";
import { Room, Activity, ChatMessage } from "./models";
import type { Role } from "./models";

// ── Workspace service ────────────────────────────────────────────────────────
import {
  ensureWorkspaceExists,
  readWorkspace,
  writeFile       as wsWriteFile,
  deleteFile      as wsDeleteFile,
  renameFile      as wsRenameFile,
  deleteFolder    as wsDeleteFolder,
  renameFolder    as wsRenameFolder,
  getWorkspacePath,
} from "./services/workspace";

// ─── Types ────────────────────────────────────────────────────────────────────

interface RoomUser {
  uid:       string;
  name:      string;
  email:     string;
  photoURL?: string;
  socketId:  string;
  role:      Role;
}

interface CursorPayload {
  roomId:           string;
  user:             RoomUser;
  lineNumber:       number;
  column:           number;
  startLineNumber?: number;
  startColumn?:     number;
  endLineNumber?:   number;
  endColumn?:       number;
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────

const MONGO_URI = process.env.MONGO_URI ?? "mongodb://localhost:27017/collab-editor";
console.log("MONGO_URI resolved to:", MONGO_URI);

async function connectDB(): Promise<void> {
  await mongoose.connect(MONGO_URI, { maxPoolSize: 10 });
  console.log("✅ MongoDB connected");
}

// ─── Express ──────────────────────────────────────────────────────────────────


const app = express();

app.use(cors({
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://collab-code-editor-kappa.vercel.app"
  ],
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
}));

app.use(express.json({ limit: "4mb" }));


app.use("/api/run",   runCodeRouter);
app.use("/api/rooms", roomsRouter);
app.use("/api/ai",    aiRouter);
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const server = http.createServer(app);

// ─── Socket.IO ────────────────────────────────────────────────────────────────

const io = new Server(server, {
  
cors: {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://collab-code-editor-kappa.vercel.app"
  ],
  methods: ["GET", "POST"]
},

});

// ── Register workspace REST routes (needs io for clone→emit) ─────────────────
app.use("/api/workspace", workspaceRouter(io));

// Error handler (must come AFTER routes)
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status  = (err as { status?: number }).status ?? 500;
  const message = err instanceof Error ? err.message : "Internal server error";
  if (status >= 500) console.error("[ERROR]", err);
  res.status(status).json({ error: message });
});

// ─── In-memory state ──────────────────────────────────────────────────────────

const roomUsers      = new Map<string, Map<string, RoomUser>>();
const lastCursorHash = new Map<string, string>();
const codeDebounce   = new Map<string, ReturnType<typeof setTimeout>>();
const ACTIVITY_CAP   = 200;
const CHAT_CAP       = 300;

// socketId → roomId: lets terminal handlers find the room without a payload field
const socketRoom     = new Map<string, string>();

// socketId → queued input data while join-room is still resolving
const pendingInput   = new Map<string, string[]>();

// ─── Role helpers ─────────────────────────────────────────────────────────────

function getRole(roomId: string, socketId: string): Role | undefined {
  return roomUsers.get(roomId)?.get(socketId)?.role;
}
const canEdit   = (r: Role | undefined): boolean => r === "owner" || r === "editor";
const canDelete = (r: Role | undefined): boolean => r === "owner";
const canRename = (r: Role | undefined): boolean => r === "owner" || r === "editor";

async function assignRole(roomId: string, uid: string, role: Role): Promise<void> {
  try {
    await Room.findOneAndUpdate(
      { roomId },
      { $set: { [`roles.${uid}`]: role } },
      { upsert: true }
    );
  } catch (err) { console.error("assignRole DB error:", err); }
}

async function loadRoles(roomId: string): Promise<Map<string, Role>> {
  try {
    const doc = await Room.findOne({ roomId });
    return (doc?.roles as Map<string, Role> | undefined) ?? new Map<string, Role>();
  } catch { return new Map<string, Role>(); }
}

// ─── General helpers ──────────────────────────────────────────────────────────

function getUser(roomId: string, socketId: string): RoomUser | undefined {
  return roomUsers.get(roomId)?.get(socketId);
}

function broadcastRoomUsers(roomId: string): void {
  const room = roomUsers.get(roomId);
  if (room) io.to(roomId).emit("room-users", Array.from(room.values()));
}

async function broadcastActivity(
  roomId: string, user: RoomUser, action: string, target?: string
): Promise<void> {
  const activity = {
    id:        `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    uid:       user.uid,
    userName:  user.name,
    action,
    target,
    timestamp: Date.now(),
  };
  io.to(roomId).emit("team-activity", activity);
  try {
    await Activity.create({ roomId, ...activity });
    const count = await Activity.countDocuments({ roomId });
    if (count > ACTIVITY_CAP) {
      const oldest = await Activity.find({ roomId })
        .sort({ timestamp: 1 })
        .limit(count - ACTIVITY_CAP)
        .select("_id").lean();
      await Activity.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
    }
  } catch (err: unknown) {
    if ((err as { code?: number }).code !== 11000) console.error("Activity persist error:", err);
  }
}

/**
 * Debounced file write to disk — coalesces rapid edits into a single fs write.
 * Replaces the old MongoDB persistFileDebounced.
 */
function persistFileDebounced(roomId: string, fileName: string, code: string): void {
  const key      = `${roomId}::${fileName}`;
  const existing = codeDebounce.get(key);
  if (existing) clearTimeout(existing);

  codeDebounce.set(key, setTimeout(() => {
    codeDebounce.delete(key);
    try {
      wsWriteFile(roomId, fileName, code);
    } catch (err) {
      console.error(`[workspace] persistFile error (${roomId}/${fileName}):`, err);
    }
  }, 1500));
}

function cursorChanged(socketId: string, p: CursorPayload): boolean {
  const hash = `${p.lineNumber}:${p.column}:${p.startLineNumber ?? ""}:${p.endLineNumber ?? ""}:${p.startColumn ?? ""}:${p.endColumn ?? ""}`;
  if (lastCursorHash.get(socketId) === hash) return false;
  lastCursorHash.set(socketId, hash);
  return true;
}

/**
 * Cancels debounce timers for all files under a folder prefix.
 * Used before deleting a folder to avoid ghost writes after deletion.
 */
function cancelDebouncesForPrefix(roomId: string, prefix: string): void {
  const roomPrefix = `${roomId}::${prefix}`;
  for (const [key, timer] of codeDebounce.entries()) {
    if (key.startsWith(roomPrefix)) {
      clearTimeout(timer);
      codeDebounce.delete(key);
    }
  }
}

// ─── Socket handlers ──────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("Socket connected:", socket.id);

  // ── join-room ────────────────────────────────────────────────────────────────
  socket.on(
    "join-room",
    async ({ roomId, user }: { roomId: string; user: Omit<RoomUser, "socketId" | "role"> }) => {
      socket.join(roomId);
      if (!roomUsers.has(roomId)) roomUsers.set(roomId, new Map());
      const usersInRoom = roomUsers.get(roomId)!;

      const persistedRoles = await loadRoles(roomId);
      const role: Role = persistedRoles.has(user.uid)
        ? persistedRoles.get(user.uid)!
        : usersInRoom.size === 0 && persistedRoles.size === 0 ? "owner" : "editor";

      await assignRole(roomId, user.uid, role);
      if (!usersInRoom.has(socket.id)) usersInRoom.set(socket.id, { ...user, socketId: socket.id, role });

      // Track which room this socket is in — used by terminal handlers to
      // resolve role without requiring roomId in every payload
      socketRoom.set(socket.id, roomId);

      broadcastRoomUsers(roomId);
      socket.emit("your-role", { role });

      // Send this socket's own terminal history (per-socket session)
      const history = terminalManager.getHistory(socket.id);
      if (history.length > 0) socket.emit("terminal-history", history);

      // Flush any input that arrived before join-room finished
      const queued = pendingInput.get(socket.id);
      if (queued?.length && canEdit(role)) {
        pendingInput.delete(socket.id);
        for (const data of queued) terminalManager.write(socket.id, data);
      } else {
        pendingInput.delete(socket.id);
      }

      try {
        // ── Load room metadata from MongoDB (unchanged) ────────────────────
        const roomDoc = await Room.findOne({ roomId });
        if (roomDoc) {
          socket.emit("room-meta", {
            roomId:    roomDoc.roomId,
            roomName:  roomDoc.roomName,
            createdBy: roomDoc.createdBy,
          });
        }

        // ── Load files from FILESYSTEM (replaces MongoDB files map) ────────
        ensureWorkspaceExists(roomId);
        const fileMap = readWorkspace(roomId);

        if (Object.keys(fileMap).length > 0) {
          socket.emit("room-files", fileMap);
        } else {
          // Workspace is empty — ask an existing peer for their in-memory state
          // (handles the case where a room was just created and has no files yet)
          socket.to(roomId).emit("request-code-sync", { socketId: socket.id });
        }

        // ── Activity + chat history from MongoDB (unchanged) ───────────────
        const acts = await Activity.find({ roomId }).sort({ timestamp: -1 }).limit(100).lean();
        if (acts.length) socket.emit("activity-history", acts.reverse());
        const msgs = await ChatMessage.find({ roomId }).sort({ timestamp: -1 }).limit(100).lean();
        if (msgs.length) socket.emit("chat-history", msgs.reverse());

        // Ensure the Room doc exists in MongoDB (for metadata / roles)
        await Room.findOneAndUpdate({ roomId }, {}, { upsert: true, setDefaultsOnInsert: true });
      } catch (err) {
        console.error("join-room error:", err);
        socket.to(roomId).emit("request-code-sync", { socketId: socket.id });
      }

      const resolved = usersInRoom.get(socket.id)!;
      await broadcastActivity(roomId, resolved, "joined the room");
      console.log(`${user.name} joined ${roomId} as ${role}`);
    }
  );

  // ── change-role ──────────────────────────────────────────────────────────────
  // UNCHANGED — roles still stored in MongoDB
  socket.on(
    "change-role",
    async ({ roomId, targetUid, newRole }: { roomId: string; targetUid: string; newRole: Role }) => {
      // Check in-memory role first, then fall back to persisted roles
      // (handles the race where roomUsers isn't populated yet)
      const actorRole = getRole(roomId, socket.id);
      if (actorRole !== "owner") {
        socket.emit("permission-denied", { action: "change-role", reason: "Only the owner can change roles" });
        return;
      }
      const room = roomUsers.get(roomId);
      if (room) room.forEach((u, sid) => {
        if (u.uid === targetUid) { room.set(sid, { ...u, role: newRole }); io.to(sid).emit("your-role", { role: newRole }); }
      });
      await assignRole(roomId, targetUid, newRole);
      broadcastRoomUsers(roomId);
      const actor = getUser(roomId, socket.id);
      if (actor) await broadcastActivity(roomId, actor, "changed role", `${newRole} for a member`);
    }
  );

  // ── code-change ──────────────────────────────────────────────────────────────
  // Changed: debounce writes to DISK instead of MongoDB
  socket.on(
    "code-change",
    ({ roomId, fileName, code }: { roomId: string; fileName: string; code: string }) => {
      if (!canEdit(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "code-change", reason: "Viewers cannot edit files" });
        return;
      }
      socket.to(roomId).emit("receive-code", { fileName, code });
      // persistFileDebounced writes to disk — no need for syncFiles here
      persistFileDebounced(roomId, fileName, code);
    }
  );

  // ── create-file ──────────────────────────────────────────────────────────────
  // Changed: also creates the physical file on disk
  socket.on(
    "create-file",
    async ({ roomId, fileName }: { roomId: string; fileName: string }) => {
      if (!canEdit(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "create-file", reason: "Viewers cannot create files" });
        return;
      }
      socket.to(roomId).emit("file-created", fileName);

      // Write empty file to disk (creates parent dirs automatically)
      try {
        wsWriteFile(roomId, fileName, "");
      } catch (err) {
        console.error(`[workspace] create-file error (${roomId}/${fileName}):`, err);
      }

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "created", fileName);
    }
  );

  // ── delete-file ──────────────────────────────────────────────────────────────
  // Changed: deletes from disk
  socket.on(
    "delete-file",
    async ({ roomId, fileName }: { roomId: string; fileName: string }) => {
      if (!canDelete(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "delete-file", reason: "Only the owner can delete files" });
        return;
      }
      socket.to(roomId).emit("file-deleted", fileName);

      // Cancel any pending write, then delete from disk
      const key = `${roomId}::${fileName}`;
      const t = codeDebounce.get(key);
      if (t) { clearTimeout(t); codeDebounce.delete(key); }

      try {
        wsDeleteFile(roomId, fileName);
      } catch (err) {
        console.error(`[workspace] delete-file error (${roomId}/${fileName}):`, err);
      }

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "deleted", fileName);
    }
  );

  // ── rename-file ──────────────────────────────────────────────────────────────
  // Changed: renames on disk
  socket.on(
    "rename-file",
    async ({ roomId, oldFileName, newFileName }: { roomId: string; oldFileName: string; newFileName: string }) => {
      if (!canRename(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "rename-file", reason: "Viewers cannot rename files" });
        return;
      }
      socket.to(roomId).emit("file-renamed", { oldFileName, newFileName });

      try {
        wsRenameFile(roomId, oldFileName, newFileName);
      } catch (err) {
        console.error(`[workspace] rename-file error (${roomId}):`, err);
      }

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "renamed", `${oldFileName} → ${newFileName}`);
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // FOLDER OPERATIONS — now backed by real filesystem
  // ════════════════════════════════════════════════════════════════════════════

  socket.on(
    "create-folder",
    async ({ roomId, folderPath }: { roomId: string; folderPath: string }) => {
      if (!canEdit(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "create-folder", reason: "Viewers cannot create folders" });
        return;
      }
      const normalized = folderPath.replace(/\/+$/, "");
      const sentinel   = `${normalized}/.gitkeep`;

      io.to(roomId).emit("file-created", sentinel);

      try {
        wsWriteFile(roomId, sentinel, "");
      } catch (err) {
        console.error(`[workspace] create-folder error (${roomId}/${folderPath}):`, err);
      }

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "created folder", normalized);
    }
  );

  socket.on(
    "delete-folder",
    async ({ roomId, folderPath }: { roomId: string; folderPath: string }) => {
      if (!canDelete(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "delete-folder", reason: "Only the owner can delete folders" });
        return;
      }
      const prefix = folderPath.replace(/\/+$/, "") + "/";
      cancelDebouncesForPrefix(roomId, prefix);

      try {
        const deletedPaths = wsDeleteFolder(roomId, folderPath);
        io.to(roomId).emit("folder-deleted", { folderPath, deletedPaths });
      } catch (err) {
        console.error(`[workspace] delete-folder error (${roomId}/${folderPath}):`, err);
      }

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "deleted folder", folderPath);
    }
  );

  socket.on(
    "rename-folder",
    async ({ roomId, oldPath, newPath }: { roomId: string; oldPath: string; newPath: string }) => {
      if (!canRename(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "rename-folder", reason: "Viewers cannot rename folders" });
        return;
      }
      try {
        const renamedFiles = wsRenameFolder(roomId, oldPath, newPath);

        // Cancel debounce timers for all renamed paths
        for (const oldFilePath of Object.keys(renamedFiles)) {
          const oldKey = `${roomId}::${oldFilePath}`;
          const timer  = codeDebounce.get(oldKey);
          if (timer) { clearTimeout(timer); codeDebounce.delete(oldKey); }
        }

        io.to(roomId).emit("folder-renamed", { oldPath, newPath, renamedFiles });
      } catch (err) {
        console.error(`[workspace] rename-folder error (${roomId}):`, err);
      }

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "renamed folder", `${oldPath} → ${newPath}`);
    }
  );

  socket.on(
    "move-file",
    async ({ roomId, oldPath, newPath }: { roomId: string; oldPath: string; newPath: string }) => {
      if (!canEdit(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "move-file", reason: "Viewers cannot move files" });
        return;
      }
      if (oldPath === newPath) return;

      try {
        wsRenameFile(roomId, oldPath, newPath);

        // Cancel debounce for old path
        const debounceKey = `${roomId}::${oldPath}`;
        const timer = codeDebounce.get(debounceKey);
        if (timer) { clearTimeout(timer); codeDebounce.delete(debounceKey); }

        io.to(roomId).emit("file-moved", { oldPath, newPath });
      } catch (err) {
        console.error(`[workspace] move-file error (${roomId}):`, err);
      }

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "moved", `${oldPath} → ${newPath}`);
    }
  );

  // ════════════════════════════════════════════════════════════════════════════
  // RUN CODE — UNCHANGED (terminal already uses workspace dir)
  // ════════════════════════════════════════════════════════════════════════════

  socket.on(
    "run-code",
    async ({ roomId, fileName, files }: { roomId: string; fileName: string; files: Record<string, string> }) => {
      if (!canEdit(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "run-code", reason: "Viewers cannot run code" });
        return;
      }

      // Ensure PTY exists without blocking on file sync
      terminalManager.getOrCreate(
        socket.id,
        roomId,
        (d) => socket.emit("terminal-output", d),
        (c) => socket.emit("terminal-exit", { code: c })
      );

      const ext  = fileName.split(".").pop()?.toLowerCase() ?? "";
      const win  = process.platform === "win32";
      const bare = win ? fileName.split("/").join("\\") : fileName;

      let cmd = "";

      if (ext === "java") {
        const className = fileName.split("/").pop()?.replace(".java", "") ?? "Main";
        const fileDir   = fileName.includes("/") ? fileName.split("/").slice(0, -1).join(win ? "\\" : "/") : ".";
        cmd = `javac "${bare}" && java -cp "${fileDir}" ${className}`;
      } else {
        const cmdMap: Record<string, string> = {
          py:  `python "${bare}"`,
          js:  `node "${bare}"`,
          ts:  `npx ts-node "${bare}"`,
          go:  `go run "${bare}"`,
          rs:  `rustc "${bare}" -o out && ./out`,
          rb:  `ruby "${bare}"`,
          php: `php "${bare}"`,
          sh:  `bash "${bare}"`,
          c:   win ? `gcc "${bare}" -o out.exe && out.exe`  : `gcc "${bare}" -o out && ./out`,
          cpp: win ? `g++ "${bare}" -o out.exe && out.exe`  : `g++ "${bare}" -o out && ./out`,
        };
        cmd = cmdMap[ext] ?? "";
      }

      if (!cmd) {
        socket.emit("terminal-output", `\r\n\x1b[33m⚠ Don't know how to run .${ext} files — type your command below.\x1b[0m\r\n`);
        socket.emit("terminal-switch-panel");
        return;
      }

      socket.emit("terminal-switch-panel");
      socket.emit("terminal-output",
        `\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n\x1b[90m${"─".repeat(50)}\x1b[0m\r\n`
      );
      terminalManager.write(socket.id, cmd + "\r");

      const user = getUser(roomId, socket.id);
      if (user) await broadcastActivity(roomId, user, "ran code", fileName);
    }
  );

  // ── folder-sync — lightweight folder-open notification ─────────────────────
  // Receives file PATHS only (no content) so the socket payload stays tiny.
  // Terminal workspace is populated lazily by code-change events as files open.
  socket.on(
    "folder-sync",
    async ({ roomId, folderName, filePaths, files }: {
      roomId:      string;
      folderName:  string;
      filePaths?:  string[];
      files?:      Record<string, string>;
    }) => {
      if (!canEdit(getRole(roomId, socket.id))) {
        socket.emit("permission-denied", { action: "folder-sync", reason: "Viewers cannot upload folders" });
        return;
      }

      // Legacy support: if old client sends full files, sync async (non-blocking)
      if (!filePaths && files && Object.keys(files).length > 0) {
        terminalManager.syncFiles(roomId, files);
      }
      // New path-only payload: no sync needed, workspace populated by code-change

      const user = getUser(roomId, socket.id);
      const count = filePaths?.length ?? (files ? Object.keys(files).length : 0);
      if (user) {
        await broadcastActivity(roomId, user, "opened folder", `${folderName} (${count} files)`);
      }
    }
  );

  // ── upload events ─────────────────────────────────────────────────────────────
  // Kept for backward compat — just broadcasts activity
  socket.on("upload-file", async ({ roomId, fileName }: { roomId: string; fileName: string }) => {
    if (!canEdit(getRole(roomId, socket.id))) { socket.emit("permission-denied", { action: "upload-file", reason: "Viewers cannot upload" }); return; }
    const user = getUser(roomId, socket.id);
    if (user) await broadcastActivity(roomId, user, "uploaded", fileName);
  });

  socket.on("upload-folder", async ({ roomId, folderName, fileCount }: { roomId: string; folderName: string; fileCount: number }) => {
    if (!canEdit(getRole(roomId, socket.id))) { socket.emit("permission-denied", { action: "upload-folder", reason: "Viewers cannot upload" }); return; }
    const user = getUser(roomId, socket.id);
    if (user) await broadcastActivity(roomId, user, "uploaded folder", `${folderName} (${fileCount} files)`);
  });

  // ── chat ──────────────────────────────────────────────────────────────────────
  // UNCHANGED
  socket.on(
    "send-chat-message",
    async ({ roomId, message }: { roomId: string; message: { id: string; userName: string; text: string; timestamp: number } }) => {
      io.to(roomId).emit("receive-chat-message", message);
      try {
        await ChatMessage.create({ roomId, ...message });
        const count = await ChatMessage.countDocuments({ roomId });
        if (count > CHAT_CAP) {
          const oldest = await ChatMessage.find({ roomId }).sort({ timestamp: 1 }).limit(count - CHAT_CAP).select("_id").lean();
          await ChatMessage.deleteMany({ _id: { $in: oldest.map(d => d._id) } });
        }
      } catch (err: unknown) { if ((err as { code?: number }).code !== 11000) console.error("Chat persist error:", err); }
    }
  );

  // ── sync-code ─────────────────────────────────────────────────────────────────
  // UNCHANGED
  socket.on("sync-code", ({ socketId, files }: { socketId: string; files: Record<string, string> }) => {
    io.to(socketId).emit("room-files", files);
  });

  // ── cursor-move ───────────────────────────────────────────────────────────────
  // UNCHANGED
  socket.on("cursor-move", (payload: CursorPayload) => {
    if (!cursorChanged(socket.id, payload)) return;
    socket.to(payload.roomId).emit("receive-cursor", payload);
  });

  // ── typing ────────────────────────────────────────────────────────────────────
  // UNCHANGED
  socket.on("typing",       ({ roomId, user }: { roomId: string; user: RoomUser }) => socket.to(roomId).emit("user-typing", user));
  socket.on("stop-typing",  ({ roomId, user }: { roomId: string; user: RoomUser }) => socket.to(roomId).emit("user-stop-typing", user));
  socket.on("active-file-change", ({ roomId, socketId, fileName }: { roomId: string; socketId: string; fileName: string }) => {
    socket.to(roomId).emit("user-active-file", { socketId, fileName });
  });

  // ── Terminal — per-socket PTY sessions ───────────────────────────────────────
  //
  // Each socket (browser tab) gets its own independent PTY.
  // Output goes only to that socket, not broadcast to the room.
  // This means every user can cd anywhere and run anything independently.

  socket.on("terminal-join", ({ roomId, cols, rows }: {
    roomId: string;
    files?: Record<string, string>; // ignored — workspace already has files
    cols?:  number;
    rows?:  number;
  }) => {
    // DO NOT sync files here — that blocks the event loop for large projects.
    // Files are written to disk by folder-sync and code-change events.
    // Just spawn the PTY immediately.

    const { session, isNew } = terminalManager.getOrCreate(
      socket.id,
      roomId,
      (d) => socket.emit("terminal-output", d),
      (c) => socket.emit("terminal-exit", { code: c }),
      cols ?? 120,
      rows ?? 30,
    );

    const role = getRole(roomId, socket.id);

    if (isNew) {
      const roleLabel = role === "viewer"
        ? `\x1b[33m│  Read-only — ask owner for edit access\x1b[0m`
        : `\x1b[32m│  Role: ${role ?? "editor"}\x1b[0m`;
      socket.emit("terminal-output",
        `\x1b[36m╭─ CodeCollab Terminal\x1b[0m\r\n` +
        `\x1b[36m│\x1b[0m  Room: ${roomId}\r\n` +
        `${roleLabel}\r\n` +
        `\x1b[36m│\x1b[0m  Dir:  ${session.workDir}\r\n` +
        `\x1b[36m╰──────────────────────────\x1b[0m\r\n\r\n`
      );
    } else {
      const history = terminalManager.getHistory(socket.id);
      if (history.length > 0) socket.emit("terminal-history", history);
    }
  });

  socket.on("terminal-input", ({ roomId: payloadRoomId, data }: { roomId: string; data: string }) => {
    // Resolve roomId from socketRoom map (populated by join-room) as the
    // canonical source of truth — falls back to payload if available
    const roomId = socketRoom.get(socket.id) ?? payloadRoomId;
    const role   = getRole(roomId, socket.id);

    // Race condition: join-room not yet complete (role === undefined)
    // Queue the input and flush it after join-room sets the role
    if (role === undefined) {
      const q = pendingInput.get(socket.id) ?? [];
      q.push(data);
      pendingInput.set(socket.id, q);
      return;
    }

    // Viewers cannot type — silently drop (frontend already shows hint)
    if (!canEdit(role)) return;

    if (!terminalManager.hasSession(socket.id)) {
      terminalManager.getOrCreate(
        socket.id, roomId,
        (d) => socket.emit("terminal-output", d),
        (c) => socket.emit("terminal-exit", { code: c }),
      );
    }
    terminalManager.write(socket.id, data);
  });

  socket.on("terminal-resize", ({ cols, rows }: { roomId: string; cols: number; rows: number }) => {
    terminalManager.resize(socket.id, cols, rows);
  });

  socket.on("terminal-sync-files", ({ roomId, files }: { roomId: string; files: Record<string, string> }) => {
    if (!canEdit(getRole(roomId, socket.id))) return;
    // This is the ONLY intentional full sync — triggered by user pressing Sync button
    socket.emit("terminal-output", "\x1b[90mSyncing files to workspace...\x1b[0m\r\n");
    terminalManager.syncFiles(roomId, files); // async — won't block
    socket.emit("terminal-output", "\x1b[32m✓ Sync started (files writing in background)\x1b[0m\r\n");
  });

  socket.on("terminal-restart", ({ roomId, files }: { roomId: string; files: Record<string, string> }) => {
    if (!canEdit(getRole(roomId, socket.id))) return;
    // Async file sync — don't block PTY restart
    if (files && Object.keys(files).length > 0) {
      terminalManager.syncFiles(roomId, files);
    }
    const s = terminalManager.respawn(
      socket.id, roomId,
      (d) => socket.emit("terminal-output", d),
      (c) => socket.emit("terminal-exit", { code: c }),
    );
    socket.emit("terminal-output",
      `\x1b[33m♻  Terminal restarted\x1b[0m\r\n` +
      `\x1b[36m   Dir: ${s.workDir}\x1b[0m\r\n\r\n`
    );
    const user = getUser(roomId, socket.id);
    if (user) void broadcastActivity(roomId, user, "restarted terminal");
  });

  socket.on("terminal-run-project", ({ roomId, files }: { roomId: string; files: Record<string, string> }) => {
    if (!canEdit(getRole(roomId, socket.id))) {
      socket.emit("permission-denied", { action: "terminal-run-project", reason: "Viewers cannot run projects" });
      return;
    }
    // No blocking syncFiles — workspace already has files from code-change/folder-sync
    const names    = Object.keys(files);
    const hasPkg   = names.some(f => f === "package.json" || f.endsWith("/package.json"));
    const hasPyReq = names.some(f => f === "requirements.txt");
    const hasMain  = names.some(f => f === "main.py" || f.endsWith("/main.py"));
    const hasGo    = names.some(f => f.endsWith(".go"));
    const hasRust  = names.some(f => f === "Cargo.toml");

    let cmd = "";
    if (hasPkg) {
      try {
        const pkgFile = names.find(f => f === "package.json" || f.endsWith("/package.json"))!;
        const pkg = JSON.parse(files[pkgFile]) as { scripts?: Record<string, string> };
        cmd = pkg.scripts?.dev ? "npm run dev" : pkg.scripts?.start ? "npm start" : "npm install && npm start";
      } catch { cmd = "npm install && npm start"; }
    } else if (hasPyReq || hasMain) {
      cmd = hasPyReq ? "pip install -r requirements.txt && python main.py" : "python main.py";
    } else if (hasGo)   { cmd = "go run ."; }
    else if (hasRust)   { cmd = "cargo run"; }
    else {
      socket.emit("terminal-output", "\x1b[33m⚠ Could not detect project type. Type your run command.\x1b[0m\r\n");
      return;
    }

    terminalManager.getOrCreate(
      socket.id, roomId,
      (d) => socket.emit("terminal-output", d),
      (c) => socket.emit("terminal-exit", { code: c }),
    );
    socket.emit("terminal-output",
      `\r\n\x1b[36m$ ${cmd}\x1b[0m\r\n\x1b[90m${"─".repeat(50)}\x1b[0m\r\n`
    );
    terminalManager.write(socket.id, cmd + "\r");

    const user = getUser(roomId, socket.id);
    if (user) void broadcastActivity(roomId, user, "ran project", cmd);
  });

  // ── terminal-ensure — used by Run/Project when terminal may be dead ──────────
  // Guarantees a live PTY session exists for this socket without sending
  // the full welcome banner. Safe to call even if session already exists.
  socket.on("terminal-ensure", ({ roomId, cols, rows }: {
    roomId: string; files?: Record<string, string>; cols?: number; rows?: number;
  }) => {
    if (!canEdit(getRole(roomId, socket.id))) return;
    // No syncFiles here — just ensure PTY exists
    const { isNew } = terminalManager.getOrCreate(
      socket.id, roomId,
      (d) => socket.emit("terminal-output", d),
      (c) => socket.emit("terminal-exit", { code: c }),
      cols ?? 120, rows ?? 30,
    );
    if (isNew) {
      const ws = terminalManager.getSession(socket.id)?.workDir ?? "";
      socket.emit("terminal-output",
        `\x1b[36m[Terminal ready — ${ws}]\x1b[0m\r\n\r\n`
      );
    }
  });

  // ── terminal-kill — client killed a tab, clean up the server PTY ─────────────
  socket.on("terminal-kill", ({ roomId }: { roomId: string }) => {
    terminalManager.kill(socket.id);
    console.log(`[terminal] Client killed PTY for socket ${socket.id} in room ${roomId}`);
  });
  socket.on("leave-room", (roomId: string) => {
    socket.leave(roomId);
    const room = roomUsers.get(roomId);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) {
        roomUsers.delete(roomId);
        terminalManager.killAllForRoom(roomId);
      } else {
        broadcastRoomUsers(roomId);
      }
    }
    // Kill this socket's own PTY session
    terminalManager.kill(socket.id);
    lastCursorHash.delete(socket.id);
    socketRoom.delete(socket.id);
    pendingInput.delete(socket.id);
  });

  socket.on("disconnecting", () => {
    socket.rooms.forEach((roomId) => {
      if (roomId === socket.id) return;
      const room = roomUsers.get(roomId);
      if (room) {
        room.delete(socket.id);
        if (room.size === 0) {
          roomUsers.delete(roomId);
          terminalManager.killAllForRoom(roomId);
        } else {
          broadcastRoomUsers(roomId);
        }
      }
    });
    // Kill this socket's own PTY session on any disconnect
    terminalManager.kill(socket.id);
    lastCursorHash.delete(socket.id);
    socketRoom.delete(socket.id);
    pendingInput.delete(socket.id);
  });

  socket.on("disconnect", () => {
    socketRoom.delete(socket.id);
    pendingInput.delete(socket.id);
    console.log("Socket disconnected:", socket.id);
  });
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGTERM", () => { terminalManager.killAll(); process.exit(0); });
process.on("SIGINT",  () => { terminalManager.killAll(); process.exit(0); });

// ─── Boot ─────────────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT) || 4000;
connectDB()
  .then(() => server.listen(PORT, () => console.log(`🚀 API running on http://localhost:${PORT}`)))
  .catch((err) => { console.error("❌ Failed to connect to MongoDB:", err); process.exit(1); });