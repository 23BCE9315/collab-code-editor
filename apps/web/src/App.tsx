import {
  useEffect, useRef, useState, useCallback, useMemo,
} from "react";
import Editor from "@monaco-editor/react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { socket } from "./socket";
import { loginWithGoogle, logoutUser, observeAuthState } from "./auth";
import { getUserColor } from "./userColor";
import "./App.css";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

type Role         = "owner" | "editor" | "viewer";
type AppUser      = { uid: string; name: string; email: string; photoURL?: string };
type ChatMessage  = { id: string; userName: string; text: string; timestamp: number };
type RoomUser     = AppUser & { socketId: string; role: Role };
type TeamActivity = { id: string; uid: string; userName: string; action: string; target?: string; timestamp: number };
type RemoteCursor = { user: RoomUser & { color?: string }; lineNumber: number; column: number; startLineNumber?: number; startColumn?: number; endLineNumber?: number; endColumn?: number };
type FileTreeNode = { name: string; path: string; type: "file" | "folder"; children?: FileTreeNode[] };
type RoomMeta     = { roomId: string; roomName: string; createdBy: { uid: string; name: string; email: string } };
type View         = "landing" | "editor";
type PanelMode    = "output" | "terminal";
type AiTab        = "chat" | "fix" | "explain";
type ActivityView = "explorer" | "team" | "ai";
type TerminalTab  = { id: string; label: string };

interface AiResponse {
  explanation: string; fixedCode: string; suggestions: string[];
  message?: string; confidence?: "high" | "medium" | "low";
}
interface AiMessage { role: "user" | "ai"; content: string; fixedCode?: string; timestamp: number }

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS & HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const API = "http://localhost:4000";
const ROLE_COLOR: Record<Role, string> = { owner: "#f59e0b", editor: "#007acc", viewer: "#6b7280" };
const canEdit   = (r: Role | null) => r === "owner" || r === "editor";
const canDelete = (r: Role | null) => r === "owner";

function sanitize(v: string) { return v.replace(/[^a-zA-Z0-9_-]/g, "-"); }
function escapeCSS(v: string) { return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }

// ─── FIXED: ensureCursorStyle — label floats ABOVE cursor ────────────────────
// Changes vs original:
//   • bottom: calc(100% + 2px)  instead of bottom: -18px  → above cursor line
//   • opacity driven by CSS custom property --rc-opacity-{ck} for smooth fade
//   • pointer-events: none on both caret and label
//   • re-injects on every call so label text / color updates always propagate
function ensureCursorStyle(ck: string, color: string, label: string) {
  // Remove stale injection so label text / color updates propagate immediately
  document.getElementById(`rcs-${ck}`)?.remove();

  const s = document.createElement("style");
  s.id = `rcs-${ck}`;
  s.innerHTML = [
    // Caret bar — thin coloured vertical line, no pointer events
    `.rc-caret-${ck}{` +
      `position:relative;` +
      `border-left:2px solid ${color};` +
      `margin-left:-1px;` +
      `pointer-events:none;` +
    `}`,

    // Name label — floats ABOVE the cursor, never covers code text
    `.rc-label-${ck}::after{` +
      `content:"${escapeCSS(label)}";` +
      `position:absolute;` +
      `bottom:calc(100% + 2px);` +        // ← KEY FIX: above the line
      `left:0;` +
      `background:${color};` +
      `color:#fff;` +
      `font-size:10px;` +
      `font-weight:600;` +
      `font-family:var(--font-mono,monospace);` +
      `padding:2px 6px;` +
      `border-radius:3px 3px 3px 0;` +
      `white-space:nowrap;` +
      `pointer-events:none;` +            // ← never intercepts clicks
      `z-index:100;` +
      `opacity:var(--rc-opacity-${ck},1);` +  // ← JS-driven fade via CSS var
      `transition:opacity 0.4s ease;` +
      `line-height:1;` +
    `}`,

    // Selection highlight
    `.rc-sel-${ck}{background:${color}25;border-radius:2px;}`,
  ].join("\n");

  document.head.appendChild(s);
}

// File icons using VS Code–style SVG symbols encoded as emoji fallbacks
// ─── VS Code–grade file icon SVGs ────────────────────────────────────────────
// Each returns { svg, color } matching the VS Code Seti icon theme exactly.
// Used by FileIconBadge (tree + tabs).

function getFileIconColor(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".tsx") || n.endsWith(".ts")) return "#4ec9b0";
  if (n.endsWith(".jsx") || n.endsWith(".js") || n.endsWith(".mjs")) return "#e8c84d";
  if (n.endsWith(".html") || n.endsWith(".htm")) return "#e44d26";
  if (n.endsWith(".css")) return "#519aba";
  if (n.endsWith(".scss") || n.endsWith(".sass")) return "#f55385";
  if (n.endsWith(".json") || n.endsWith(".jsonc")) return "#dcdcaa";
  if (n.endsWith(".py")) return "#4b8bbe";
  if (n.endsWith(".java")) return "#cc3e44";
  if (n.endsWith(".c")) return "#599eff";
  if (n.endsWith(".cpp") || n.endsWith(".cc") || n.endsWith(".cxx")) return "#f34b7d";
  if (n.endsWith(".go")) return "#00acd7";
  if (n.endsWith(".rs")) return "#dea584";
  if (n.endsWith(".md") || n.endsWith(".mdx")) return "#519aba";
  if (n.endsWith(".sh") || n.endsWith(".bash") || n.endsWith(".zsh")) return "#89e051";
  if (n.endsWith(".rb")) return "#cc342d";
  if (n.endsWith(".php")) return "#6181b6";
  if (n.endsWith(".swift")) return "#f05138";
  if (n.endsWith(".kt") || n.endsWith(".kts")) return "#f18e33";
  if (n.endsWith(".yaml") || n.endsWith(".yml")) return "#cc3e44";
  if (n.endsWith(".toml")) return "#9c4221";
  if (n.endsWith(".xml")) return "#e37933";
  if (n.endsWith(".svg")) return "#ffb13b";
  if (n.endsWith(".png") || n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".gif") || n.endsWith(".webp")) return "#a074c4";
  if (n.endsWith(".lock")) return "#bbbbbb";
  if (n.endsWith(".env") || n.startsWith(".env")) return "#ecc94b";
  if (n === "dockerfile" || n.startsWith("dockerfile")) return "#384d54";
  if (n.endsWith(".txt")) return "#cccccc";
  return "#8b9eb0";
}

// Returns inline SVG string for a file icon — matches VS Code Seti theme
function getFileIconSvg(name: string): string {
  const n = name.toLowerCase();
  const color = getFileIconColor(name);

  // TypeScript / TSX
  if (n.endsWith(".tsx") || n.endsWith(".ts")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M0 0h16v16H0V0zm13.5 8.5h-2V14h-1V8.5H8.5v-1h5v1zM7 7.5H4.5v1.75a.75.75 0 001.5 0V8.5H7v.75a1.75 1.75 0 01-3.5 0V7.5H2v-1h5v1z"/></svg>`;
  // JavaScript / JSX
  if (n.endsWith(".jsx") || n.endsWith(".js") || n.endsWith(".mjs")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M0 0h16v16H0V0zm11 11.5a1.5 1.5 0 01-3 0V7h1v4.5a.5.5 0 001 0V7h1v4.5zm3-4v4a1.75 1.75 0 01-3.5 0v-.25h1v.25a.75.75 0 001.5 0v-4h1z"/></svg>`;
  // Python
  if (n.endsWith(".py") || n.endsWith(".pyw")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M9 5H5.5A2.5 2.5 0 003 7.5V11a2.5 2.5 0 002.5 2.5h1v1.5H8v-1.5h1A2.5 2.5 0 0011.5 11V7.5A2.5 2.5 0 009 5zM7 1.5C7 .67 7.67 0 8.5 0H11v1H9.5v.5h1a1.5 1.5 0 010 3h-2a.5.5 0 000 1H10a2 2 0 010 4H8.5v-.5h1V9H8a1.5 1.5 0 010-3h1.5V5h-1A2.5 2.5 0 005 7.5V11H4V7.5A3.5 3.5 0 017.5 4H9V1.5z"/></svg>`;
  // HTML
  if (n.endsWith(".html") || n.endsWith(".htm")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M.5 0l1.5 14 6 2 6-2L16 0H.5zM13 4H6v2h6.8l-.4 3.4L8 10.6l-4.4-1.2L3.4 7H5.5l.1 1.2 2.4.6 2.4-.6.3-2.2H3.2L2.6 2h10.6L13 4z"/></svg>`;
  // CSS
  if (n.endsWith(".css")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M.5 0l1.5 14 6 2 6-2L16 0H.5zm9.9 11.4l-2.4.7-2.4-.7-.2-2h1.6l.1 1.2 1 .3 1-.3.1-1.6H5.5l-.4-3.8H11l-.2 1.6H6.8l.2 1.1h3.8l-.4 3.5z"/></svg>`;
  // SCSS
  if (n.endsWith(".scss") || n.endsWith(".sass")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M8 0C3.6 0 0 3.6 0 8s3.6 8 8 8 8-3.6 8-8-3.6-8-8-8zm3.5 11c-.3.3-.8.5-1.2.5-.9 0-1.4-.5-1.4-.5-.4.3-.9.5-1.5.5-1 0-1.7-.6-1.7-1.5 0-1.2 1-1.9 2.5-1.9.2 0 .4 0 .6.1V7.9c0-.4-.2-.6-.6-.6s-.8.2-1.1.5L7 7c.5-.5 1.1-.8 1.8-.8.9 0 1.5.5 1.5 1.4v2.1c0 .3.1.4.3.4.2 0 .4-.1.5-.2l.4.6zm-3.4-.4c.3 0 .5-.1.7-.2V9.5c-.2 0-.3-.1-.5-.1-.6 0-1 .3-1 .7s.3.5.8.5z"/></svg>`;
  // JSON
  if (n.endsWith(".json") || n.endsWith(".jsonc")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M6 2.8C6 1.8 6.8 1 7.7 1c.4 0 .7.1 1 .3l-.5.9c-.1-.1-.3-.2-.5-.2-.4 0-.7.3-.7.8V3h1v1H7v7H6V2.8zm4 10.4c0 1-.8 1.8-1.7 1.8-.4 0-.7-.1-1-.3l.5-.9c.1.1.3.2.5.2.4 0 .7-.3.7-.8V13H8v-1h1V5h1v8.2zM2 9.5 1 8l1-1.5.8.7L2 8l.8.8L2 9.5zm12 0-.8-.7.8-.8-.8-.8.8-.7L15 8l-1 1.5z"/></svg>`;
  // Java
  if (n.endsWith(".java")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M5.7 11.9s-.5.3.4.4c1 .1 1.6.1 2.7-.1 0 0 .3.2.7.3-2.5 1.1-5.6-.1-3.8-.6zm-.4-1.6s-.6.4.3.5c1.1.1 2 .1 3.5-.2 0 0 .2.2.5.3-3.1.9-6.5.1-4.3-.6zm6.4 2.8s.4.3-.4.5c-1.5.4-6.2.5-7.5 0-.5-.2.4-.5.7-.5.2 0 .3 0 .3 0-1.9-.6 0-1.4 0-1.4 0 0-2 .5-.9 1.8 1.6.9 7.5.4 7.8-.4zM6 8.8s-2.7.6-1 .9c.7.1 2.1.1 3.4-.1 1.1-.2 2.2-.5 2.2-.5s-.4.2-.7.4c-2.8.7-8.1.4-6.5-.4 1.2-.7 2.6-.3 2.6-.3zm4.7 2.6c2.9-1.5 1.5-2.9.6-2.7-.2.1-.3.1-.3.1s.1-.1.3-.2c2.1-.7 3.7 2.2-.6 3.3 0-.1.1-.2 0-.5zM8.1 0s1.6 1.6-1.5 4c-2.5 2-0.6 3.1 0 4.4C5 6.8 4.4 5.7 5.7 4.7 7.5 3.3 8.6 2.4 8.1 0zm-1 9.5c1.6.1 4.1.2 4.2 2.4 0 0-.6-.9-2.9-1.3-2.1-.4-4.6-.2-4.6-.2s.4-.4 3.3-.9z"/></svg>`;
  // C
  if (n.endsWith(".c")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M10.5 9.5A2.5 2.5 0 118 7a2.5 2.5 0 012.5 2.5zM8 1a7 7 0 100 14A7 7 0 008 1z"/></svg>`;
  // C++
  if (n.endsWith(".cpp") || n.endsWith(".cc") || n.endsWith(".cxx")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM6.5 9.5A1.5 1.5 0 118 8a1.5 1.5 0 01-1.5 1.5zm4-1h-.75V7.75H9v.75h-.75v.75H9v.75h.75V10H10v-.75h.75v-.75H10v-.75zm2.25 0H12V7.75h-.75v.75H10.5v.75h.75V10h.75v-.75H12V10h.75v-.75H13v-.75h-.25z"/></svg>`;
  // Go
  if (n.endsWith(".go")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M1.5 7.5h.75v1H1.5v-1zm1.25 0H4V9H2.75V7.5zm8 0H11v1h-.25V7.5zm1.25 0H14v1h-1V7.5zM1 6.5v3h1V8h8v1.5h1V8h1v1.5h1V6.5H1zm6 1h1v1H7v-1zm-2 0h1v1H5v-1zm4 0h1v1H9v-1z"/></svg>`;
  // Rust
  if (n.endsWith(".rs")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M7.97 1a7 7 0 100 14A7 7 0 007.97 1zm.7 10.5h-1.5v-3H6l2-3 2 3H8.67v3zM6 7V5.5l-1.5 1 .5-2-1.5-.5L5 3.5l-.5-2 1.5 1L7 1.5v1.5L8.5 2l-.5 2 1.5.5L8 6l1.5 1H6z"/></svg>`;
  // Markdown
  if (n.endsWith(".md") || n.endsWith(".mdx")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M14 3H2a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1zM8 11L5 7h2V5h2v2h2L8 11zm-4-.5v-5H5l1.5 2 1.5-2h1v5H7.5V8.5l-1 1.5-1-1.5V10.5H4z"/></svg>`;
  // Shell
  if (n.endsWith(".sh") || n.endsWith(".bash") || n.endsWith(".zsh")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M2 1h12a1 1 0 011 1v12a1 1 0 01-1 1H2a1 1 0 01-1-1V2a1 1 0 011-1zm1.5 9.5l3-3-3-3-.7.7L5.1 8l-2.3 2.3.7.7zm4 1H12V10H7.5v1.5z"/></svg>`;
  // Ruby
  if (n.endsWith(".rb")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M13.6 9.2L8 15l-5.6-5.8L4.7 4h6.6l2.3 5.2zM6 2l-2 2h7L9 2H6z"/></svg>`;
  // PHP
  if (n.endsWith(".php")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M8 0C3.6 0 0 3.6 0 8s3.6 8 8 8 8-3.6 8-8-3.6-8-8-8zm-1 11.5H5.5V10H4V7h3.5c.8 0 1.5.7 1.5 1.5S8.3 10 7.5 10H7v1.5zm.5-3H5.5V8.5H7.5a.5.5 0 000-1zm4 3H10V10h-1V7h1V8h1.5c.8 0 1.5.7 1.5 1.5S12.3 11.5 11.5 11.5zm0-2.5a.5.5 0 000-1H10.5V9H11.5a.5.5 0 000 0z"/></svg>`;
  // YAML
  if (n.endsWith(".yaml") || n.endsWith(".yml")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M1 2h2.4L5 4.6 6.6 2H9L6.2 6.5V9H3.8V6.5L1 2zm10.5 7H9V7h1.5V3H12v4h1.5v2H12v1.5h-1.5V9H9z"/></svg>`;
  // XML
  if (n.endsWith(".xml")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M1 3l3 5-3 5h1.5l2.25-3.75L6 13h1.5l-3-5 3-5H6L3.75 6.75 1.5 3H1zm8 0l-3 5 3 5h1.5L7.25 8.25 10.5 3H9zm1 0h1.5l2.25 3.75L16 3h1.5l-3 5 3 5H16l-2.25-3.75L11.5 13H10l3-5-3-5z"/></svg>`;
  // SVG
  if (n.endsWith(".svg")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M8 1a7 7 0 100 14A7 7 0 008 1zM4.5 8a3.5 3.5 0 117 0 3.5 3.5 0 01-7 0z"/></svg>`;
  // Images
  if ([".png",".jpg",".jpeg",".gif",".webp",".ico",".bmp"].some(e => n.endsWith(e))) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M1 3h14v10H1V3zm1 9l3-4.5 2.5 3L10 7l4 5H2z"/><circle cx="4.5" cy="5.5" r="1"/></svg>`;
  // Env
  if (n === ".env" || n.startsWith(".env.")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M1 2h14v2H1V2zm0 4h10v2H1V6zm0 4h14v2H1v-2z"/></svg>`;
  // Dockerfile
  if (n === "dockerfile" || n.startsWith("dockerfile")) return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M8.5 2h5v1h-5V2zM1 3.5V14h6.5v-1H2V4.5h11v2H14v-3H1zM9 5h1v1H9V5zm2 0h1v1h-1V5zm2 0h1v1h-1V5zm-4 2h1v1h-1V7zm2 0h1v1h-1V7zm2 0h1v1h-1V7zm-4 2h1v1h-1V9zm2 0h1v1h-1V9zm2 0h1v1h-1V9z"/></svg>`;
  // Generic / txt / lock
  return `<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" fill="${color}"><path d="M4 1h5l4 4v10H4V1zm5 0v4h4l-4-4zM6 7v1h5V7H6zm0 2v1h5V9H6zm0 2v1h3v-1H6z"/></svg>`;
}

// Kept for backward compat (command palette icon text)
function getFileIcon(name: string): string {
  const n = name.toLowerCase();
  if (n.endsWith(".tsx")) return "⚛"; if (n.endsWith(".ts")) return "TS";
  if (n.endsWith(".jsx")) return "⚛"; if (n.endsWith(".js") || n.endsWith(".mjs")) return "JS";
  if (n.endsWith(".html") || n.endsWith(".htm")) return "HTML";
  if (n.endsWith(".css")) return "CSS"; if (n.endsWith(".scss") || n.endsWith(".sass")) return "SCSS";
  if (n.endsWith(".json")) return "{}"; if (n.endsWith(".py")) return "PY";
  if (n.endsWith(".java")) return "☕"; if (n.endsWith(".c")) return "C";
  if (n.endsWith(".cpp") || n.endsWith(".cc")) return "C++"; if (n.endsWith(".go")) return "GO";
  if (n.endsWith(".rs")) return "RS"; if (n.endsWith(".md") || n.endsWith(".mdx")) return "MD";
  if (n.endsWith(".sh") || n.endsWith(".bash")) return "SH"; if (n.endsWith(".rb")) return "RB";
  if (n.endsWith(".yaml") || n.endsWith(".yml")) return "YAML"; if (n.endsWith(".xml")) return "XML";
  return "·";
}
function getEditorLang(name: string): string {
  if (/\.tsx?$/.test(name)) return "typescript";
  if (/\.jsx?$/.test(name)) return "javascript";
  if (name.endsWith(".html")) return "html";
  if (name.endsWith(".css") || name.endsWith(".scss")) return "css";
  if (name.endsWith(".json")) return "json";
  if (name.endsWith(".py")) return "python";
  if (name.endsWith(".java")) return "java";
  if (name.endsWith(".c")) return "c";
  if (name.endsWith(".cpp")) return "cpp";
  if (name.endsWith(".md")) return "markdown";
  return "plaintext";
}
function getLangName(name: string): string {
  if (/\.tsx?$/.test(name)) return "TypeScript";
  if (/\.jsx?$/.test(name)) return "JavaScript";
  if (name.endsWith(".py")) return "Python";
  if (name.endsWith(".java")) return "Java";
  if (name.endsWith(".go")) return "Go";
  if (name.endsWith(".rs")) return "Rust";
  if (name.endsWith(".c")) return "C";
  if (name.endsWith(".cpp")) return "C++";
  return "text";
}
function fmtTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60000) return "just now";
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

// ═══════════════════════════════════════════════════════════════════════════
// FILE TREE
// ═══════════════════════════════════════════════════════════════════════════

function buildTree(files: Record<string, string>): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const folders = new Map<string, FileTreeNode>();
  const sorted = Object.keys(files).sort((a, b) => {
    const da = a.split("/").length, db = b.split("/").length;
    return da !== db ? da - db : a.localeCompare(b);
  });
  for (const fp of sorted) {
    const parts = fp.split("/");
    if (parts.length === 1) { if (!root.find(n => n.path === fp)) root.push({ name: fp, path: fp, type: "file" }); continue; }
    let siblings = root, cum = "";
    for (let i = 0; i < parts.length - 1; i++) {
      cum = cum ? `${cum}/${parts[i]}` : parts[i];
      if (!folders.has(cum)) {
        const f: FileTreeNode = { name: parts[i], path: cum, type: "folder", children: [] };
        folders.set(cum, f);
        const fi = siblings.findIndex(n => n.type === "file");
        fi === -1 ? siblings.push(f) : siblings.splice(fi, 0, f);
      }
      siblings = folders.get(cum)!.children!;
    }
    const leaf = parts[parts.length - 1];
    if (!siblings.find(n => n.path === fp)) siblings.push({ name: leaf, path: fp, type: "file" });
  }
  return root;
}

// ═══════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════

function RoleBadge({ role }: { role: Role }) {
  return (
    <span className="role-badge" style={{ background: `${ROLE_COLOR[role]}20`, color: ROLE_COLOR[role], border: `1px solid ${ROLE_COLOR[role]}40` }}>
      {role}
    </span>
  );
}

// ─── FileIconBadge — renders a crisp 16×16 VS Code Seti-style SVG icon ───────
function FileIconBadge({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span
      style={{
        display: "inline-flex", alignItems: "center", justifyContent: "center",
        width: size, height: size, flexShrink: 0,
      }}
      dangerouslySetInnerHTML={{ __html: getFileIconSvg(name) }}
    />
  );
}

// ─── FileTreeItem — VS Code pixel-perfect tree row ────────────────────────────
//
// Layout per row (matches VS Code exactly):
//   [indent guides] [8px gap] [chevron 16px] [4px] [icon 16px] [6px] [label flex-1]
//
// Key VS Code behaviours reproduced:
//   • Full-width hover highlight (not just the text)
//   • Sticky indent guide lines at each depth level
//   • Chevron rotates 90° when open (CSS transition)
//   • Active file has a solid left accent bar + blue background
//   • Action buttons appear on hover, right-aligned
//   • Names never truncate — they scroll horizontally inside overflow:hidden

interface TreeItemProps {
  node: FileTreeNode; depth: number; activeFile: string;
  openFolders: Set<string>; myRole: Role | null;
  renamingPath: string | null; renameVal: string;
  onFileClick:    (p: string) => void;
  onToggleFolder: (p: string) => void;
  onContextMenu:  (e: React.MouseEvent, p: string, type: "file" | "folder") => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onMoveFile?:    (srcPath: string, destFolder: string) => void;
}

// Each depth level indents by 8px — same as VS Code compact mode
const INDENT_PER_DEPTH = 8;
// Left padding for depth-0 items
const BASE_PADDING = 4;

function FileTreeItem(props: TreeItemProps) {
  const {
    node, depth, activeFile, openFolders, myRole, renamingPath, renameVal,
    onFileClick, onToggleFolder, onContextMenu,
    onRenameChange, onRenameCommit, onRenameCancel, onMoveFile,
  } = props;

  const [hovered,  setHovered]  = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // Total left offset for this row's content
  const paddingLeft = BASE_PADDING + depth * INDENT_PER_DEPTH;

  // ── FOLDER ────────────────────────────────────────────────────────────────
  if (node.type === "folder") {
    const isOpen = openFolders.has(node.path);

    return (
      <div>
        {/* ── Folder row ── */}
        <div
          style={{
            display: "flex", alignItems: "center",
            height: 22, paddingLeft, paddingRight: 4,
            cursor: "pointer", position: "relative",
            userSelect: "none",
            background: hovered || dragOver ? "rgba(255,255,255,0.07)" : "transparent",
            outline: dragOver ? "1px solid #007acc" : "none",
          }}
          onClick={() => onToggleFolder(node.path)}
          onContextMenu={e => onContextMenu(e, node.path, "folder")}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={e => {
            e.preventDefault(); setDragOver(false);
            const src = e.dataTransfer.getData("text/plain");
            if (!src || src === node.path) return;
            if (onMoveFile) onMoveFile(src, node.path);
          }}
        >
          {/* Indent guide lines — one per ancestor depth */}
          {Array.from({ length: depth }).map((_, i) => (
            <span key={i} style={{
              position: "absolute",
              left: BASE_PADDING + i * INDENT_PER_DEPTH + 7,
              top: 0, bottom: 0, width: 1,
              background: "rgba(255,255,255,0.08)",
              pointerEvents: "none",
            }} />
          ))}

          {/* Chevron — rotates when open */}
          <span style={{
            display: "inline-flex", alignItems: "center", justifyContent: "center",
            width: 16, height: 16, flexShrink: 0, marginRight: 2,
            color: "#bbb",
            transition: "transform 0.12s ease",
            transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
          }}>
            <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
              <path d="M2 1.5l4 2.5-4 2.5V1.5z"/>
            </svg>
          </span>

          {/* Folder icon — open/closed variant */}
          <span style={{ display: "inline-flex", alignItems: "center", width: 16, height: 16, flexShrink: 0, marginRight: 5 }}>
            {isOpen ? (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.586a1 1 0 01.707.293l.914.914A1 1 0 008.414 3.5H13.5A1.5 1.5 0 0115 5v.5H1V3.5z" fill="#dcb67a"/>
                <path d="M.5 5.5A.5.5 0 011 5h14a.5.5 0 01.496.562l-1 8A.5.5 0 0114 14H2a.5.5 0 01-.496-.438l-1-8A.5.5 0 01.5 5.5z" fill="#dcb67a" fillOpacity="0.85"/>
              </svg>
            ) : (
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M1 3.5A1.5 1.5 0 012.5 2h3.586a1 1 0 01.707.293l.914.914A1 1 0 008.414 3.5H13.5A1.5 1.5 0 0115 5v7a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12V3.5z" fill="#c5ab7b"/>
              </svg>
            )}
          </span>

          {/* Name / rename input */}
          {renamingPath === node.path ? (
            <input
              className="tree-rename-input"
              value={renameVal} autoFocus
              onChange={e => onRenameChange(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") onRenameCommit(); if (e.key === "Escape") onRenameCancel(); }}
              onBlur={onRenameCommit}
              onClick={e => e.stopPropagation()}
              style={{ flex: 1 }}
            />
          ) : (
            <span style={{
              flex: 1, fontSize: 13, color: "#cccccc",
              whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              lineHeight: "22px", fontFamily: "var(--font-ui, -apple-system, sans-serif)",
            }}>
              {node.name}
            </span>
          )}

          {/* Hover action buttons */}
          {hovered && canEdit(myRole) && renamingPath !== node.path && (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, marginLeft: 4 }}
              onClick={e => e.stopPropagation()}
            >
              <span
                title="New File Inside"
                onClick={e => { e.stopPropagation(); onContextMenu(e as any, node.path, "folder"); }}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 18, height: 18, borderRadius: 3, cursor: "pointer",
                  color: "#cccccc", fontSize: 14, lineHeight: 1,
                  background: "rgba(255,255,255,0.1)",
                }}
              >+</span>
            </span>
          )}
        </div>

        {/* Children */}
        {isOpen && (
          <div style={{ position: "relative" }}>
            {/* Continuous indent guide for children block */}
            <span style={{
              position: "absolute",
              left: paddingLeft + 7,
              top: 0, bottom: 0, width: 1,
              background: "rgba(255,255,255,0.08)",
              pointerEvents: "none",
            }} />
            {node.children?.map(c => (
              <FileTreeItem key={c.path} {...props} node={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  // ── FILE ──────────────────────────────────────────────────────────────────
  if (node.name === ".gitkeep") return null;

  const isActive = activeFile === node.path;

  return (
    <div
      style={{
        display: "flex", alignItems: "center",
        height: 22,
        paddingLeft: paddingLeft + 18, // extra 18 for chevron-width alignment
        paddingRight: 4,
        position: "relative", cursor: "pointer", userSelect: "none",
        background: isActive
          ? "rgba(0,122,204,0.25)"
          : hovered ? "rgba(255,255,255,0.07)" : "transparent",
        // Active file: thin left accent bar like VS Code
        borderLeft: isActive ? "2px solid #007acc" : "2px solid transparent",
      }}
      onClick={() => onFileClick(node.path)}
      onContextMenu={e => onContextMenu(e, node.path, "file")}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      draggable={canEdit(myRole) && renamingPath !== node.path}
      onDragStart={e => {
        e.dataTransfer.setData("text/plain", node.path);
        e.dataTransfer.effectAllowed = "move";
        const ghost = document.createElement("div");
        ghost.textContent = node.name;
        ghost.style.cssText = "position:fixed;top:-100px;background:#094771;color:#fff;padding:3px 10px;border-radius:4px;font-size:12px;font-family:monospace;pointer-events:none;";
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        setTimeout(() => document.body.removeChild(ghost), 0);
      }}
    >
      {/* Indent guides */}
      {Array.from({ length: depth }).map((_, i) => (
        <span key={i} style={{
          position: "absolute",
          left: BASE_PADDING + i * INDENT_PER_DEPTH + 7,
          top: 0, bottom: 0, width: 1,
          background: "rgba(255,255,255,0.08)",
          pointerEvents: "none",
        }} />
      ))}

      {/* File icon */}
      <span style={{ flexShrink: 0, marginRight: 6, display: "inline-flex", alignItems: "center" }}>
        <FileIconBadge name={node.name} size={16} />
      </span>

      {/* Name / rename */}
      {renamingPath === node.path ? (
        <input
          className="tree-rename-input"
          value={renameVal} autoFocus
          onChange={e => onRenameChange(e.target.value)}
          onKeyDown={e => { if (e.key === "Enter") onRenameCommit(); if (e.key === "Escape") onRenameCancel(); }}
          onBlur={onRenameCommit}
          onClick={e => e.stopPropagation()}
          style={{ flex: 1 }}
        />
      ) : (
        <>
          <span style={{
            flex: 1, fontSize: 13,
            color: isActive ? "#ffffff" : "#cccccc",
            whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
            lineHeight: "22px", fontFamily: "var(--font-ui, -apple-system, sans-serif)",
          }}>
            {node.name}
          </span>

          {/* Hover action button */}
          {hovered && canEdit(myRole) && (
            <span
              style={{ display: "inline-flex", alignItems: "center", gap: 2, flexShrink: 0, marginLeft: 4 }}
              onClick={e => e.stopPropagation()}
            >
              <span
                title="More actions"
                onClick={e => { e.stopPropagation(); onContextMenu(e as any, node.path, "file"); }}
                style={{
                  display: "inline-flex", alignItems: "center", justifyContent: "center",
                  width: 18, height: 18, borderRadius: 3, cursor: "pointer",
                  color: "#cccccc", fontSize: 13, lineHeight: 1,
                  background: "rgba(255,255,255,0.1)",
                }}
              >⋯</span>
            </span>
          )}
        </>
      )}
    </div>
  );
}

// ─── OpenFolderInput ──────────────────────────────────────────────────────
// VS Code-style "Open Folder" — hidden input triggered programmatically.
// Uses webkitdirectory so the OS shows a folder picker, not a file picker.

function OpenFolderInput({ inputRef, onOpen }: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onOpen:   (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <input
      ref={inputRef}
      type="file"
      style={{ display: "none" }}
      onChange={onOpen}
      {...({ webkitdirectory: "", directory: "", multiple: true } as any)}
    />
  );
}

// ─── Command Palette ──────────────────────────────────────────────────────

interface CmdItem { id: string; label: string; description?: string; keybind?: string; icon?: string; action: () => void }

function CommandPalette({ items, onClose }: { items: CmdItem[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const filtered = useMemo(() =>
    query.trim() ? items.filter(i => i.label.toLowerCase().includes(query.toLowerCase()) || (i.description || "").toLowerCase().includes(query.toLowerCase())) : items,
    [items, query]
  );
  useEffect(() => { setSel(0); }, [query]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setSel(p => Math.min(p + 1, filtered.length - 1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSel(p => Math.max(p - 1, 0)); }
      if (e.key === "Enter")     { filtered[sel]?.action(); onClose(); }
      if (e.key === "Escape")    onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [filtered, sel, onClose]);

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        <input className="cmd-palette-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="Type a command or file name…" autoFocus />
        <div className="cmd-palette-list">
          {filtered.length === 0 && <div style={{ padding: "12px 16px", color: "#6a6a6a", fontSize: 13 }}>No results</div>}
          {filtered.map((item, i) => (
            <div key={item.id} className={`cmd-palette-item${i === sel ? " selected" : ""}`}
              onClick={() => { item.action(); onClose(); }}
              onMouseEnter={() => setSel(i)}>
              <span className="cmd-palette-item-icon">{item.icon ?? "›"}</span>
              <span className="cmd-palette-item-label">{item.label}</span>
              {item.description && <span style={{ fontSize: 11, color: "#6a6a6a", marginLeft: 8 }}>{item.description}</span>}
              {item.keybind && <span className="cmd-palette-item-kb">{item.keybind}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Create File Modal ────────────────────────────────────────────────────

const FILE_TEMPLATES = [
  { label: "TypeScript", ext: ".ts", icon: "TS" }, { label: "TSX (React)", ext: ".tsx", icon: "⚛" },
  { label: "JavaScript", ext: ".js", icon: "JS" }, { label: "JSX (React)", ext: ".jsx", icon: "⚛" },
  { label: "HTML", ext: ".html", icon: "HTML" }, { label: "CSS", ext: ".css", icon: "CSS" },
  { label: "JSON", ext: ".json", icon: "{}" }, { label: "Python", ext: ".py", icon: "PY" },
  { label: "Java", ext: ".java", icon: "☕" }, { label: "C", ext: ".c", icon: "C" },
  { label: "C++", ext: ".cpp", icon: "C++" }, { label: "Go", ext: ".go", icon: "GO" },
  { label: "Rust", ext: ".rs", icon: "RS" }, { label: "Markdown", ext: ".md", icon: "MD" },
  { label: "Shell Script", ext: ".sh", icon: "SH" }, { label: "Ruby", ext: ".rb", icon: "RB" },
  { label: "Plain Text", ext: ".txt", icon: "·" },
];

function CreateFileModal({ onClose, onConfirm }: { onClose: () => void; onConfirm: (name: string) => void }) {
  const [step, setStep] = useState<"pick" | "name">("pick");
  const [query, setQuery] = useState("");
  const [ext, setExt] = useState<string | null>(null);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); }, [step]);
  const filtered = FILE_TEMPLATES.filter(t => t.label.toLowerCase().includes(query.toLowerCase()) || t.ext.includes(query.toLowerCase()));
  const pick = (e: string) => { setExt(e); setName(`untitled${e}`); setStep("name"); };
  const confirm = () => { if (name.trim()) onConfirm(name.trim()); };
  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        {step === "pick" ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 14px", borderBottom: "1px solid #454545" }}>
              <svg width="13" height="13" viewBox="0 0 16 16" fill="#6a6a6a"><path d="M6 2a4 4 0 100 8 4 4 0 000-8zM0 6a6 6 0 1110.89 3.477l4.817 4.816a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 010 6z"/></svg>
              <input ref={inputRef} value={query} onChange={e => setQuery(e.target.value)}
                onKeyDown={e => { if (e.key === "Escape") onClose(); if (e.key === "Enter" && filtered[0]) pick(filtered[0].ext); }}
                placeholder="Select language…" className="cmd-palette-input" style={{ border: "none", height: 42 }} autoFocus />
            </div>
            <div className="cmd-palette-list">
              {filtered.map((t, i) => (
                <div key={t.ext} className={`cmd-palette-item${i === 0 && query ? " selected" : ""}`} onClick={() => pick(t.ext)}>
                  <span style={{ width: 18, textAlign: "center", fontSize: 10, fontFamily: "var(--font-mono)", color: getFileIconColor(`f${t.ext}`), fontWeight: 700 }}>{t.icon}</span>
                  <span className="cmd-palette-item-label">{t.label}</span>
                  <span style={{ fontSize: 11, color: "#6a6a6a", fontFamily: "var(--font-mono)" }}>{t.ext}</span>
                </div>
              ))}
              <div className="cmd-palette-item" onClick={() => { setExt(""); setName(query || "untitled"); setStep("name"); }}>
                <span>✏</span>
                <span className="cmd-palette-item-label">Custom file name…</span>
              </div>
            </div>
          </>
        ) : (
          <div style={{ padding: 16 }}>
            <div style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px" }}>{ext ? `New ${ext} file` : "New file"}</div>
            <input ref={inputRef} value={name} onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") confirm(); if (e.key === "Escape") setStep("pick"); }}
              placeholder={`src/utils/helper${ext || ".ts"}`} className="modal-input" style={{ marginBottom: 8 }} autoFocus />
            <div style={{ fontSize: 11, color: "#6a6a6a", marginBottom: 14 }}>Tip: include a path like <code>src/components/Button{ext || ".ts"}</code></div>
            <div className="modal-actions" style={{ marginTop: 0 }}>
              <button className="btn btn-secondary" onClick={() => setStep("pick")}>Back</button>
              <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
              <button className="btn btn-primary" onClick={confirm} disabled={!name.trim()}>Create</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── AI Copilot Panel ─────────────────────────────────────────────────────

function AiPanel({ activeFile, code, selectedCode, terminalLogs, onApplyFix, onClose }: {
  activeFile: string; code: string; selectedCode: string; terminalLogs: string;
  onApplyFix: (code: string) => void; onClose: () => void;
}) {
  const [tab, setTab]           = useState<AiTab>("chat");
  const [messages, setMessages] = useState<AiMessage[]>([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [fixResult, setFixResult] = useState<AiResponse | null>(null);
  const [expResult, setExpResult] = useState<AiResponse | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const lang = getLangName(activeFile);
  const base = { fileName: activeFile, code, language: lang, selectedCode: selectedCode || undefined };

  async function callAi(ep: string, body: object): Promise<AiResponse> {
    const res = await fetch(`${API}/api/ai/${ep}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ roomId: "", ...base, ...body }),
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error || "AI request failed"); }
    return res.json();
  }

  const doChat = async () => {
    const msg = input.trim(); if (!msg || loading) return;
    setInput(""); setError(null);
    setMessages(p => [...p, { role: "user", content: msg, timestamp: Date.now() }]);
    setLoading(true);
    try {
      const r = await callAi("chat", { userMessage: msg, errorLogs: terminalLogs || undefined });
      setMessages(p => [...p, { role: "ai", content: r.explanation || r.message || "", fixedCode: r.fixedCode || undefined, timestamp: Date.now() }]);
    } catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const doFix = async () => {
    setLoading(true); setError(null); setFixResult(null); setShowDiff(false);
    try { setFixResult(await callAi("bug-fix", { errorLogs: terminalLogs || undefined })); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  const doExplain = async () => {
    setLoading(true); setError(null); setExpResult(null);
    try { setExpResult(await callAi("explain", {})); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="ai-panel-outer">
      <div className="ai-header">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#007acc" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
        <span className="ai-header-title">Copilot</span>
        {activeFile && <span className="ai-header-file">{activeFile.split("/").pop()}</span>}
        <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "#6a6a6a", fontSize: 16, lineHeight: 1, marginLeft: "auto", padding: "2px 4px", borderRadius: 3 }} onMouseEnter={e => (e.currentTarget.style.color = "#cccccc")} onMouseLeave={e => (e.currentTarget.style.color = "#6a6a6a")}>✕</button>
      </div>
      <div className="ai-tabs">
        {(["chat", "fix", "explain"] as AiTab[]).map(t => (
          <button key={t} className={`ai-tab${tab === t ? " active" : ""}`} onClick={() => { setTab(t); setError(null); }}>
            {t === "chat" ? "Chat" : t === "fix" ? "Fix Bug" : "Explain"}
          </button>
        ))}
      </div>
      <div className="ai-body">
        {tab === "chat" && (
          <>
            <div className="ai-chat-list">
              {messages.length === 0 && (
                <div className="ai-chat-empty">
                  <div className="ai-chat-empty-icon">⬡</div>
                  <div className="ai-chat-empty-text">Ask Copilot anything</div>
                  <div className="ai-chat-empty-hint">Select code in the editor for context-aware answers. Use Shift+Enter for multiline.</div>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: m.role === "user" ? "flex-end" : "flex-start" }}>
                  <div className={m.role === "user" ? "ai-msg-user" : "ai-msg-ai"}>{m.content}</div>
                  {m.fixedCode && m.role === "ai" && (
                    <>
                      <pre className="ai-code-block">{m.fixedCode}</pre>
                      <button className="ai-apply-btn" onClick={() => onApplyFix(m.fixedCode!)}>⤵ Apply to editor</button>
                    </>
                  )}
                  <div className="ai-msg-time">{fmtTime(m.timestamp)}</div>
                </div>
              ))}
              {loading && (
                <div className="ai-typing">
                  {[0, 1, 2].map(i => <span key={i} className="ai-typing-dot" style={{ animationDelay: `${i * 0.2}s` }} />)}
                </div>
              )}
              {error && <div className="ai-error-box">⚠ {error}</div>}
              <div ref={chatEndRef} />
            </div>
            <div className="ai-input-row">
              <textarea value={input} onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doChat(); } }}
                placeholder="Ask Copilot… (Enter to send, Shift+Enter for newline)"
                className="ai-textarea" rows={2} />
              <button className="ai-send" onClick={doChat} disabled={loading || !input.trim()}>↑</button>
            </div>
          </>
        )}
        {tab === "fix" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 12.5, color: "#969696", marginBottom: 8, lineHeight: 1.65 }}>
                {selectedCode ? "Copilot will fix the selected code." : "Copilot will fix the entire file."}
                {terminalLogs ? " Terminal errors will be used as context." : ""}
              </p>
              {terminalLogs && (
                <div style={{ background: "rgba(244,71,71,0.08)", border: "1px solid rgba(244,71,71,0.2)", borderRadius: 4, padding: "6px 10px", fontSize: 11.5, color: "#f88", fontFamily: "var(--font-mono)", marginBottom: 10, maxHeight: 80, overflow: "auto" }}>
                  {terminalLogs.slice(-500)}
                </div>
              )}
              <button className="ai-action-btn" style={{ background: "rgba(0,122,204,0.12)", borderColor: "rgba(0,122,204,0.35)", color: "#3794ff" }}
                onClick={doFix} disabled={loading}>{loading ? "Analyzing…" : "🔍 Analyze & Fix"}</button>
            </div>
            {error && <div className="ai-error-box">⚠ {error}</div>}
            {fixResult && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#cccccc", lineHeight: 1.5 }}>{fixResult.explanation}</div>
                {fixResult.fixedCode && (
                  <>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="ai-label">Fixed Code</span>
                      <button onClick={() => setShowDiff(p => !p)} style={{ background: "none", border: "none", cursor: "pointer", fontSize: 11, color: "#6a6a6a" }}>{showDiff ? "Hide diff" : "Diff view"}</button>
                    </div>
                    {showDiff && (
                      <div className="diff-viewer">
                        {fixResult.fixedCode.split("\n").map((l, i) => <span key={`a-${i}`} className="diff-add">+ {l}</span>)}
                      </div>
                    )}
                    <pre className="ai-code-block">{fixResult.fixedCode}</pre>
                    <button className="ai-apply-btn" style={{ width: "100%", justifyContent: "center", padding: "9px" }}
                      onClick={() => onApplyFix(fixResult.fixedCode)}>⤵ Apply Fix to Editor</button>
                  </>
                )}
                {(fixResult.suggestions?.length ?? 0) > 0 && (
                  <div className="ai-section">
                    <div className="ai-label">Suggestions</div>
                    {fixResult.suggestions.map((s, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5, fontSize: 12.5, color: "#969696", lineHeight: 1.6 }}>
                        <span style={{ color: "#dcdcaa", flexShrink: 0 }}>→</span>{s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {tab === "explain" && (
          <div style={{ flex: 1, overflowY: "auto", padding: 14 }}>
            <div style={{ marginBottom: 12 }}>
              <p style={{ fontSize: 12.5, color: "#969696", marginBottom: 8, lineHeight: 1.65 }}>
                {selectedCode ? "Copilot will explain the selected code." : "Copilot will explain the entire file."}
              </p>
              <button className="ai-action-btn" style={{ background: "rgba(220,220,170,0.08)", borderColor: "rgba(220,220,170,0.25)", color: "#dcdcaa" }}
                onClick={doExplain} disabled={loading}>{loading ? "Analyzing…" : "💡 Explain Code"}</button>
            </div>
            {error && <div className="ai-error-box">⚠ {error}</div>}
            {expResult && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ background: "rgba(0,122,204,0.08)", border: "1px solid rgba(0,122,204,0.2)", borderRadius: 4, padding: "10px 14px" }}>
                  <p style={{ fontSize: 13.5, color: "#cccccc", lineHeight: 1.65, margin: 0 }}>{expResult.explanation}</p>
                </div>
                {(expResult.suggestions?.length ?? 0) > 0 && (
                  <div className="ai-section">
                    <div className="ai-label">Tips & Notes</div>
                    {expResult.suggestions.map((s, i) => (
                      <div key={i} style={{ display: "flex", gap: 8, marginBottom: 5, fontSize: 12.5, color: "#969696", lineHeight: 1.6 }}>
                        <span style={{ color: "#4ec9b0", flexShrink: 0 }}>→</span>{s}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Landing Page ─────────────────────────────────────────────────────────

function LandingPage({ currentUser, onEnterRoom }: { currentUser: AppUser | null; onEnterRoom: (id: string) => void }) {
  const [tab, setTab]       = useState<"create" | "join">("create");
  const [roomName, setRN]   = useState("");
  const [joinId, setJoinId] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining]   = useState(false);
  const [err, setErr]           = useState<string | null>(null);

  useEffect(() => {
    const m = window.location.pathname.match(/^\/room\/([^/]+)/);
    if (m) { setJoinId(m[1]); setTab("join"); }
  }, []);

  const create = async () => {
    if (!currentUser) { setErr("Sign in first"); return; }
    setCreating(true); setErr(null);
    try {
      const r = await fetch(`${API}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ roomName: roomName.trim() || "My Room", user: currentUser }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error);
      window.history.pushState({}, "", `/room/${d.roomId}`); onEnterRoom(d.roomId);
    } catch (e: any) { setErr(e.message); } finally { setCreating(false); }
  };

  const join = async () => {
    const id = joinId.trim(); if (!id) { setErr("Enter a room ID"); return; }
    if (!currentUser) { setErr("Sign in first"); return; }
    setJoining(true); setErr(null);
    try {
      const r = await fetch(`${API}/api/rooms/${id}`); const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Room not found");
      window.history.pushState({}, "", `/room/${id}`); onEnterRoom(id);
    } catch (e: any) { setErr(e.message); } finally { setJoining(false); }
  };

  return (
    <div className="landing-root">
      <div className="landing-card">
        <div className="landing-logo">
          <div className="landing-logo-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
          </div>
          <div>
            <div className="landing-title">CodeCollab</div>
            <div className="landing-sub">Collaborative IDE</div>
          </div>
        </div>
        {!currentUser ? (
          <div style={{ textAlign: "center" }}>
            <p style={{ color: "#969696", fontSize: 13, marginBottom: 18 }}>Sign in to create or join a coding room</p>
            <button className="btn btn-primary" style={{ width: "100%", padding: "9px" }} onClick={() => loginWithGoogle().catch(console.error)}>
              Sign in with Google
            </button>
          </div>
        ) : (
          <>
            <div className="landing-user-chip">
              <div style={{ width: 28, height: 28, borderRadius: "50%", background: getUserColor(currentUser.uid), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 700, color: "#fff", flexShrink: 0 }}>{currentUser.name[0].toUpperCase()}</div>
              <span style={{ fontSize: 13, color: "#cccccc", flex: 1 }}>{currentUser.name}</span>
              <button onClick={() => logoutUser().catch(console.error)} style={{ background: "none", border: "none", color: "#6a6a6a", fontSize: 12, cursor: "pointer" }}>Sign out</button>
            </div>
            <div className="landing-tabs">
              {(["create", "join"] as const).map(t => (
                <button key={t} className={`landing-tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
                  {t === "create" ? "Create Room" : "Join Room"}
                </button>
              ))}
            </div>
            {tab === "create" && (
              <>
                <label className="landing-label">Room name</label>
                <input className="landing-input" placeholder="My Awesome Project" value={roomName} onChange={e => setRN(e.target.value)} onKeyDown={e => e.key === "Enter" && create()} maxLength={80} />
                <button className="btn btn-primary" style={{ width: "100%", padding: "9px" }} onClick={create} disabled={creating}>{creating ? "Creating…" : "Create Room"}</button>
              </>
            )}
            {tab === "join" && (
              <>
                <label className="landing-label">Room ID or link</label>
                <input className="landing-input" placeholder="aBcD1234 or full URL" value={joinId}
                  onChange={e => { const v = e.target.value.trim(); const m = v.match(/room\/([^/?#]+)/); setJoinId(m ? m[1] : v); }}
                  onKeyDown={e => e.key === "Enter" && join()} />
                <button className="btn btn-primary" style={{ width: "100%", padding: "9px" }} onClick={join} disabled={joining}>{joining ? "Joining…" : "Join Room"}</button>
              </>
            )}
            {err && <div className="landing-error">⚠ {err}</div>}
          </>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════════════════

export default function App() {
  // ── View & room ──────────────────────────────────────────────────────────
  const [view, setView]         = useState<View>("landing");
  const [roomId, setRoomId]     = useState<string | null>(null);
  const [roomMeta, setRoomMeta] = useState<RoomMeta | null>(null);

  // ── Auth ─────────────────────────────────────────────────────────────────
  const [currentUser, setCurrentUser] = useState<AppUser | null>(null);

  // ── Collaboration ────────────────────────────────────────────────────────
  const [isConnected,   setIsConnected]   = useState(false);
  const [users,         setUsers]         = useState<RoomUser[]>([]);
  const [typingUsers,   setTypingUsers]   = useState<Record<string, RoomUser>>({});
  const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({});
  const [myRole,        setMyRole]        = useState<Role | null>(null);
  const [followUser,    setFollowUser]    = useState<string | null>(null);

  // ── Chat & activity ───────────────────────────────────────────────────────
  const [chatMessages,  setChatMessages]  = useState<ChatMessage[]>([]);
  const [chatInput,     setChatInput]     = useState("");
  const [activities,    setActivities]    = useState<TeamActivity[]>([]);

  // ── UI state ──────────────────────────────────────────────────────────────
  const [activityView,  setActivityView]  = useState<ActivityView>("explorer");
  const [sidebarWidth,  setSidebarWidth]  = useState(240);
  const [sidebarOpen,   setSidebarOpen]   = useState(true);
  const [showAi,        setShowAi]        = useState(false);
  const [showRolePanel, setShowRolePanel] = useState(false);
  const [showActivity,  setShowActivity]  = useState(false);
  const [showChat,      setShowChat]      = useState(false);
  const [showCmdPalette, setShowCmdPalette] = useState(false);
  const [permDenied,    setPermDenied]    = useState<string | null>(null);
  const [linkCopied,    setLinkCopied]    = useState(false);

  // ── File system ───────────────────────────────────────────────────────────
  const [files,         setFiles]         = useState<Record<string, string>>({});
  const [openTabs,      setOpenTabs]      = useState<string[]>([]);
  const [activeFile,    setActiveFile]    = useState("");
  const [openFolders,   setOpenFolders]   = useState<Set<string>>(new Set());
  const [dirtyFiles,    setDirtyFiles]    = useState<Set<string>>(new Set());
  const [openFolderName, setOpenFolderName] = useState<string | null>(null); // VS Code "open folder" name
  const [renamingPath,  setRenamingPath]  = useState<string | null>(null);
  const [renameVal,     setRenameVal]     = useState("");

  // ── Context menu ──────────────────────────────────────────────────────────
  const [ctxMenu, setCtxMenu] = useState<{ visible: boolean; x: number; y: number; path: string; nodeType: "file"|"folder" } | null>(null);
  const [fileToDelete,  setFileToDelete]  = useState<string | null>(null);
  const [isCreateOpen,  setIsCreateOpen]  = useState(false);

  // ── Panel ─────────────────────────────────────────────────────────────────
  const [panelMode,   setPanelMode]   = useState<PanelMode>("output");
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [panelHeight, setPanelHeight] = useState(240);
  const [termTabs,    setTermTabs]    = useState<TerminalTab[]>([]);
  const [activeTermId,setActiveTermId]= useState<string | null>(null);
  const [output,      setOutput]      = useState<string[]>([]);

  // ── AI ────────────────────────────────────────────────────────────────────
  const [selectedCode, setSelectedCode] = useState("");
  const [terminalLogs, setTerminalLogs] = useState("");

  // ── Refs ──────────────────────────────────────────────────────────────────
  const editorRef        = useRef<any>(null);
  const monacoRef        = useRef<any>(null);
  const decoIds          = useRef<string[]>([]);
  const roomIdRef        = useRef<string | null>(null);
  const myRoleRef        = useRef<Role | null>(null);
  const filesRef         = useRef<Record<string, string>>(files);
  const currentUserRef   = useRef<AppUser | null>(null);
  const typingTimeout    = useRef<number | null>(null);
  const fileInputRef     = useRef<HTMLInputElement | null>(null);
  const openFolderInputRef = useRef<HTMLInputElement>(null);
  const chatBodyRef      = useRef<HTMLDivElement | null>(null);
  const seenActivityIds  = useRef<Set<string>>(new Set());
  const isDragging       = useRef(false);
  const dragStartY       = useRef(0);
  const dragStartH       = useRef(0);
  const isSidebarDrag    = useRef(false);
  const sidebarDragX     = useRef(0);
  const sidebarDragW     = useRef(0);
  const termInstances    = useRef<Map<string, { term: Terminal; fit: FitAddon; joined: boolean }>>(new Map());
  const termDivRefs      = useRef<Map<string, HTMLDivElement>>(new Map());
  const xtermRef         = useRef<Terminal | null>(null);
  const terminalJoined   = useRef(false);

  // ── FIXED: cursor label hide timers ──────────────────────────────────────
  // Tracks per-user setTimeout handles so each label auto-hides after 2 s
  // of inactivity without touching Monaco's decoration DOM.
  const cursorHideTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { myRoleRef.current = myRole; }, [myRole]);
  useEffect(() => { if (chatBodyRef.current) chatBodyRef.current.scrollTop = chatBodyRef.current.scrollHeight; }, [chatMessages]);

  // ── FIXED: showCursorLabel — shows label, schedules 2 s auto-hide ────────
  // Uses a CSS custom property on :root to drive opacity, so no DOM
  // manipulation and zero interference with Monaco decorations.
  const showCursorLabel = useCallback((ck: string) => {
    // Make label visible
    document.documentElement.style.setProperty(`--rc-opacity-${ck}`, "1");

    // Cancel any existing hide timer for this user
    const prev = cursorHideTimers.current.get(ck);
    if (prev) clearTimeout(prev);

    // Schedule fade-out after 2 s of no cursor movement
    cursorHideTimers.current.set(
      ck,
      setTimeout(() => {
        document.documentElement.style.setProperty(`--rc-opacity-${ck}`, "0");
        cursorHideTimers.current.delete(ck);
      }, 2000),
    );
  }, []);

  const visibleFiles = useMemo(() => {
    const out: Record<string, string> = {};
    Object.entries(files).forEach(([k, v]) => {
      if (!k.endsWith("/.gitkeep")) out[k] = v;
    });
    return out;
  }, [files]);
  const fileTree = useMemo(() => buildTree(visibleFiles), [visibleFiles]);
  const otherUsers  = useMemo(() => users.filter(u => u.socketId !== (socket.id ?? "")), [users]);
  const currentCode = files[activeFile] ?? "";

  // ── URL on mount ──────────────────────────────────────────────────────────
  useEffect(() => {
    const m = window.location.pathname.match(/^\/room\/([^/]+)/);
    if (m) { setRoomId(m[1]); roomIdRef.current = m[1]; }
  }, []);

  // ── Auth ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    return observeAuthState(user => {
      if (!user) { setCurrentUser(null); currentUserRef.current = null; return; }
      const u: AppUser = { uid: user.uid, name: user.displayName || user.email?.split("@")[0] || "User", email: user.email || "", photoURL: user.photoURL || undefined };
      setCurrentUser(u); currentUserRef.current = u;
    });
  }, []);

  const showPermDenied = useCallback((msg: string) => { setPermDenied(msg); setTimeout(() => setPermDenied(null), 3000); }, []);

  const enterRoom = useCallback((id: string) => {
    setRoomId(id); roomIdRef.current = id;
    setFiles({}); setOpenTabs([]); setActiveFile(""); setDirtyFiles(new Set());
    setActivities([]); setChatMessages([]);
    seenActivityIds.current.clear(); terminalJoined.current = false;
    setTermTabs([]); setActiveTermId(null); setOpenFolderName(null); setView("editor");
  }, []);
  useEffect(() => { if (currentUser && roomId && view === "landing") enterRoom(roomId); }, [currentUser, roomId, view, enterRoom]);

  // ── Socket connection ─────────────────────────────────────────────────────
  useEffect(() => {
    const on = () => setIsConnected(true); const off = () => setIsConnected(false);
    socket.on("connect", on); socket.on("disconnect", off);
    setIsConnected(socket.connected);
    return () => { socket.off("connect", on); socket.off("disconnect", off); };
  }, []);

  useEffect(() => {
    if (view !== "editor" || !currentUser || !roomIdRef.current) return;
    socket.emit("join-room", { roomId: roomIdRef.current, user: currentUser });
  }, [view, currentUser]);

  useEffect(() => {
    const hRole = ({ role }: { role: Role }) => { setMyRole(role); myRoleRef.current = role; };
    const hMeta = (m: RoomMeta) => setRoomMeta(m);
    socket.on("your-role", hRole); socket.on("room-meta", hMeta);
    return () => { socket.off("your-role", hRole); socket.off("room-meta", hMeta); };
  }, []);

  useEffect(() => {
    const h = ({ reason }: { reason: string }) => showPermDenied(reason);
    socket.on("permission-denied", h); return () => { socket.off("permission-denied", h); };
  }, [showPermDenied]);

  // ── Tab helpers ───────────────────────────────────────────────────────────
  const openTab = useCallback((fp: string) => {
    setOpenTabs(p => p.includes(fp) ? p : [...p, fp]); setActiveFile(fp);
  }, []);
  const openParentFolders = useCallback((fp: string) => {
    if (!fp.includes("/")) return;
    const pts = fp.split("/");
    setOpenFolders(p => { const n = new Set(p); for (let i = 1; i < pts.length; i++) n.add(pts.slice(0, i).join("/")); return n; });
  }, []);
  const closeTab = useCallback((fp: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOpenTabs(p => { const nx = p.filter(t => t !== fp); if (activeFile === fp) setActiveFile(nx[Math.max(0, p.indexOf(fp) - 1)] ?? nx[0] ?? ""); return nx.length ? nx : p; });
    setDirtyFiles(p => { const n = new Set(p); n.delete(fp); return n; });
  }, [activeFile]);

  // ── Socket: files ─────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (f: Record<string, string>) => {
      setFiles(p => ({ ...p, ...f }));
      const paths = Object.keys(f).sort();
      if (paths.length > 0) { openTab(paths[0]); paths.forEach(openParentFolders); }
    };
    socket.on("room-files", h); return () => { socket.off("room-files", h); };
  }, [openTab, openParentFolders]);

  const appendActivity  = useCallback((a: TeamActivity) => { if (seenActivityIds.current.has(a.id)) return; seenActivityIds.current.add(a.id); setActivities(p => [...p, a]); }, []);
  const appendActivities = useCallback((list: TeamActivity[]) => { setActivities(p => { const inc = list.filter(a => { if (seenActivityIds.current.has(a.id)) return false; seenActivityIds.current.add(a.id); return true; }); return inc.length ? [...p, ...inc] : p; }); }, []);

  useEffect(() => {
    socket.on("activity-history", (l: TeamActivity[]) => appendActivities(l));
    socket.on("chat-history", (l: ChatMessage[]) => setChatMessages(p => { const ids = new Set(p.map(m => m.id)); return [...p, ...l.filter(m => !ids.has(m.id))]; }));
    return () => { socket.off("activity-history"); socket.off("chat-history"); };
  }, [appendActivities]);

  useEffect(() => { socket.on("team-activity", appendActivity); return () => { socket.off("team-activity", appendActivity); }; }, [appendActivity]);

  useEffect(() => {
    const h = (m: ChatMessage) => setChatMessages(p => p.some(x => x.id === m.id) ? p : [...p, m]);
    socket.on("receive-chat-message", h); return () => { socket.off("receive-chat-message", h); };
  }, []);

  useEffect(() => {
    const h = ({ fileName, code }: { fileName: string; code: string }) => setFiles(p => p[fileName] === code ? p : { ...p, [fileName]: code });
    socket.on("receive-code", h); return () => { socket.off("receive-code", h); };
  }, []);

  useEffect(() => {
    const onCreated = (fn: string) => {
      if (fn.endsWith("/.gitkeep")) {
        const folderPath = fn.replace("/.gitkeep", "");
        setOpenFolders(p => new Set([...p, folderPath]));
        setFiles(p => ({ ...p, [fn]: "" }));
        return;
      }
      setFiles(p => p[fn] !== undefined ? p : { ...p, [fn]: "" });
      openTab(fn);
      openParentFolders(fn);
    };
    const onDeleted = (fn: string) => {
      setFiles(p => { const u = { ...p }; delete u[fn]; return u; });
      setOpenTabs(p => {
        const nx = p.filter(t => t !== fn);
        if (activeFile === fn) setActiveFile(nx[0] ?? "");
        return nx;
      });
    };
    const onRenamed = ({ oldFileName: o, newFileName: n }: { oldFileName: string; newFileName: string }) => {
      setFiles(p => {
        if (!(o in p)) return p;
        const u: typeof p = {};
        Object.entries(p).forEach(([k, v]) => { u[k === o ? n : k] = v; });
        return u;
      });
      setOpenTabs(p => p.map(t => t === o ? n : t));
      setActiveFile(p => p === o ? n : p);
    };
    const onMoved = ({ oldPath, newPath }: { oldPath: string; newPath: string }) => {
      setFiles(p => {
        if (!(oldPath in p)) return p;
        const u: typeof p = {};
        Object.entries(p).forEach(([k, v]) => { u[k === oldPath ? newPath : k] = v; });
        return u;
      });
      setOpenTabs(p => p.map(t => t === oldPath ? newPath : t));
      setActiveFile(p => p === oldPath ? newPath : p);
    };
    const onFolderDeleted = ({ deletedPaths }: { folderPath: string; deletedPaths: string[] }) => {
      const pathSet = new Set(deletedPaths);
      setFiles(p => {
        const u: typeof p = {};
        Object.entries(p).forEach(([k, v]) => { if (!pathSet.has(k)) u[k] = v; });
        return u;
      });
      setOpenTabs(p => {
        const nx = p.filter(t => !pathSet.has(t));
        if (pathSet.has(activeFile)) setActiveFile(nx[0] ?? "");
        return nx;
      });
      setDirtyFiles(p => { const n = new Set(p); deletedPaths.forEach(dp => n.delete(dp)); return n; });
    };
    const onFolderRenamed = ({ renamedFiles }: { oldPath: string; newPath: string; renamedFiles: Record<string, string> }) => {
      setFiles(p => {
        const u: typeof p = {};
        Object.entries(p).forEach(([k, v]) => { u[renamedFiles[k] ?? k] = v; });
        return u;
      });
      setOpenTabs(p => p.map(t => renamedFiles[t] ?? t));
      setActiveFile(p => renamedFiles[p] ?? p);
    };
    socket.on("file-created",    onCreated);
    socket.on("file-deleted",    onDeleted);
    socket.on("file-renamed",    onRenamed);
    socket.on("file-moved",      onMoved);
    socket.on("folder-deleted",  onFolderDeleted);
    socket.on("folder-renamed",  onFolderRenamed);
    return () => {
      socket.off("file-created",    onCreated);
      socket.off("file-deleted",    onDeleted);
      socket.off("file-renamed",    onRenamed);
      socket.off("file-moved",      onMoved);
      socket.off("folder-deleted",  onFolderDeleted);
      socket.off("folder-renamed",  onFolderRenamed);
    };
  }, [activeFile, openTab, openParentFolders]);

  useEffect(() => {
    const h = (ul: RoomUser[]) => {
      setUsers(ul);
      const v = new Set(ul.map(u => u.socketId));
      setRemoteCursors(p => { const n: typeof p = {}; Object.entries(p).forEach(([id, c]) => { if (v.has(id)) n[id] = c; }); return n; });
      setTypingUsers(p => { const n: typeof p = {}; Object.entries(p).forEach(([id, u]) => { if (v.has(id)) n[id] = u; }); return n; });
    };
    socket.on("room-users", h); return () => { socket.off("room-users", h); };
  }, []);

  useEffect(() => {
    socket.on("receive-cursor", (c: RemoteCursor) => {
      setRemoteCursors(p => ({ ...p, [c.user.socketId]: c }));
      if (followUser === c.user.socketId && editorRef.current) {
        editorRef.current.revealPositionInCenter({ lineNumber: c.lineNumber, column: c.column });
      }
    });
    socket.on("user-typing",      (u: RoomUser) => setTypingUsers(p => ({ ...p, [u.socketId]: u })));
    socket.on("user-stop-typing", (u: RoomUser) => setTypingUsers(p => { const c = { ...p }; delete c[u.socketId]; return c; }));
    return () => { socket.off("receive-cursor"); socket.off("user-typing"); socket.off("user-stop-typing"); };
  }, [followUser]);

  useEffect(() => {
    socket.on("request-code-sync", ({ socketId }: { socketId: string }) => socket.emit("sync-code", { socketId, files: filesRef.current }));
    return () => { socket.off("request-code-sync"); };
  }, []);

  useEffect(() => {
    return () => { if (roomIdRef.current) socket.emit("leave-room", roomIdRef.current); if (typingTimeout.current) clearTimeout(typingTimeout.current); };
  }, []);

  // ── FIXED: Remote cursor decorations ────────────────────────────────────
  // Label now floats ABOVE cursor; showCursorLabel() triggers 2 s auto-hide.
  useEffect(() => {
    const editor = editorRef.current; const monaco = monacoRef.current; if (!editor || !monaco) return;
    const decs: any[] = [];

    users.filter(u => u.socketId !== socket.id).forEach(user => {
      const cur = remoteCursors[user.socketId]; if (!cur) return;
      const color = getUserColor(user.uid);
      const ck    = sanitize(user.socketId);

      ensureCursorStyle(ck, color, user.name);
      showCursorLabel(ck); // ← shows label and resets the 2 s hide timer

      const hasSel =
        cur.startLineNumber !== undefined &&
        cur.endLineNumber   !== undefined &&
        (cur.startLineNumber !== cur.endLineNumber ||
          cur.startColumn !== cur.endColumn);

      if (hasSel) {
        decs.push({
          range:   new monaco.Range(cur.startLineNumber, cur.startColumn, cur.endLineNumber, cur.endColumn),
          options: { className: `rc-sel-${ck}`, stickiness: 1 },
        });
      }
      decs.push({
        range:   new monaco.Range(cur.lineNumber, cur.column, cur.lineNumber, cur.column),
        options: { className: `rc-caret-${ck}`, afterContentClassName: `rc-label-${ck}`, stickiness: 1 },
      });
    });

    decoIds.current = editor.deltaDecorations(decoIds.current, decs);
  }, [remoteCursors, users, activeFile, showCursorLabel]);

  // ── Terminal ──────────────────────────────────────────────────────────────
  const addTerminal = useCallback(() => {
    const id = `term-${Date.now()}`; const label = `Terminal ${termTabs.length + 1}`;
    setTermTabs(p => [...p, { id, label }]); setActiveTermId(id); setPanelMode("terminal"); setIsPanelOpen(true);
  }, [termTabs.length]);

  const mountTerminal = useCallback((termId: string, div: HTMLDivElement | null) => {
    if (!div) { termDivRefs.current.delete(termId); return; }
    termDivRefs.current.set(termId, div);
    if (termInstances.current.has(termId)) return;
    const term = new Terminal({
      cursorBlink: true, fontSize: 13, fontFamily: "var(--font-mono)",
      theme: { background: "#1e1e1e", foreground: "#cccccc", cursor: "#aeafad", selectionBackground: "rgba(38,79,120,0.6)", black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510", blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5", brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#e5e5e5" },
      allowTransparency: true, scrollback: 5000,
    });
    const fit = new FitAddon(); term.loadAddon(fit); term.open(div); fit.fit();
    term.onData(data => { if (!roomIdRef.current) return; socket.emit("terminal-input", { roomId: roomIdRef.current, data }); });
    term.onResize(({ cols, rows }) => { if (!roomIdRef.current) return; socket.emit("terminal-resize", { roomId: roomIdRef.current, cols, rows }); });
    termInstances.current.set(termId, { term, fit, joined: false }); xtermRef.current = term;
    if (roomIdRef.current) { socket.emit("terminal-join", { roomId: roomIdRef.current, files: filesRef.current }); terminalJoined.current = true; const inst = termInstances.current.get(termId); if (inst) inst.joined = true; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { if (!activeTermId) return; const inst = termInstances.current.get(activeTermId); if (inst) { xtermRef.current = inst.term; setTimeout(() => inst.fit.fit(), 50); } }, [activeTermId]);
  useEffect(() => { if (panelMode !== "terminal" || !activeTermId) return; const inst = termInstances.current.get(activeTermId); if (inst) setTimeout(() => inst.fit.fit(), 50); }, [panelHeight, panelMode, isPanelOpen, activeTermId]);
  useEffect(() => { if (panelMode === "terminal" && isPanelOpen && termTabs.length === 0) addTerminal(); }, [panelMode, isPanelOpen, termTabs.length, addTerminal]);

  useEffect(() => {
    const onOut  = (d: string) => { if (xtermRef.current) xtermRef.current.write(d); setTerminalLogs(p => (p + d).slice(-3000)); };
    const onHist = (d: string) => { if (xtermRef.current) xtermRef.current.write(d); };
    const onExit = ({ code }: { code: number }) => { if (xtermRef.current) xtermRef.current.write(`\r\n\x1b[33m[Process exited with code ${code}]\x1b[0m\r\n`); };
    const onSwitch = () => { setIsPanelOpen(true); setPanelMode("terminal"); };
    socket.on("terminal-output", onOut); socket.on("terminal-history", onHist); socket.on("terminal-exit", onExit); socket.on("terminal-switch-panel", onSwitch);
    return () => { socket.off("terminal-output", onOut); socket.off("terminal-history", onHist); socket.off("terminal-exit", onExit); socket.off("terminal-switch-panel", onSwitch); };
  }, []);

  // ── Panel / sidebar drag ──────────────────────────────────────────────────
  const startPanelDrag = useCallback((e: React.MouseEvent) => {
    isDragging.current = true; dragStartY.current = e.clientY; dragStartH.current = panelHeight;
    document.body.style.cursor = "ns-resize"; document.body.style.userSelect = "none";
  }, [panelHeight]);

  const startSidebarDrag = useCallback((e: React.MouseEvent) => {
    isSidebarDrag.current = true; sidebarDragX.current = e.clientX; sidebarDragW.current = sidebarWidth;
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  }, [sidebarWidth]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (isDragging.current) setPanelHeight(Math.max(80, Math.min(700, dragStartH.current + (dragStartY.current - e.clientY))));
      if (isSidebarDrag.current) setSidebarWidth(Math.max(140, Math.min(600, sidebarDragW.current + (e.clientX - sidebarDragX.current))));
    };
    const onUp = () => {
      isDragging.current = false; isSidebarDrag.current = false;
      document.body.style.cursor = ""; document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, []);

  // ── Global keydown ────────────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "P") { e.preventDefault(); setShowCmdPalette(p => !p); }
      if ((e.ctrlKey || e.metaKey) && e.key === "`") { e.preventDefault(); setIsPanelOpen(p => !p); if (!isPanelOpen) setPanelMode("terminal"); }
      if (e.key === "Escape") { setCtxMenu(null); setShowCmdPalette(false); }
    };
    window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h);
  }, [isPanelOpen]);

  // ── File operations ───────────────────────────────────────────────────────
  const toggleFolder = useCallback((path: string) => { setOpenFolders(p => { const n = new Set(p); n.has(path) ? n.delete(path) : n.add(path); return n; }); }, []);

  const handleUploadFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit(myRoleRef.current)) { showPermDenied("Viewers cannot upload"); e.target.value = ""; return; }
    const f = e.target.files?.[0]; if (!f) return;
    const content = await f.text();
    setFiles(p => ({ ...p, [f.name]: content })); openTab(f.name);
    if (roomIdRef.current) { socket.emit("create-file", { roomId: roomIdRef.current, fileName: f.name }); socket.emit("code-change", { roomId: roomIdRef.current, fileName: f.name, code: content }); }
    e.target.value = "";
  }, [openTab, showPermDenied]);

  // ── VS Code-style "Open Folder" ──────────────────────────────────────────
  // Reads all files from a local folder the user picks, loads them into the
  // editor, syncs to the room, and shows "Close Folder" like VS Code.
  const handleOpenFolder = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!canEdit(myRoleRef.current)) { showPermDenied("Viewers cannot open folders"); e.target.value = ""; return; }
    const sel = e.target.files; if (!sel?.length) return;

    const nf: Record<string, string> = {};
    const fp = new Set<string>();
    let rootName = "";

    await Promise.all(Array.from(sel).map(async file => {
      const rp = (file as any).webkitRelativePath || file.name;
      // Skip binary-ish files, node_modules, .git
      if (
        rp.includes("/node_modules/") ||
        rp.includes("/.git/") ||
        rp.startsWith(".git/") ||
        rp.startsWith("node_modules/")
      ) return;
      try {
        nf[rp] = await file.text();
        const pts = rp.split("/");
        if (!rootName && pts.length > 1) rootName = pts[0];
        for (let i = 1; i < pts.length; i++) fp.add(pts.slice(0, i).join("/"));
      } catch { /* skip unreadable/binary files */ }
    }));

    if (!Object.keys(nf).length) return;

    // ── Close any existing workspace first ─────────────────────────────────
    setFiles({});
    setOpenTabs([]);
    setActiveFile("");
    setDirtyFiles(new Set());

    // ── Load new folder ────────────────────────────────────────────────────
    setFiles(nf);
    setOpenFolders(new Set([...fp, rootName].filter(Boolean)));
    setOpenFolderName(rootName || "Folder");

    // Open the first file automatically
    const firstFile = Object.keys(nf).sort((a, b) => {
      // Prefer root-level files, then by name
      const da = a.split("/").length, db = b.split("/").length;
      return da !== db ? da - db : a.localeCompare(b);
    })[0];
    if (firstFile) {
      setOpenTabs([firstFile]);
      setActiveFile(firstFile);
    }

    // ── Sync to room ───────────────────────────────────────────────────────
    if (roomIdRef.current) {
      for (const [fn, code] of Object.entries(nf)) {
        socket.emit("create-file", { roomId: roomIdRef.current, fileName: fn });
        socket.emit("code-change",  { roomId: roomIdRef.current, fileName: fn, code });
      }
      socket.emit("upload-folder", { roomId: roomIdRef.current, folderName: rootName, fileCount: Object.keys(nf).length });
    }

    e.target.value = "";
  }, [showPermDenied]);

  // ── Close Folder — clears workspace like VS Code ──────────────────────────
  const handleCloseFolder = useCallback(() => {
    setFiles({});
    setOpenTabs([]);
    setActiveFile("");
    setDirtyFiles(new Set());
    setOpenFolders(new Set());
    setOpenFolderName(null);
  }, []);

  const handleDownloadFile = useCallback((fn: string) => {
    const content = filesRef.current[fn]; if (content === undefined) return;
    const url = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
    const link = document.createElement("a"); link.href = url; link.download = fn.split("/").pop() || fn;
    document.body.appendChild(link); link.click(); document.body.removeChild(link); URL.revokeObjectURL(url);
  }, []);

  const handleDeleteFile = useCallback((fn: string) => {
    if (!canDelete(myRoleRef.current)) { showPermDenied("Only the owner can delete files"); return; }
    setFiles(p => { const u = { ...p }; delete u[fn]; return u; });
    setOpenTabs(p => { const nx = p.filter(t => t !== fn); if (activeFile === fn) setActiveFile(nx[0] ?? ""); return nx; });
    setDirtyFiles(p => { const n = new Set(p); n.delete(fn); return n; });
    if (roomIdRef.current) socket.emit("delete-file", { roomId: roomIdRef.current, fileName: fn });
  }, [activeFile, showPermDenied]);

  const handleDeleteFolder = useCallback((folderPath: string) => {
    if (!canDelete(myRoleRef.current)) { showPermDenied("Only the owner can delete folders"); return; }
    const prefix = folderPath.replace(/\/+$/, "") + "/";
    setFiles(p => {
      const u: typeof p = {};
      Object.entries(p).forEach(([k, v]) => { if (!k.startsWith(prefix) && k !== folderPath) u[k] = v; });
      return u;
    });
    setOpenTabs(p => {
      const nx = p.filter(t => !t.startsWith(prefix));
      if (activeFile.startsWith(prefix)) setActiveFile(nx[0] ?? "");
      return nx;
    });
    if (roomIdRef.current) socket.emit("delete-folder", { roomId: roomIdRef.current, folderPath });
  }, [activeFile, showPermDenied]);

  const handleRenameFolder = useCallback((oldPath: string, newName: string) => {
    if (!canEdit(myRoleRef.current)) { showPermDenied("Viewers cannot rename folders"); return; }
    const parentDir = oldPath.includes("/") ? oldPath.split("/").slice(0, -1).join("/") : "";
    const newPath   = parentDir ? `${parentDir}/${newName}` : newName;
    if (newPath === oldPath || !newName.trim()) return;
    const oldPrefix = oldPath + "/";
    const newPrefix = newPath + "/";
    setFiles(p => {
      const u: typeof p = {};
      Object.entries(p).forEach(([k, v]) => {
        u[k.startsWith(oldPrefix) ? newPrefix + k.slice(oldPrefix.length) : k] = v;
      });
      return u;
    });
    setOpenTabs(p => p.map(t => t.startsWith(oldPrefix) ? newPrefix + t.slice(oldPrefix.length) : t));
    setActiveFile(p => p.startsWith(oldPrefix) ? newPrefix + p.slice(oldPrefix.length) : p);
    if (roomIdRef.current) socket.emit("rename-folder", { roomId: roomIdRef.current, oldPath, newPath });
  }, [showPermDenied]);

  const handleMoveFile = useCallback((oldPath: string, targetFolder: string) => {
    if (!canEdit(myRoleRef.current)) { showPermDenied("Viewers cannot move files"); return; }
    const fileName = oldPath.split("/").pop() ?? oldPath;
    const newPath  = targetFolder ? `${targetFolder}/${fileName}` : fileName;
    if (newPath === oldPath) return;
    setFiles(p => {
      if (!(oldPath in p)) return p;
      const u: typeof p = {};
      Object.entries(p).forEach(([k, v]) => { u[k === oldPath ? newPath : k] = v; });
      return u;
    });
    setOpenTabs(p => p.map(t => t === oldPath ? newPath : t));
    setActiveFile(p => p === oldPath ? newPath : p);
    setDirtyFiles(p => {
      if (!p.has(oldPath)) return p;
      const n = new Set(p); n.delete(oldPath); n.add(newPath); return n;
    });
    if (roomIdRef.current) socket.emit("move-file", { roomId: roomIdRef.current, oldPath, newPath });
  }, [showPermDenied]);

  const startRename = useCallback((path: string) => {
    setRenamingPath(path); setRenameVal(path.split("/").pop() || path);
  }, []);

  const commitRename = useCallback(() => {
    if (!renamingPath || !renameVal.trim()) { setRenamingPath(null); return; }
    const parts    = renamingPath.split("/");
    parts[parts.length - 1] = renameVal.trim();
    const newPath  = parts.join("/");
    if (newPath === renamingPath) { setRenamingPath(null); return; }
    const isFolder = !Object.keys(filesRef.current).includes(renamingPath) ||
                     Object.keys(filesRef.current).some(k => k.startsWith(renamingPath + "/"));
    if (isFolder) {
      handleRenameFolder(renamingPath, renameVal.trim());
    } else {
      if (filesRef.current[newPath] !== undefined) { setRenamingPath(null); return; }
      setFiles(p => {
        const u: typeof p = {};
        Object.entries(p).forEach(([k, v]) => { u[k === renamingPath ? newPath : k] = v; });
        return u;
      });
      setOpenTabs(p => p.map(t => t === renamingPath ? newPath : t));
      if (activeFile === renamingPath) setActiveFile(newPath);
      if (roomIdRef.current) socket.emit("rename-file", { roomId: roomIdRef.current, oldFileName: renamingPath, newFileName: newPath });
    }
    setRenamingPath(null);
  }, [renamingPath, renameVal, activeFile, handleRenameFolder]);

  const handleChangeRole = useCallback((targetUid: string, newRole: Role) => {
    if (!roomIdRef.current || myRole !== "owner") return;
    socket.emit("change-role", { roomId: roomIdRef.current, targetUid, newRole });
  }, [myRole]);

  // ── Editor handlers ───────────────────────────────────────────────────────
  const handleEditorChange = useCallback((value: string | undefined) => {
    if (!canEdit(myRoleRef.current)) return;
    const code = value ?? "";
    setFiles(p => p[activeFile] === code ? p : { ...p, [activeFile]: code });
    setDirtyFiles(p => { const n = new Set(p); n.add(activeFile); return n; });
    const r = roomIdRef.current; const u = currentUserRef.current; if (!r || !u) return;
    socket.emit("code-change", { roomId: r, fileName: activeFile, code });
    const tu: RoomUser = { ...u, socketId: socket.id!, role: myRoleRef.current! };
    socket.emit("typing", { roomId: r, user: tu });
    if (typingTimeout.current) clearTimeout(typingTimeout.current);
    typingTimeout.current = window.setTimeout(() => socket.emit("stop-typing", { roomId: r, user: tu }), 1500);
  }, [activeFile]);

  const handleEditorMount = useCallback((editor: any, monaco: any) => {
    editorRef.current = editor; monacoRef.current = monaco;
    editor.onDidChangeCursorSelection((ev: any) => {
      const r = roomIdRef.current; const u = currentUserRef.current; if (!r || !u) return;
      const s = ev.selection;
      socket.emit("cursor-move", { roomId: r, user: { ...u, socketId: socket.id!, color: getUserColor(u.uid), role: myRoleRef.current! }, lineNumber: s.positionLineNumber, column: s.positionColumn, startLineNumber: s.startLineNumber, startColumn: s.startColumn, endLineNumber: s.endLineNumber, endColumn: s.endColumn });
      const sel = editor.getModel()?.getValueInRange(ev.selection);
      setSelectedCode(sel || "");
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      setDirtyFiles(p => { const n = new Set(p); n.delete(activeFile); return n; });
    });
  }, [activeFile]);

  const runCode = useCallback(() => {
    if (!canEdit(myRoleRef.current)) { showPermDenied("Viewers cannot run code"); return; }
    if (!roomIdRef.current || !activeFile) return;
    setIsPanelOpen(true); setPanelMode("terminal");
    setTimeout(() => {
      if (!terminalJoined.current && roomIdRef.current) { socket.emit("terminal-join", { roomId: roomIdRef.current, files: filesRef.current }); terminalJoined.current = true; }
      socket.emit("run-code", { roomId: roomIdRef.current, fileName: activeFile, files: filesRef.current });
    }, terminalJoined.current ? 0 : 300);
  }, [activeFile, showPermDenied]);

  const runProject = useCallback(() => {
    if (!canEdit(myRoleRef.current)) { showPermDenied("Viewers cannot run code"); return; }
    if (!roomIdRef.current) return;
    setIsPanelOpen(true); setPanelMode("terminal");
    setTimeout(() => {
      if (!terminalJoined.current && roomIdRef.current) { socket.emit("terminal-join", { roomId: roomIdRef.current, files: filesRef.current }); terminalJoined.current = true; }
      socket.emit("terminal-run-project", { roomId: roomIdRef.current, files: filesRef.current });
    }, terminalJoined.current ? 0 : 300);
  }, [showPermDenied]);

  const sendChatMessage = useCallback(() => {
    const text = chatInput.trim(); if (!text || !roomIdRef.current || !currentUserRef.current) return;
    socket.emit("send-chat-message", { roomId: roomIdRef.current, message: { id: `${Date.now()}-${Math.random()}`, userName: currentUserRef.current.name, text, timestamp: Date.now() } });
    setChatInput("");
  }, [chatInput]);

  const copyLink = useCallback(async () => {
    await navigator.clipboard.writeText(`${window.location.origin}/room/${roomId}`);
    setLinkCopied(true); setTimeout(() => setLinkCopied(false), 2000);
  }, [roomId]);

  const jumpToUser = useCallback((socketId: string) => {
    const cur = remoteCursors[socketId]; if (!editorRef.current || !cur) return;
    editorRef.current.revealPositionInCenter({ lineNumber: cur.lineNumber, column: cur.column });
    editorRef.current.setPosition({ lineNumber: cur.lineNumber, column: cur.column });
    editorRef.current.focus();
  }, [remoteCursors]);

  const applyFix = useCallback((fixedCode: string) => {
    if (!activeFile) return;
    setFiles(p => ({ ...p, [activeFile]: fixedCode }));
    editorRef.current?.setValue(fixedCode);
    setDirtyFiles(p => { const n = new Set(p); n.add(activeFile); return n; });
  }, [activeFile]);

  const cmdItems = useMemo((): CmdItem[] => [
    { id: "new-file",      label: "New File",              icon: "+",  keybind: "Ctrl+N",        action: () => setIsCreateOpen(true) },
    { id: "run-file",      label: "Run File",              icon: "▶",  keybind: "F5",            action: runCode },
    { id: "run-project",   label: "Run Project",           icon: "▶▶", keybind: "",              action: runProject },
    { id: "toggle-term",   label: "Toggle Terminal",       icon: ">_", keybind: "Ctrl+`",        action: () => { setIsPanelOpen(p => !p); setPanelMode("terminal"); } },
    { id: "toggle-ai",     label: "Toggle AI Copilot",     icon: "⬡",  keybind: "",              action: () => setShowAi(p => !p) },
    { id: "copy-link",     label: "Copy Share Link",       icon: "🔗", keybind: "",              action: copyLink },
    { id: "explorer",      label: "Show Explorer",         icon: "📁", keybind: "Ctrl+Shift+E",  action: () => { setActivityView("explorer"); setSidebarOpen(true); } },
    { id: "team",          label: "Show Team",             icon: "👥", keybind: "",              action: () => { setActivityView("team"); setSidebarOpen(true); } },
    { id: "activity-log",  label: "Show Activity Log",     icon: "⏱",  keybind: "",              action: () => setShowActivity(true) },
    ...Object.keys(files).map(fp => ({ id: `open-${fp}`, label: fp, description: "file", icon: getFileIcon(fp), action: () => openTab(fp) })),
  ], [files, runCode, runProject, copyLink, openTab]);

  const handleContextMenu = useCallback((e: React.MouseEvent, path: string, nodeType: "file" | "folder") => {
    e.preventDefault();
    setCtxMenu({ visible: true, x: e.clientX, y: e.clientY, path, nodeType });
  }, []);

  const leaveRoom = useCallback(() => {
    if (roomIdRef.current) socket.emit("leave-room", roomIdRef.current);
    termInstances.current.forEach(({ term }) => { try { term.dispose(); } catch { } });
    termInstances.current.clear(); termDivRefs.current.clear();
    xtermRef.current = null; terminalJoined.current = false;
    // Clear all cursor hide timers on leave
    cursorHideTimers.current.forEach(t => clearTimeout(t));
    cursorHideTimers.current.clear();
    setTermTabs([]); setActiveTermId(null); setView("landing"); setRoomMeta(null); setMyRole(null); setFollowUser(null); setOpenFolderName(null);
  }, []);

  if (view === "landing") return <LandingPage currentUser={currentUser} onEnterRoom={enterRoom} />;

  const renderSidebarContent = () => {
    if (activityView === "explorer") return (
      <div className="sb-explorer">
        {/* ── Section header — VS Code style ── */}
        <div className="sb-section-head">
          <span className="sb-section-title">
            {openFolderName
              ? openFolderName.toUpperCase()
              : roomMeta?.roomName?.toUpperCase() ?? "EXPLORER"}
          </span>
          {canEdit(myRole) && (
            <div className="sb-head-actions">

              {/* New File */}
              <button className="sb-head-btn" title="New File (Ctrl+N)" onClick={() => setIsCreateOpen(true)}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
                  <line x1="12" y1="13" x2="12" y2="19"/><line x1="9" y1="16" x2="15" y2="16"/>
                </svg>
              </button>

              {/* New Folder */}
              <button className="sb-head-btn" title="New Folder" onClick={() => {
                const name = window.prompt("Folder name:");
                if (!name?.trim()) return;
                const folderPath = name.trim() + "/.gitkeep";
                setFiles(p => ({ ...p, [folderPath]: "" }));
                setOpenFolders(p => new Set([...p, name.trim()]));
                if (roomIdRef.current) socket.emit("create-file", { roomId: roomIdRef.current, fileName: folderPath });
              }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  <line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/>
                </svg>
              </button>

              {/* Open Folder — VS Code style folder picker */}
              <button
                className="sb-head-btn"
                title="Open Folder"
                onClick={() => openFolderInputRef.current?.click()}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                  <polyline points="12 8 8 12 12 16"/><line x1="16" y1="12" x2="8" y2="12"/>
                </svg>
              </button>

              {/* Close Folder — only shown when a folder is open */}
              {openFolderName && (
                <button
                  className="sb-head-btn"
                  title="Close Folder"
                  style={{ color: "#f47067" }}
                  onClick={handleCloseFolder}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                    <line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/>
                  </svg>
                </button>
              )}

              {/* Collapse All */}
              <button className="sb-head-btn" title="Collapse All" onClick={() => setOpenFolders(new Set())}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6"/>
                </svg>
              </button>

            </div>
          )}
        </div>
        {Object.keys(visibleFiles).length > 0 && (
          <div className="sb-file-count">
            {Object.keys(visibleFiles).length} file{Object.keys(visibleFiles).length !== 1 ? "s" : ""}
          </div>
        )}
        <div className="sb-tree-scroll" style={{ overflowX: "auto", overflowY: "auto" }}>
          {Object.keys(visibleFiles).length === 0 ? (
            <div className="sb-empty-tree">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ marginBottom: 10, opacity: 0.5 }}>
                <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/>
              </svg>
              <span style={{ fontSize: 12.5, color: "#6a6a6a", textAlign: "center", lineHeight: 1.7 }}>
                No files yet.
                {canEdit(myRole) && (
                  <>
                    <br />
                    <button
                      onClick={() => openFolderInputRef.current?.click()}
                      style={{
                        marginTop: 10, background: "rgba(0,122,204,0.12)",
                        border: "1px solid rgba(0,122,204,0.35)", borderRadius: 4,
                        color: "#3794ff", fontSize: 12, padding: "5px 14px",
                        cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6,
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/>
                      </svg>
                      Open Folder
                    </button>
                    <br />
                    <span style={{ fontSize: 11, opacity: 0.5 }}>or click + to create a file</span>
                  </>
                )}
              </span>
            </div>
          ) : (
            fileTree.map(node => (
              <FileTreeItem key={node.path} node={node} depth={0}
                activeFile={activeFile} openFolders={openFolders} myRole={myRole}
                renamingPath={renamingPath} renameVal={renameVal}
                onFileClick={openTab} onToggleFolder={toggleFolder}
                onContextMenu={handleContextMenu}
                onRenameChange={setRenameVal} onRenameCommit={commitRename}
                onRenameCancel={() => setRenamingPath(null)}
                onMoveFile={handleMoveFile} />
            ))
          )}
        </div>
      </div>
    );

    if (activityView === "team") return (
      <div className="sb-team">
        <div className="sb-section-head" style={{ marginTop: 0 }}>
          <span className="sb-section-title">TEAM MEMBERS</span>
          <span className="sb-count-pill">{users.length}</span>
        </div>
        <div className="sb-members-list">
          {users.map(u => {
            const isMe       = u.socketId === socket.id;
            const isTyping   = !!typingUsers[u.socketId];
            const cursor     = remoteCursors[u.socketId];
            const isFollowed = followUser === u.socketId;
            return (
              <div key={u.socketId} className="sb-member-row" onClick={() => !isMe && jumpToUser(u.socketId)}>
                <div className="sb-avatar" style={{ background: getUserColor(u.uid) }}>
                  {u.name[0].toUpperCase()}
                  <span className="sb-avatar-pip" style={{ background: isTyping ? "#f59e0b" : "#4ec9b0" }} />
                </div>
                <div className="sb-member-info">
                  <div className="sb-member-name">{isMe ? `${u.name} (you)` : u.name}</div>
                  <div className="sb-member-sub">
                    {isTyping ? (
                      <span className="sb-typing-dots"><span /><span /><span /><em style={{ fontStyle: "normal", marginLeft: 4 }}>typing</em></span>
                    ) : cursor ? (
                      <span>Ln {cursor.lineNumber}{activeFile ? ` · ${activeFile.split("/").pop()}` : ""}</span>
                    ) : (
                      <span style={{ opacity: 0.5 }}>idle</span>
                    )}
                  </div>
                </div>
                <RoleBadge role={u.role} />
                {!isMe && (
                  <button
                    className={`sb-follow-btn${isFollowed ? " active" : ""}`}
                    onClick={e => { e.stopPropagation(); setFollowUser(p => p === u.socketId ? null : u.socketId); }}
                    title={isFollowed ? "Stop following" : "Follow cursor"}
                  >
                    {isFollowed ? (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M20 6L9 17l-5-5"/></svg>
                    ) : (
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><polyline points="12 8 16 12 12 16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                    )}
                  </button>
                )}
              </div>
            );
          })}
          {users.length === 0 && (
            <div className="sb-empty-tree">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#555" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5, marginBottom: 8 }}>
                <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
              </svg>
              <span style={{ fontSize: 12, color: "#6a6a6a" }}>No users in room</span>
            </div>
          )}
        </div>
        {otherUsers.length > 0 && (
          <>
            <div className="sb-section-head" style={{ marginTop: 8 }}>
              <span className="sb-section-title">LIVE CURSORS</span>
              <span className="sb-count-pill">{otherUsers.length}</span>
            </div>
            <div className="sb-cursors-list">
              {otherUsers.map(u => {
                const cur = remoteCursors[u.socketId];
                return (
                  <div key={u.socketId} className="sb-cursor-row" onClick={() => jumpToUser(u.socketId)}>
                    <span className="sb-cursor-dot" style={{ background: getUserColor(u.uid) }} />
                    <div className="sb-cursor-info">
                      <span className="sb-cursor-name">{u.name}</span>
                      {cur ? (
                        <span className="sb-cursor-pos">{activeFile.split("/").pop() ?? "—"} · Ln {cur.lineNumber}, Col {cur.column}</span>
                      ) : (
                        <span className="sb-cursor-pos" style={{ opacity: 0.4 }}>not moved yet</span>
                      )}
                    </div>
                    <button className="sb-jump-btn" title="Jump to cursor" onClick={e => { e.stopPropagation(); jumpToUser(u.socketId); }}>
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    );

    return null;
  };

  const breadcrumbs = activeFile ? activeFile.split("/") : [];

  return (
    <>
      {showCmdPalette && <CommandPalette items={cmdItems} onClose={() => setShowCmdPalette(false)} />}
      {permDenied && <div className="perm-toast">⚠ {permDenied}</div>}

      <div className="vsc-shell">
        {/* ── TITLE BAR ── */}
        <div className="vsc-titlebar">
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <button onClick={leaveRoom} style={{ background: "rgba(255,255,255,0.07)", border: "1px solid #555", borderRadius: 4, color: "#cccccc", padding: "2px 10px", cursor: "pointer", fontSize: 12, lineHeight: 1.4 }}>←</button>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <div style={{ width: 20, height: 20, borderRadius: 4, background: "#007acc", display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              </div>
              {currentUser && (
                <div style={{ display: "flex", alignItems: "center", gap: 6, background: "rgba(255,255,255,0.07)", border: "1px solid #555", borderRadius: 10, padding: "2px 10px 2px 6px" }}>
                  <div style={{ width: 18, height: 18, borderRadius: "50%", background: getUserColor(currentUser.uid), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#fff" }}>{currentUser.name[0].toUpperCase()}</div>
                  <span style={{ fontSize: 12, color: "#cccccc" }}>{currentUser.name}</span>
                </div>
              )}
            </div>
          </div>
          <div className="vsc-titlebar-center">{roomMeta?.roomName ?? "CodeCollab"}{roomId ? ` — #${roomId}` : ""}</div>
          <div className="vsc-titlebar-actions">
            {canEdit(myRole) && <>
              <button className="tb-run-btn run" onClick={runCode} title="Run file (F5)">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><path d="M2 1l7 4-7 4V1z"/></svg> Run
              </button>
              <button className="tb-run-btn project" onClick={runProject}>▶▶ Project</button>
              <button className="tb-run-btn term" onClick={() => { setIsPanelOpen(true); setPanelMode("terminal"); }}>$ Terminal</button>
            </>}
            <button className="tb-run-btn generic" onClick={() => { setPanelMode("output"); setIsPanelOpen(p => !p); }}>Output</button>
            <button className={`tb-run-btn generic${showAi ? " active" : ""}`} style={showAi ? { background: "rgba(0,122,204,0.15)", borderColor: "#007acc", color: "#3794ff" } : {}} onClick={() => setShowAi(p => !p)}>⬡ Copilot</button>
            <button className="tb-run-btn generic" onClick={() => setShowCmdPalette(true)} title="Command Palette (Ctrl+Shift+P)">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M14 2H2a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1V3a1 1 0 00-1-1zM2 13V5h12v8H2z"/><path d="M3.5 7h5v1h-5zm0 2h3v1h-3z"/></svg>
            </button>
            <div style={{ width: 1, height: 14, background: "#555", margin: "0 4px" }} />
            <button className="tb-run-btn generic" onClick={() => setShowChat(true)}>Chat</button>
            <button className="tb-run-btn generic" onClick={() => setShowActivity(true)}>Activity</button>
            {myRole === "owner" && <button className="tb-run-btn generic" onClick={() => setShowRolePanel(true)}>Roles</button>}
            <button className={`tb-run-btn generic${linkCopied ? " active" : ""}`} style={linkCopied ? { color: "#4ec9b0", borderColor: "rgba(78,201,176,0.4)" } : {}} onClick={copyLink}>{linkCopied ? "✓ Copied" : "Share"}</button>
            {currentUser && <button onClick={() => logoutUser().catch(console.error)} style={{ background: "none", border: "none", color: "#6a6a6a", cursor: "pointer", fontSize: 12, padding: "2px 6px" }}>Sign out</button>}
          </div>
        </div>

        {/* ── WORKBENCH ── */}
        <div className="vsc-workbench">
          {/* Activity Bar */}
          <div className="vsc-activity-bar">
            {([
              ["explorer", "📁", "Explorer (Ctrl+Shift+E)"],
              ["team",     "👥", "Team"],
            ] as [ActivityView, string, string][]).map(([id, icon, tip]) => (
              <button key={id} className={`activity-btn${activityView === id && sidebarOpen ? " active" : ""}`}
                onClick={() => { if (activityView === id) setSidebarOpen(p => !p); else { setActivityView(id); setSidebarOpen(true); } }}>
                <span style={{ fontSize: 18 }}>{icon}</span>
                <span className="tooltip">{tip}</span>
              </button>
            ))}
            <div className="activity-bottom">
              <button className={`activity-btn${showAi ? " active" : ""}`} onClick={() => setShowAi(p => !p)} title="Copilot">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
                <span className="tooltip">AI Copilot</span>
              </button>
              {myRole === "owner" && (
                <button className="activity-btn" onClick={() => setShowRolePanel(true)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
                  <span className="tooltip">Manage Roles</span>
                </button>
              )}
            </div>
          </div>

          {/* Sidebar */}
          {sidebarOpen && (
            <div className="vsc-sidebar" style={{ width: sidebarWidth }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                {renderSidebarContent()}
              </div>
              <div className="sidebar-resize-handle" onMouseDown={startSidebarDrag} />
            </div>
          )}

          {/* Editor + Panel */}
          <div style={{ display: "flex", flex: 1, minWidth: 0, flexDirection: "column", overflow: "hidden" }}>
            <div className="vsc-editor-area">
              {/* Tab bar */}
              <div className="vsc-tab-bar">
                {openTabs.map(tab => {
                  const isActive = activeFile === tab;
                  const isDirty = dirtyFiles.has(tab);
                  return (
                    <div key={tab} className={`vsc-tab${isActive ? " active" : ""}${isDirty ? " vsc-tab-dirty" : ""}`} onClick={() => setActiveFile(tab)} title={tab}>
                      <FileIconBadge name={tab.split("/").pop() || tab} size={10} />
                      <span className="vsc-tab-name">{tab.split("/").pop() || tab}</span>
                      {!isDirty && <button className="vsc-tab-close" onClick={e => closeTab(tab, e)}>×</button>}
                    </div>
                  );
                })}
              </div>

              {/* Breadcrumb */}
              {breadcrumbs.length > 0 && (
                <div className="vsc-breadcrumb">
                  {breadcrumbs.map((seg, i) => (
                    <span key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {i > 0 && <span className="vsc-breadcrumb-sep">›</span>}
                      <span className="vsc-breadcrumb-seg">{seg}</span>
                    </span>
                  ))}
                  {getEditorLang(activeFile) !== "plaintext" && (
                    <span style={{ marginLeft: "auto", fontSize: 11.5, color: "#6a6a6a" }}>{getLangName(activeFile)}</span>
                  )}
                </div>
              )}

              {/* Follow mode banner */}
              {followUser && (() => { const fu = users.find(u => u.socketId === followUser); return fu ? (
                <div className="follow-banner">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M13.8 12H3"/></svg>
                  Following {fu.name}
                  <button onClick={() => setFollowUser(null)}>Stop Following</button>
                </div>
              ) : null; })()}

              {/* Viewer bar */}
              {myRole === "viewer" && (
                <div className="vsc-viewer-bar">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  Viewer mode — read only. Ask the owner for edit access.
                </div>
              )}

              {/* Monaco editor */}
              <div style={{ flex: 1, overflow: "hidden", minHeight: 0 }}>
                {openTabs.length === 0 ? (
                  <div className="vsc-empty-state">
                    <div className="vsc-empty-logo">{"</>"}</div>
                    <div className="vsc-empty-title">CodeCollab IDE</div>
                    <div className="vsc-empty-shortcuts">
                      <div className="vsc-empty-row"><kbd>Ctrl+Shift+P</kbd> Command Palette</div>
                      <div className="vsc-empty-row"><kbd>Ctrl+N</kbd> New File</div>
                      <div className="vsc-empty-row"><kbd>F5</kbd> Run File</div>
                      <div className="vsc-empty-row"><kbd>Ctrl+`</kbd> Toggle Terminal</div>
                    </div>
                  </div>
                ) : (
                  <Editor
                    height="100%" width="100%"
                    language={getEditorLang(activeFile)}
                    value={currentCode}
                    onChange={handleEditorChange}
                    onMount={handleEditorMount}
                    theme="vs-dark"
                    options={{
                      automaticLayout: true,
                      minimap: { enabled: true, scale: 1 },
                      fontSize: 14, lineHeight: 22,
                      padding: { top: 12, bottom: 12 },
                      scrollBeyondLastLine: false,
                      wordWrap: "off",
                      renderLineHighlight: "all",
                      roundedSelection: true,
                      smoothScrolling: true,
                      cursorBlinking: "smooth",
                      cursorSmoothCaretAnimation: "on",
                      bracketPairColorization: { enabled: true },
                      readOnly: myRole === "viewer",
                      readOnlyMessage: { value: "You are a viewer — ask the owner for edit access" },
                      suggestOnTriggerCharacters: true,
                      quickSuggestions: true,
                    }}
                  />
                )}
              </div>
            </div>

            {/* ── PANEL ── */}
            {isPanelOpen && (
              <div className="vsc-panel" style={{ height: panelHeight }}>
                <div className="vsc-panel-resize" onMouseDown={startPanelDrag} />
                <div className="vsc-panel-tabs">
                  <button className={`vsc-panel-tab${panelMode === "output" ? " active" : ""}`} onClick={() => setPanelMode("output")}>Output</button>
                  <div style={{ width: 1, height: 20, background: "#3c3c3c", margin: "auto 4px" }} />
                  {termTabs.map(tab => {
                    const isAct = panelMode === "terminal" && activeTermId === tab.id;
                    return (
                      <div key={tab.id} style={{ display: "flex", alignItems: "stretch" }}>
                        <button className={`vsc-panel-tab${isAct ? " active" : ""}`}
                          style={{ paddingLeft: 10 }}
                          onClick={() => { setPanelMode("terminal"); setActiveTermId(tab.id); }}>
                          <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" style={{ opacity: 0.7 }}><path d="M6 9a.5.5 0 01.5-.5h4a.5.5 0 010 1H6.5A.5.5 0 016 9zM3.854 4.146a.5.5 0 100 .708L4.793 5.5 3.854 6.354a.5.5 0 10.708.708l1.5-1.5a.5.5 0 000-.708l-1.5-1.5a.5.5 0 00-.708 0z"/><path fillRule="evenodd" d="M0 4a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H2a2 2 0 01-2-2V4zm2-1a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1H2z"/></svg>
                          {tab.label}
                        </button>
                        <button className="vsc-panel-tab-close"
                          onClick={e => { e.stopPropagation(); const inst = termInstances.current.get(tab.id); if (inst) { try { inst.term.dispose(); } catch { } termInstances.current.delete(tab.id); } termDivRefs.current.delete(tab.id); setTermTabs(p => { const nx = p.filter(t => t.id !== tab.id); if (activeTermId === tab.id) { if (nx.length) setActiveTermId(nx[nx.length - 1].id); else { setActiveTermId(null); setPanelMode("output"); } } return nx; }); }}>×</button>
                      </div>
                    );
                  })}
                  {canEdit(myRole) && <button className="vsc-panel-tab-add" onClick={addTerminal} title="New Terminal">+</button>}
                  <div className="vsc-panel-actions">
                    {panelMode === "terminal" && canEdit(myRole) && <>
                      <button className="vsc-panel-action-btn green" onClick={() => socket.emit("terminal-sync-files", { roomId: roomIdRef.current, files: filesRef.current })} title="Sync files to workspace">
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.534 7h3.932a.25.25 0 01.192.41l-1.966 2.36a.25.25 0 01-.384 0l-1.966-2.36a.25.25 0 01.192-.41zm-11 2h3.932a.25.25 0 00.192-.41L2.692 6.23a.25.25 0 00-.384 0L.342 8.59A.25.25 0 00.534 9z"/><path d="M8 3c-1.552 0-2.94.707-3.857 1.818a.5.5 0 11-.771-.636A6.002 6.002 0 0113.917 7H12.9A5.002 5.002 0 008 3zM3.1 9a5.002 5.002 0 008.757 2.182.5.5 0 11.771.636A6.002 6.002 0 012.083 9H3.1z"/></svg>
                        Sync
                      </button>
                      <button className="vsc-panel-action-btn red" onClick={() => socket.emit("terminal-restart", { roomId: roomIdRef.current, files: filesRef.current })} title="Restart terminal">
                        <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.534 7h3.932a.25.25 0 01.192.41l-1.966 2.36a.25.25 0 01-.384 0l-1.966-2.36a.25.25 0 01.192-.41zm-11 2h3.932a.25.25 0 00.192-.41L2.692 6.23a.25.25 0 00-.384 0L.342 8.59A.25.25 0 00.534 9z"/></svg>
                        Restart
                      </button>
                    </>}
                    <button className="vsc-panel-action-btn close" onClick={() => setIsPanelOpen(false)} title="Close Panel">✕</button>
                  </div>
                </div>
                {panelMode === "output" && (
                  <div className="vsc-output-content">
                    {output.length === 0 ? <span className="vsc-output-empty">No output yet. Press Run to execute.</span> : output.map((l, i) => <div key={i} className="vsc-output-line">{l}</div>)}
                  </div>
                )}
                {panelMode === "terminal" && termTabs.map(tab => (
                  <div key={tab.id} ref={div => mountTerminal(tab.id, div as HTMLDivElement | null)}
                    style={{ flex: 1, overflow: "hidden", padding: "4px 0 0 6px", background: "#1e1e1e", display: activeTermId === tab.id ? "flex" : "none", flexDirection: "column" }} />
                ))}
                {panelMode === "terminal" && termTabs.length === 0 && (
                  <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, color: "#6a6a6a" }}>
                    <svg width="28" height="28" viewBox="0 0 16 16" fill="#6a6a6a"><path d="M6 9a.5.5 0 01.5-.5h4a.5.5 0 010 1H6.5A.5.5 0 016 9zM3.854 4.146a.5.5 0 100 .708L4.793 5.5 3.854 6.354a.5.5 0 10.708.708l1.5-1.5a.5.5 0 000-.708l-1.5-1.5a.5.5 0 00-.708 0z"/><path fillRule="evenodd" d="M0 4a2 2 0 012-2h12a2 2 0 012 2v8a2 2 0 01-2 2H2a2 2 0 01-2-2V4zm2-1a1 1 0 00-1 1v8a1 1 0 001 1h12a1 1 0 001-1V4a1 1 0 00-1-1H2z"/></svg>
                    <span style={{ fontSize: 13 }}>No terminal open</span>
                    {canEdit(myRole) && <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={addTerminal}>+ New Terminal</button>}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* AI Copilot Panel */}
          {showAi && (
            <AiPanel activeFile={activeFile} code={currentCode} selectedCode={selectedCode}
              terminalLogs={terminalLogs} onApplyFix={applyFix} onClose={() => setShowAi(false)} />
          )}
        </div>

        {/* ── STATUS BAR ── */}
        <div className="vsc-statusbar">
          <div className="vsc-status-item" title="Connection" style={{ background: isConnected ? "rgba(255,255,255,0.1)" : "rgba(244,71,71,0.3)" }}>
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zM10 3.25a1.75 1.75 0 113.5 0 1.75 1.75 0 01-3.5 0zM4.25 7a.75.75 0 100 1.5.75.75 0 000-1.5zM2.5 7.75a1.75 1.75 0 113.5 0 1.75 1.75 0 01-3.5 0zm5.75 3.5a.75.75 0 100 1.5.75.75 0 000-1.5zM6.5 12a1.75 1.75 0 113.5 0 1.75 1.75 0 01-3.5 0z"/><path d="M4.25 8.5v1A2.25 2.25 0 006.5 11.75h1"/></svg>
            {isConnected ? "● Live" : "○ Offline"}
          </div>
          {myRole && (
            <div className="vsc-status-item">
              <span style={{ textTransform: "uppercase", fontSize: 10.5, letterSpacing: "0.5px", color: ROLE_COLOR[myRole] }}>{myRole}</span>
            </div>
          )}
          <div className="vsc-status-sep" />
          <div className="vsc-status-item" title="Room ID"># {roomId ?? "…"}</div>
          <div className="vsc-status-item" title="Users online">
            <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M3 14s-1 0-1-1 1-4 6-4 6 3 6 4-1 1-1 1H3zm5-6a3 3 0 100-6 3 3 0 000 6z"/></svg>
            {users.length}
          </div>
          <div className="vsc-status-right">
            {activeFile && (
              <>
                <div className="vsc-status-item">{getLangName(activeFile)}</div>
                <div className="vsc-status-item">UTF-8</div>
              </>
            )}
            <div className="vsc-status-item" onClick={() => setShowCmdPalette(true)} title="Command Palette">
              <svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M14 2H2a1 1 0 00-1 1v10a1 1 0 001 1h12a1 1 0 001-1V3a1 1 0 00-1-1z"/></svg>
            </div>
          </div>
        </div>
      </div>

      {/* ── CONTEXT MENU ── */}
      {ctxMenu?.visible && (
        <div className="vsc-context-menu" style={{ top: ctxMenu.y, left: ctxMenu.x }} onClick={() => setCtxMenu(null)}>
          {ctxMenu.nodeType === "file" && <>
            {canEdit(myRole) && (
              <button className="ctx-item" onClick={() => startRename(ctxMenu.path)}>
                <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M13.23 1a2.77 2.77 0 00-1.96.81L3 10.06l-.43 2.27 2.27-.43 8.25-8.25A2.77 2.77 0 0013.23 1z"/></svg>
                Rename <span className="ctx-kb">F2</span>
              </button>
            )}
            {canEdit(myRole) && (
              <button className="ctx-item" onClick={() => {
                const code = filesRef.current[ctxMenu.path];
                if (code === undefined) return;
                const dot = ctxMenu.path.lastIndexOf(".");
                const base = dot === -1 ? ctxMenu.path : ctxMenu.path.slice(0, dot);
                const ext  = dot === -1 ? "" : ctxMenu.path.slice(dot);
                let i = 1; let dup = `${base}-copy${ext}`;
                while (filesRef.current[dup]) { i++; dup = `${base}-copy-${i}${ext}`; }
                setFiles(p => ({ ...p, [dup]: code })); openTab(dup);
                if (roomIdRef.current) {
                  socket.emit("create-file", { roomId: roomIdRef.current, fileName: dup });
                  socket.emit("code-change",  { roomId: roomIdRef.current, fileName: dup, code });
                }
              }}>
                <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M4 2a2 2 0 00-2 2v9a1 1 0 001 1h8a1 1 0 001-1v-1h1a1 1 0 001-1V6l-4-4H4zm8 8v1H5V3h5v3h2v4z"/></svg>
                Duplicate
              </button>
            )}
            <button className="ctx-item" onClick={() => handleDownloadFile(ctxMenu.path)}>
              <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M8 12l-4-4h2.5V4h3v4H12L8 12z"/><path d="M2 14h12v1.5H2z"/></svg>
              Download
            </button>
            {canDelete(myRole) && <>
              <div className="ctx-separator" />
              <button className="ctx-item danger" onClick={() => setFileToDelete(ctxMenu.path)}>
                <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z"/><path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1z"/></svg>
                Delete File
              </button>
            </>}
          </>}
          {ctxMenu.nodeType === "folder" && <>
            {canEdit(myRole) && (
              <button className="ctx-item" onClick={() => startRename(ctxMenu.path)}>
                <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M13.23 1a2.77 2.77 0 00-1.96.81L3 10.06l-.43 2.27 2.27-.43 8.25-8.25A2.77 2.77 0 0013.23 1z"/></svg>
                Rename Folder <span className="ctx-kb">F2</span>
              </button>
            )}
            {canEdit(myRole) && (
              <button className="ctx-item" onClick={() => {
                const fp = ctxMenu.path + "/untitled";
                setFiles(p => ({ ...p, [fp]: "" }));
                openTab(fp);
                setOpenFolders(p => new Set([...p, ctxMenu.path]));
                if (roomIdRef.current) socket.emit("create-file", { roomId: roomIdRef.current, fileName: fp });
              }}>
                <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v3H2a2 2 0 00-2 2v4a2 2 0 002 2h12a2 2 0 002-2V4a2 2 0 00-2-2zm0 11H2V9h12v4zm0-6H6V4h8v3z"/><path d="M8 10.5h1v1h-1zm2 0h1v1h-1z"/></svg>
                New File Inside
              </button>
            )}
            {canEdit(myRole) && (
              <button className="ctx-item" onClick={() => {
                const name = window.prompt("New folder name:");
                if (!name?.trim()) return;
                const newFolderPath = ctxMenu.path + "/" + name.trim();
                if (roomIdRef.current) socket.emit("create-folder", { roomId: roomIdRef.current, folderPath: newFolderPath });
                setOpenFolders(p => new Set([...p, ctxMenu.path, newFolderPath]));
              }}>
                <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M.54 3.87L.5 3a2 2 0 012-2h3.672a2 2 0 011.414.586l.828.828A2 2 0 009.828 3h3.982a2 2 0 011.992 2.181L15.546 8H1L.54 3.87z"/><path d="M1 9.5A1.5 1.5 0 012.5 8H14a.5.5 0 01.485.379L15 11v.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 011 12V9.5z"/></svg>
                New Sub-Folder
              </button>
            )}
            {canDelete(myRole) && <>
              <div className="ctx-separator" />
              <button className="ctx-item danger" onClick={() => {
                const count = Object.keys(filesRef.current).filter(k => k.startsWith(ctxMenu.path + "/")).length;
                if (count > 0 && !window.confirm(`Delete folder "${ctxMenu.path}" and all ${count} file(s) inside? This cannot be undone.`)) return;
                handleDeleteFolder(ctxMenu.path);
              }}>
                <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M5.5 5.5A.5.5 0 016 6v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm2.5 0a.5.5 0 01.5.5v6a.5.5 0 01-1 0V6a.5.5 0 01.5-.5zm3 .5a.5.5 0 00-1 0v6a.5.5 0 001 0V6z"/><path fillRule="evenodd" d="M14.5 3a1 1 0 01-1 1H13v9a2 2 0 01-2 2H5a2 2 0 01-2-2V4h-.5a1 1 0 01-1-1V2a1 1 0 011-1H6a1 1 0 011-1h2a1 1 0 011 1h3.5a1 1 0 011 1v1z"/></svg>
                Delete Folder
              </button>
            </>}
          </>}
          {canEdit(myRole) && <>
            <div className="ctx-separator" />
            <button className="ctx-item" onClick={() => setIsCreateOpen(true)}>
              <svg className="ctx-icon" viewBox="0 0 16 16" fill="currentColor"><path d="M14 2H6a2 2 0 00-2 2v4H2a2 2 0 00-2 2v4a2 2 0 002 2h12a2 2 0 002-2V4a2 2 0 00-2-2zm0 11H2V9h12v4zm0-6H6V4h8v3z"/><path d="M8 10.5h1v1h-1zm2 0h1v1h-1z"/></svg>
              New File…
            </button>
          </>}
        </div>
      )}

      {/* ── Create File Modal ── */}
      {isCreateOpen && (
        <CreateFileModal onClose={() => setIsCreateOpen(false)} onConfirm={name => {
          const trimmed = name.trim(); if (!trimmed || filesRef.current[trimmed]) return;
          setFiles(p => ({ ...p, [trimmed]: "" }));
          setOpenTabs(p => p.includes(trimmed) ? p : [...p, trimmed]);
          setActiveFile(trimmed);
          if (trimmed.includes("/")) { const pts = trimmed.split("/"); setOpenFolders(p => { const n = new Set(p); for (let i = 1; i < pts.length; i++) n.add(pts.slice(0, i).join("/")); return n; }); }
          setIsCreateOpen(false);
          if (roomIdRef.current) socket.emit("create-file", { roomId: roomIdRef.current, fileName: trimmed });
        }} />
      )}

      {/* ── Delete confirm ── */}
      {fileToDelete && (
        <div className="modal-overlay" onClick={() => setFileToDelete(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div className="modal-title">Delete File</div>
            <div className="modal-text">
              Delete <strong>{fileToDelete}</strong>?{" "}
              {dirtyFiles.has(fileToDelete) && <span style={{ color: "#f59e0b" }}>This file has unsaved changes. </span>}
              This cannot be undone.
            </div>
            <div className="modal-actions">
              <button className="btn btn-secondary" onClick={() => setFileToDelete(null)}>Cancel</button>
              <button className="btn btn-danger" onClick={() => { handleDeleteFile(fileToDelete); setFileToDelete(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Roles panel ── */}
      {showRolePanel && myRole === "owner" && (
        <div className="modal-overlay" onClick={() => setShowRolePanel(false)}>
          <div className="modal-card" style={{ minWidth: 360 }} onClick={e => e.stopPropagation()}>
            <div className="modal-title">Manage Roles</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
              {users.filter(u => u.socketId !== socket.id).map(u => (
                <div key={u.socketId} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 12px", background: "rgba(255,255,255,0.04)", borderRadius: 6, border: "1px solid #3c3c3c" }}>
                  <div style={{ width: 24, height: 24, borderRadius: "50%", background: getUserColor(u.uid), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: "#fff" }}>{u.name[0].toUpperCase()}</div>
                  <span style={{ fontSize: 13, color: "#cccccc", flex: 1 }}>{u.name}</span>
                  <RoleBadge role={u.role} />
                  <select value={u.role} onChange={e => handleChangeRole(u.uid, e.target.value as Role)}
                    style={{ background: "#3c3c3c", color: "#cccccc", border: "1px solid #555", borderRadius: 4, padding: "3px 8px", fontSize: 12, cursor: "pointer", outline: "none" }}>
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                </div>
              ))}
              {users.filter(u => u.socketId !== socket.id).length === 0 && <div style={{ textAlign: "center", color: "#6a6a6a", fontSize: 13, padding: 16 }}>No other users in room</div>}
            </div>
            <div className="modal-actions"><button className="btn btn-primary" onClick={() => setShowRolePanel(false)}>Done</button></div>
          </div>
        </div>
      )}

      {/* ── Activity slide-in ── */}
      {showActivity && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end" }} onClick={() => setShowActivity(false)}>
          <div style={{ width: 360, background: "#252526", borderLeft: "1px solid #1a1a1a", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div><div style={{ fontSize: 14, fontWeight: 600, color: "#cccccc" }}>Activity Log</div><div style={{ fontSize: 11.5, color: "#6a6a6a" }}>{activities.length} events</div></div>
              <button onClick={() => setShowActivity(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6a6a6a", fontSize: 18 }}>✕</button>
            </div>
            <div style={{ flex: 1, overflowY: "auto" }}>
              {activities.length === 0
                ? <div style={{ padding: 28, textAlign: "center", color: "#6a6a6a", fontSize: 13 }}>No activity yet</div>
                : activities.slice().reverse().map(a => (
                  <div key={a.id} style={{ display: "flex", gap: 10, padding: "8px 18px", borderBottom: "1px solid #2a2a2a" }}>
                    <div style={{ width: 24, height: 24, borderRadius: 5, background: `${getUserColor(a.uid || a.userName)}18`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: getUserColor(a.uid || a.userName), flexShrink: 0 }}>{a.action[0].toUpperCase()}</div>
                    <div>
                      <div style={{ fontSize: 13, color: "#cccccc", lineHeight: 1.5 }}>
                        <span style={{ color: getUserColor(a.uid || a.userName), fontWeight: 600 }}>{a.userName}</span>
                        {" "}{a.action}{a.target && <span style={{ color: "#6a6a6a" }}> · {a.target}</span>}
                      </div>
                      <div style={{ fontSize: 11, color: "#6a6a6a" }}>{fmtTime(a.timestamp)}</div>
                    </div>
                  </div>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Chat slide-in ── */}
      {showChat && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgba(0,0,0,0.5)", display: "flex", justifyContent: "flex-end" }} onClick={() => setShowChat(false)}>
          <div style={{ width: 360, background: "#252526", borderLeft: "1px solid #1a1a1a", display: "flex", flexDirection: "column" }} onClick={e => e.stopPropagation()}>
            <div style={{ padding: "14px 18px", borderBottom: "1px solid #1a1a1a", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div><div style={{ fontSize: 14, fontWeight: 600, color: "#cccccc" }}>Team Chat</div><div style={{ fontSize: 11.5, color: "#6a6a6a" }}>{chatMessages.length} messages</div></div>
              <button onClick={() => setShowChat(false)} style={{ background: "none", border: "none", cursor: "pointer", color: "#6a6a6a", fontSize: 18 }}>✕</button>
            </div>
            <div ref={chatBodyRef} style={{ flex: 1, overflowY: "auto", padding: "10px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
              {chatMessages.length === 0
                ? <div style={{ padding: 28, textAlign: "center", color: "#6a6a6a", fontSize: 13 }}>No messages yet</div>
                : chatMessages.map(m => (
                  <div key={m.id} style={{ background: m.userName === currentUser?.name ? "rgba(0,122,204,0.12)" : "rgba(255,255,255,0.05)", border: `1px solid ${m.userName === currentUser?.name ? "rgba(0,122,204,0.25)" : "#3c3c3c"}`, borderRadius: 6, padding: "8px 12px", alignSelf: m.userName === currentUser?.name ? "flex-end" : "flex-start", maxWidth: "88%" }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: "#3794ff", marginBottom: 4 }}>{m.userName}</div>
                    <div style={{ fontSize: 13, color: "#cccccc", lineHeight: 1.55 }}>{m.text}</div>
                    <div style={{ fontSize: 10.5, color: "#6a6a6a", textAlign: "right", marginTop: 4 }}>{new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
                  </div>
                ))}
            </div>
            <div style={{ padding: "10px 14px", borderTop: "1px solid #1a1a1a", display: "flex", gap: 8 }}>
              <input value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === "Enter" && sendChatMessage()}
                placeholder="Type a message…" autoFocus
                style={{ flex: 1, background: "#3c3c3c", border: "1px solid #555", borderRadius: 4, padding: "7px 12px", color: "#cccccc", fontSize: 13, outline: "none" }} />
              <button className="btn btn-primary" onClick={sendChatMessage}>Send</button>
            </div>
          </div>
        </div>
      )}

      <input ref={fileInputRef} type="file" style={{ display: "none" }} onChange={handleUploadFile} />
      <OpenFolderInput inputRef={openFolderInputRef} onOpen={handleOpenFolder} />
    </>
  );
}