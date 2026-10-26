
import type { Request, Response } from "express";
import {
  fixBug,
  explainCode,
  chatAboutCode,
  type AiRequest,
} from "../services/ai.service";

function buildReq(body: any): AiRequest {
  return {
    fileName: body.fileName || "untitled",
    code: body.code || "",
    language: body.language || "plaintext",
    userMessage: body.userMessage,
    errorLogs: body.errorLogs,
    selectedCode: body.selectedCode,
    mode: body.mode,
  };
}

export async function handleChat(req: Request, res: Response) {
  try {
    if (!req.body.userMessage) {
      return res.status(400).json({ error: "userMessage is required" });
    }

    const result = await chatAboutCode(buildReq(req.body));
    return res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI chat error:", message);
    return res.status(500).json({
      error: "AI request failed",
      detail: message,
    });
  }
}

export async function handleFix(req: Request, res: Response) {
  try {
    if (!req.body.code) {
      return res.status(400).json({ error: "code is required" });
    }

    const result = await fixBug(buildReq(req.body));
    return res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI fix error:", message);
    return res.status(500).json({
      error: "AI request failed",
      detail: message,
    });
  }
}

export async function handleExplain(req: Request, res: Response) {
  try {
    if (!req.body.code) {
      return res.status(400).json({ error: "code is required" });
    }

    const result = await explainCode(buildReq(req.body));
    return res.json(result);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("AI explain error:", message);
    return res.status(500).json({
      error: "AI request failed",
      detail: message,
    });
  }
}
