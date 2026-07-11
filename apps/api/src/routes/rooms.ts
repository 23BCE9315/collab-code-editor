import { Router, Request, Response } from "express";
import { nanoid } from "nanoid";
import { Room, Activity, ChatMessage } from "../models";

const router = Router();

router.post("/", async (req: Request, res: Response) => {
  const { roomName, user } = req.body as { roomName?: string; user: { uid: string; name: string; email: string } };
  if (!user?.uid || !user?.name || !user?.email) return res.status(400).json({ error: "user.uid, user.name and user.email are required" });
  const roomId = nanoid(8);
  const name   = (roomName?.trim() || "Untitled Room").slice(0, 80);
  try {
    const room = await Room.create({ roomId, roomName: name, createdBy: { uid: user.uid, name: user.name, email: user.email }, files: new Map(), roles: new Map([[user.uid, "owner"]]) });
    return res.status(201).json({ roomId: room.roomId, roomName: room.roomName, createdBy: room.createdBy, createdAt: room.createdAt, shareUrl: `${process.env.CLIENT_ORIGIN || "http://localhost:5173"}/room/${room.roomId}` });
  } catch (err: any) { console.error("POST /api/rooms error:", err); return res.status(500).json({ error: "Failed to create room" }); }
});

router.get("/:roomId", async (req: Request, res: Response) => {
  const { roomId } = req.params;
  try {
    const room = await Room.findOne({ roomId });
    if (!room) return res.status(404).json({ error: "Room not found" });
    const files: Record<string,string> = {}; room.files.forEach((c,n) => { files[n] = c; });
    const roles: Record<string,string> = {}; room.roles.forEach((r,u) => { roles[u] = r; });
    return res.json({ roomId: room.roomId, roomName: room.roomName, createdBy: room.createdBy, createdAt: room.createdAt, files, roles });
  } catch (err) { return res.status(500).json({ error: "Failed to fetch room" }); }
});

router.get("/:roomId/chat", async (req: Request, res: Response) => {
  const { roomId } = req.params; const limit = Math.min(Number(req.query.limit)||100, 300);
  try {
    if (!await Room.exists({ roomId })) return res.status(404).json({ error: "Room not found" });
    const messages = await ChatMessage.find({ roomId }).sort({ timestamp: -1 }).limit(limit).lean();
    return res.json({ messages: messages.reverse() });
  } catch (err) { return res.status(500).json({ error: "Failed to fetch chat" }); }
});

router.get("/:roomId/activity", async (req: Request, res: Response) => {
  const { roomId } = req.params; const limit = Math.min(Number(req.query.limit)||100, 200);
  try {
    if (!await Room.exists({ roomId })) return res.status(404).json({ error: "Room not found" });
    const activities = await Activity.find({ roomId }).sort({ timestamp: -1 }).limit(limit).lean();
    return res.json({ activities: activities.reverse() });
  } catch (err) { return res.status(500).json({ error: "Failed to fetch activity" }); }
});

export default router;