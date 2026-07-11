/**
 * ai.routes.ts
 *
 * POST /api/ai/bug-fix   — fix bugs, return { fixedCode, explanation, errors, confidence }
 * POST /api/ai/explain   — explain code, fixedCode will be empty string
 * POST /api/ai/chat      — general Q&A with code context
 *
 * Every route:
 *   1. Validates input strictly (no unknown types reach the service)
 *   2. Passes to service function
 *   3. Always returns the canonical AiResponse shape
 *   4. Logs errors server-side without leaking stack traces to clients
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { fixBug, explainCode, chatAboutCode, type AiRequest, type AiResponse } from "../services/ai.service";

const router = Router();

// ─── Input validation ─────────────────────────────────────────────────────────

class ValidationError extends Error {
  constructor(msg: string) { super(msg); this.name = "ValidationError"; }
}

/** Sanitise and validate the common fields every endpoint requires */
function validateBase(body: Record<string, unknown>): AiRequest {
  const code     = typeof body.code     === "string" ? body.code.trim()     : "";
  const language = typeof body.language === "string" ? body.language.trim() : "";
  const fileName = typeof body.fileName === "string" && body.fileName.trim()
    ? body.fileName.trim() : "untitled";

  if (!code)
    throw new ValidationError("'code' is required");
  if (code.length > 60_000)
    throw new ValidationError("'code' exceeds 60,000 character limit");
  if (!language)
    throw new ValidationError("'language' is required");
  if (language.length > 40)
    throw new ValidationError("'language' value is unreasonably long");

  return {
    code,
    language:     language.toLowerCase(),
    fileName,
    userMessage:  safe(body.userMessage,  2_000),
    errorLogs:    safe(body.errorLogs,    4_000),
    selectedCode: safe(body.selectedCode, 20_000),
  };
}

function safe(v: unknown, maxLen: number): string | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v.trim().slice(0, maxLen);
}

/** Always return the canonical AiResponse shape — never let a parse/network
 *  error bubble up as an unstructured 500. The frontend can always render this. */
function safeResponse(res: Response, fn: () => Promise<AiResponse>): void {
  fn()
    .then(result => res.json(result))
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[AI route error]", message);

      // Distinguish recoverable service errors from fatal config errors
      const isConfig = message.includes("GROQ_API_KEY") || message.includes("401") || message.includes("403");
      const status   = isConfig ? 503 : 500;

      // Still return the canonical shape so the frontend doesn't crash
      const fallback: AiResponse = {
        fixedCode:   "",
        explanation: isConfig
          ? "AI service is not configured. Check that GROQ_API_KEY is set in your .env file."
          : `AI request failed: ${message}`,
        errors:      [message],
        confidence:  0,
        suggestions: [],
        message:     message,
      };
      res.status(status).json(fallback);
    });
}

// ─── POST /api/ai/bug-fix ─────────────────────────────────────────────────────
// Finds bugs, returns corrected code + explanation.
// Mode: "fix" — fixedCode will always be populated if bugs were found.

router.post(
  "/bug-fix",
  (req: Request, res: Response, next: NextFunction): void => {
    let aiReq: AiRequest;
    try {
      aiReq = validateBase(req.body as Record<string, unknown>);
      aiReq.mode = "fix";
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ fixedCode: "", explanation: err.message, errors: [err.message], confidence: 0 });
      } else {
        next(err);
      }
      return;
    }
    safeResponse(res, () => fixBug(aiReq));
  }
);

// ─── POST /api/ai/explain ─────────────────────────────────────────────────────
// Explains what the code does. fixedCode will be empty string unless the
// model also spots a serious bug.

router.post(
  "/explain",
  (req: Request, res: Response, next: NextFunction): void => {
    let aiReq: AiRequest;
    try {
      aiReq = validateBase(req.body as Record<string, unknown>);
      aiReq.mode = "explain";
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ fixedCode: "", explanation: err.message, errors: [err.message], confidence: 0 });
      } else {
        next(err);
      }
      return;
    }
    safeResponse(res, () => explainCode(aiReq));
  }
);

// ─── POST /api/ai/chat ────────────────────────────────────────────────────────
// General coding Q&A. Requires userMessage in addition to code + language.

router.post(
  "/chat",
  (req: Request, res: Response, next: NextFunction): void => {
    const body = req.body as Record<string, unknown>;

    // Chat-specific validation
    if (typeof body.userMessage !== "string" || !body.userMessage.trim()) {
      res.status(400).json({
        fixedCode:   "",
        explanation: "'userMessage' is required for the chat endpoint",
        errors:      ["Missing userMessage"],
        confidence:  0,
      });
      return;
    }

    let aiReq: AiRequest;
    try {
      aiReq = validateBase(body);
      aiReq.mode = "chat";
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ fixedCode: "", explanation: err.message, errors: [err.message], confidence: 0 });
      } else {
        next(err);
      }
      return;
    }
    safeResponse(res, () => chatAboutCode(aiReq));
  }
);

export default router;