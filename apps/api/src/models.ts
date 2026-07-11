/**
 * models.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Architecture decision: files are stored as a FLAT Map<string, string> where:
 *   key   = full path  e.g. "src/components/Button.tsx"
 *   value = file code  e.g. "export default function Button() {...}"
 *
 * Folders are IMPLICIT — they exist whenever a file key contains a "/" segment.
 * There is no explicit folder document. This gives us:
 *   ✓ O(1) file read/write
 *   ✓ No recursive schema migration
 *   ✓ Clean MongoDB Map storage (encoded keys for dot-safety)
 *   ✓ Tree structure derived at runtime from the flat map
 *
 * Folder operations (rename-folder, delete-folder, move-file) are implemented
 * as prefix operations on the flat key set — rename "src/" → "lib/" rewrites
 * every key that starts with "src/".
 * ─────────────────────────────────────────────────────────────────────────────
 */

import mongoose, { Schema, Document } from "mongoose";

// ─── Role ─────────────────────────────────────────────────────────────────────

export type Role = "owner" | "editor" | "viewer";

// ─── FileEntry — what the frontend works with ─────────────────────────────────
// Exported so index.ts can use it in socket payloads.

export interface FileEntry {
  path:    string;   // full path: "src/components/Button.tsx"
  content: string;   // file code
}

// ─── Room ─────────────────────────────────────────────────────────────────────

export interface IRoom extends Document {
  roomId:    string;
  roomName:  string;
  createdBy: { uid: string; name: string; email: string };
  /**
   * Flat file store.
   * Key  = encoded full path (dots replaced with U+00B7 to satisfy Mongoose Map).
   * Value = file content.
   * Use encodeKey()/decodeKey() in index.ts before every read/write.
   */
  files:     Map<string, string>;
  roles:     Map<string, Role>;
  createdAt: Date;
  updatedAt: Date;
}

const RoomSchema = new Schema<IRoom>(
  {
    roomId:    { type: String, required: true, unique: true, index: true },
    roomName:  { type: String, required: true, default: "Untitled Room" },
    createdBy: {
      uid:   { type: String, required: true },
      name:  { type: String, required: true },
      email: { type: String, required: true },
    },
    files: { type: Map, of: String, default: new Map() },
    roles: { type: Map, of: String, default: new Map() },
  },
  { timestamps: true }
);

export const Room = mongoose.model<IRoom>("Room", RoomSchema);

// ─── Activity ─────────────────────────────────────────────────────────────────

export interface IActivity extends Document {
  roomId:    string;
  id:        string;
  uid:       string;
  userName:  string;
  action:    string;
  target?:   string;
  timestamp: number;
}

const ActivitySchema = new Schema<IActivity>(
  {
    roomId:    { type: String, required: true, index: true },
    id:        { type: String, required: true, unique: true },
    uid:       { type: String, required: true },
    userName:  { type: String, required: true },
    action:    { type: String, required: true },
    target:    { type: String },
    timestamp: { type: Number, required: true },
  },
  { timestamps: false }
);
ActivitySchema.index({ roomId: 1, timestamp: -1 });
export const Activity = mongoose.model<IActivity>("Activity", ActivitySchema);

// ─── ChatMessage ──────────────────────────────────────────────────────────────

export interface IChatMessage extends Document {
  roomId:    string;
  id:        string;
  userName:  string;
  text:      string;
  timestamp: number;
}

const ChatMessageSchema = new Schema<IChatMessage>(
  {
    roomId:    { type: String, required: true, index: true },
    id:        { type: String, required: true, unique: true },
    userName:  { type: String, required: true },
    text:      { type: String, required: true },
    timestamp: { type: Number, required: true },
  },
  { timestamps: false }
);
ChatMessageSchema.index({ roomId: 1, timestamp: 1 });
export const ChatMessage = mongoose.model<IChatMessage>("ChatMessage", ChatMessageSchema);