/**
 * ai.service.ts — Groq AI integration
 *
 * Response contract (ALL endpoints):
 * {
 *   fixedCode:   string,   // corrected code (empty string for explain/chat)
 *   explanation: string,   // root-cause analysis or plain explanation
 *   errors:      string[], // list of identified bugs / issues
 *   confidence:  number    // 0-100
 * }
 *
 * Reliability features:
 *   - Retry with exponential back-off (up to MAX_RETRIES attempts)
 *   - Per-attempt AbortController timeout (TIMEOUT_MS)
 *   - Multi-stage JSON extraction (direct parse → fence-strip → regex harvest)
 *   - HTML / non-JSON response detection before parsing
 *   - Structured fallback — never throws a raw parse error to the caller
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export interface AiRequest {
  fileName:      string;
  code:          string;
  language:      string;
  userMessage?:  string;
  errorLogs?:    string;
  selectedCode?: string;
  mode?:         "fix" | "explain" | "chat";
}

/** Canonical response returned by every endpoint */
export interface AiResponse {
  fixedCode:   string;
  explanation: string;
  errors:      string[];
  confidence:  number;      // 0–100
  // legacy fields kept for frontend panel compatibility
  suggestions?: string[];
  message?:     string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

const GROQ_API_URL  = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL    = "llama-3.3-70b-versatile";
const TIMEOUT_MS    = 28_000;   // per-attempt timeout
const MAX_RETRIES   = 2;        // total attempts = MAX_RETRIES + 1
const RETRY_BASE_MS = 800;      // first retry delay; doubles each time

// ─── System prompt ────────────────────────────────────────────────────────────
// Forceful, concrete instructions — LLMs hallucinate less when told exactly
// what tokens are and are NOT allowed in the response.

const SYSTEM_PROMPT = `You are a senior software engineer specializing in debugging and code review.

STRICT OUTPUT RULES — violating any rule makes your response useless:
1. Respond with ONLY a single valid JSON object. No text before or after it.
2. Do NOT wrap the JSON in markdown code fences (\`\`\`).
3. Do NOT include any explanation outside the JSON.
4. Do NOT start the response with "Here is", "Sure", "I'll", or any prose.
5. The JSON must have exactly these four keys: fixedCode, explanation, errors, confidence.
6. confidence is an integer 0-100, NOT a string.
7. errors is an array of strings (can be empty array []).

Example of a VALID response (no text around it):
{"fixedCode":"public class Main {}","explanation":"The switch statement used Java 17+ pattern syntax which is not available in Java 11. Replaced with if-else chain.","errors":["Incompatible Java version for pattern matching in switch"],"confidence":95}`;

// ─── Groq HTTP caller (single attempt) ───────────────────────────────────────

interface GroqMsg { role: "system" | "user" | "assistant"; content: string }

async function callGroqOnce(messages: GroqMsg[], attemptNumber: number): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set in environment variables");

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(GROQ_API_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        messages,
        temperature: 0.1,   // very low temp → deterministic JSON output
        max_tokens:  4096,
        // NOTE: response_format:"json_object" is NOT supported by llama-3.3-70b-versatile
        // on Groq and causes a 400 HTML error. We enforce JSON via the system prompt instead.
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(tid);
    const isAbort = err instanceof Error && err.name === "AbortError";
    throw new Error(isAbort ? `Groq request timed out (attempt ${attemptNumber})` : `Groq fetch failed: ${String(err)}`);
  }
  clearTimeout(tid);

  // Read the body as raw text first so we can inspect it before parsing.
  // This prevents "Unexpected token '<'" — we detect HTML before JSON.parse runs.
  const rawBody = await res.text().catch(() => "");

  // Detect HTML error pages (Groq gateway, Cloudflare, nginx 502, etc.)
  const trimmedBody = rawBody.trimStart();
  if (trimmedBody.startsWith("<!") || trimmedBody.toLowerCase().startsWith("<html")) {
    throw new Error(
      `Groq returned an HTML error page (HTTP ${res.status}). ` +
      `This usually means response_format is unsupported, the model name is wrong, ` +
      `or the API key is invalid. Body: ${rawBody.slice(0, 300)}`
    );
  }

  // Now parse as JSON — safe because we know it is not HTML
  let data: { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  try {
    data = JSON.parse(rawBody);
  } catch {
    throw new Error(`Groq response was not valid JSON (HTTP ${res.status}): ${rawBody.slice(0, 300)}`);
  }

  if (!res.ok || data.error) {
    throw new Error(`Groq API ${res.status}: ${data.error?.message ?? rawBody.slice(0, 200)}`);
  }

  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) throw new Error("Groq returned an empty content field");
  return content;
}

// ─── Retry wrapper ────────────────────────────────────────────────────────────

async function callGroq(messages: GroqMsg[]): Promise<string> {
  let lastError: Error = new Error("No attempts made");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      // Exponential back-off: 800ms, 1600ms, …
      await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt - 1)));
      console.warn(`[ai.service] Retry attempt ${attempt}/${MAX_RETRIES}`);
    }
    try {
      return await callGroqOnce(messages, attempt + 1);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      const msg = lastError.message.toLowerCase();

      // Don't retry on definitive errors (auth, validation, model decommissioned)
      if (msg.includes("401") || msg.includes("400") || msg.includes("403") || msg.includes("api_key") || msg.includes("decommissioned")) {
        throw lastError;
      }
      console.error(`[ai.service] Attempt ${attempt + 1} failed: ${lastError.message}`);
    }
  }
  throw lastError;
}

// ─── JSON extraction pipeline ─────────────────────────────────────────────────
// Tries multiple strategies in order of reliability.
// Never throws — returns a well-formed fallback if all strategies fail.

/** Canonical shape we always expect from the model */
interface RawAiJson {
  fixedCode?:   unknown;
  explanation?: unknown;
  errors?:      unknown;
  confidence?:  unknown;
  // accept legacy field names the model might use
  fixed_code?:   unknown;
  fixed?:        unknown;
  suggestions?:  unknown;
  message?:      unknown;
}

function extractJson(raw: string): AiResponse {
  // ── Stage 1: Detect HTML response ────────────────────────────────────────
  if (raw.trimStart().startsWith("<!") || raw.trimStart().startsWith("<html")) {
    return fallback("Groq returned an HTML error page. Check your API key and endpoint.");
  }

  // ── Stage 2: Direct parse (happy path — model obeyed instructions) ────────
  const stage2 = tryParse(raw.trim());
  if (stage2) return normalise(stage2);

  // ── Stage 3: Strip markdown fences ─────────────────────────────────────────
  const stripped = raw
    .replace(/^```json\s*/im, "")
    .replace(/^```\s*/im, "")
    .replace(/```\s*$/im, "")
    .trim();
  const stage3 = tryParse(stripped);
  if (stage3) return normalise(stage3);

  // ── Stage 4: Extract first {...} block via regex ────────────────────────────
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) {
    const stage4 = tryParse(match[0]);
    if (stage4) return normalise(stage4);
  }

  // ── Stage 5: Model returned plain text — wrap it ───────────────────────────
  return fallback(raw.slice(0, 1200));
}

function tryParse(s: string): RawAiJson | null {
  try { return JSON.parse(s) as RawAiJson; } catch { return null; }
}

function normalise(raw: RawAiJson): AiResponse {
  // Accept several field-name variants the model might use
  const fixedCode   = str(raw.fixedCode ?? raw.fixed_code ?? raw.fixed ?? "");
  const explanation = str(raw.explanation ?? raw.message ?? "");
  const rawErrors   = raw.errors ?? raw.suggestions ?? [];
  const errors      = Array.isArray(rawErrors) ? rawErrors.map(e => str(e)).filter(Boolean) : [];
  const confidence  = clamp(raw.confidence);

  return { fixedCode, explanation, errors, confidence, suggestions: errors, message: explanation };
}

function fallback(explanation: string): AiResponse {
  return { fixedCode: "", explanation, errors: [], confidence: 0, suggestions: [], message: explanation };
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function clamp(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
}

// ─── Prompt builders ──────────────────────────────────────────────────────────
// Each prompt ends with an explicit JSON schema reminder so the model cannot
// "forget" the output format mid-response.

const JSON_SCHEMA_REMINDER = `
RESPOND WITH ONLY THIS JSON (no prose, no markdown, no code fences):
{"fixedCode":"<complete corrected code or empty string>","explanation":"<detailed explanation>","errors":["<issue 1>","<issue 2>"],"confidence":<integer 0-100>}`;

function buildFixPrompt(req: AiRequest): string {
  const target = req.selectedCode?.trim()
    ? `SELECTED CODE (fix only this block):\n\`\`\`${req.language}\n${req.selectedCode}\n\`\`\``
    : `FULL FILE — ${req.fileName}:\n\`\`\`${req.language}\n${req.code}\n\`\`\``;

  const errorSection = req.errorLogs?.trim()
    ? `\nTERMINAL / COMPILER OUTPUT (use this to identify the exact error):\n\`\`\`\n${req.errorLogs.slice(0, 2000)}\n\`\`\``
    : "\n(No terminal error output provided — infer bugs from code only)";

  // Language-specific guidance embedded in the prompt
  const langHints: Record<string, string> = {
    java:       "This is Java. Note: 'switch(x) { case int s when s >= 90 }' is Java 17+ pattern matching syntax. If the error suggests an older JDK, convert to if-else. Never use unsealed patterns unless the target is Java 17+.",
    javascript: "This is JavaScript. Check for undefined/null reference errors, async/await misuse, and scope issues.",
    typescript: "This is TypeScript. Check types, nullability, and any 'as unknown' casts that hide real type errors.",
    python:     "This is Python. Check indentation, f-string syntax, and module imports.",
  };
  const hint = langHints[req.language.toLowerCase()] ?? "";

  return `You are fixing a bug in ${req.language.toUpperCase()} code.
${hint ? `\nLANGUAGE NOTE: ${hint}\n` : ""}
USER INTENT: Fix all bugs and make the code run correctly.

${target}${errorSection}

INSTRUCTIONS:
- Identify every bug (syntax, logic, version-compatibility, runtime).
- Return the COMPLETE fixed file/block in fixedCode — do not truncate.
- In explanation, state each bug, its root cause, and what you changed.
- In errors, list each distinct bug as a short string.
- Set confidence to how certain you are the fix is correct (0-100).
${JSON_SCHEMA_REMINDER}`;
}

function buildExplainPrompt(req: AiRequest): string {
  const target = req.selectedCode?.trim()
    ? `CODE TO EXPLAIN:\n\`\`\`${req.language}\n${req.selectedCode}\n\`\`\``
    : `FILE — ${req.fileName}:\n\`\`\`${req.language}\n${req.code.slice(0, 3000)}\n\`\`\``;

  return `Explain this ${req.language.toUpperCase()} code clearly.

${target}

INSTRUCTIONS:
- In explanation: describe purpose, how it works, key patterns, potential pitfalls.
- In errors: list any code smells, anti-patterns, or bugs you notice (empty array if none).
- fixedCode: empty string (explanation mode — do not return code unless it contains a serious bug).
- confidence: 100 (you are explaining, not guessing).
${JSON_SCHEMA_REMINDER}`;
}

function buildChatPrompt(req: AiRequest): string {
  const code = req.code?.trim()
    ? `CURRENT FILE (${req.fileName}):\n\`\`\`${req.language}\n${req.code.slice(0, 2000)}\n\`\`\``
    : "";
  const sel = req.selectedCode?.trim()
    ? `\nSELECTED CODE:\n\`\`\`${req.language}\n${req.selectedCode}\n\`\`\``
    : "";
  const err = req.errorLogs?.trim()
    ? `\nTERMINAL LOGS:\n\`\`\`\n${req.errorLogs.slice(0, 1000)}\n\`\`\``
    : "";

  return `DEVELOPER QUESTION: "${req.userMessage}"

CONTEXT:
${code}${sel}${err}

INSTRUCTIONS:
- Answer the question directly in explanation.
- If code correction is needed, put it in fixedCode; otherwise use empty string.
- In errors, list any issues you noticed (empty array if none).
- confidence: your certainty about the answer (0-100).
${JSON_SCHEMA_REMINDER}`;
}

// ─── Public exports ───────────────────────────────────────────────────────────

export async function fixBug(req: AiRequest): Promise<AiResponse> {
  const raw = await callGroq([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildFixPrompt(req) },
  ]);
  return extractJson(raw);
}

export async function explainCode(req: AiRequest): Promise<AiResponse> {
  const raw = await callGroq([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildExplainPrompt(req) },
  ]);
  return extractJson(raw);
}

export async function chatAboutCode(req: AiRequest): Promise<AiResponse> {
  const raw = await callGroq([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user",   content: buildChatPrompt(req) },
  ]);
  return extractJson(raw);
}