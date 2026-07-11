import type { Request, Response } from "express";
import { fixCode, explainCode, chat, type AiRequest } from "../services/ai.service";

function buildReq(body: any): AiRequest {
  return {
    roomId:       body.roomId       || "",
    fileName:     body.fileName     || "untitled",
    code:         body.code         || "",
    language:     body.language     || "plaintext",
    userMessage:  body.userMessage,
    errorLogs:    body.errorLogs,
    selectedCode: body.selectedCode,
    projectFiles: body.projectFiles,
  };
}

export async function handleChat(req: Request, res: Response) {
  try {
    if (!req.body.userMessage) return res.status(400).json({ error: "userMessage is required" });
    const result = await chat(buildReq(req.body));
    res.json(result);
  } catch (err: any) {
    console.error("AI chat error:", err.message);
    res.status(500).json({ error: "AI request failed", detail: err.message });
  }
}

export async function handleFix(req: Request, res: Response) {
  try {
    if (!req.body.code) return res.status(400).json({ error: "code is required" });
    const result = await fixCode(buildReq(req.body));
    res.json(result);
  } catch (err: any) {
    console.error("AI fix error:", err.message);
    res.status(500).json({ error: "AI request failed", detail: err.message });
  }
}

export async function handleExplain(req: Request, res: Response) {
  try {
    if (!req.body.code) return res.status(400).json({ error: "code is required" });
    const result = await explainCode(buildReq(req.body));
    res.json(result);
  } catch (err: any) {
    console.error("AI explain error:", err.message);
    res.status(500).json({ error: "AI request failed", detail: err.message });
  }
}