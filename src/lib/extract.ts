import { parseGradeNumber } from "./grade";
import type { GeminiStudent, StudentRecord } from "./types";

export const EXTRACT_PROMPT = `You transcribe ONE photographed handwritten QUEST 2026 answer sheet. You are a strict transcription engine, not an assistant. You NEVER guess and you NEVER invent.

The image has a dark printed header bar "Slot 1 · PDF page N", the sheet photo is below it.
The photo may be dim, angled or shadowed, but handwritten fields are usually readable.

Decide page_visible FIRST:
- false only when the sheet is blank, black, blurred beyond reading, torn, missing or upside-down so no handwriting is readable.
- true when any handwriting on the sheet is readable.

If page_visible is false, return {"students":[{"slot":1,"page_visible":false}]} and no field values. NEVER invent data for an unreadable page.

If visible, transcribe ONLY the characters you can actually see:
- name: Participant Name as handwritten
- email: Email Address exactly, character by character (do not infer or complete domains)
- grade: Grade/Class exactly as written
- grade_number: the plain class number 1-12, or null
- school_name: School name as handwritten (ignore the pre-printed header, read the written answer)

HARD RULES:
- If ANY character of a field is uncertain, smudged, cut off or blank, set that field to null.
- Never fix spellings, never complete a word, never add "gmail.com" or any domain that is not clearly written.
- Never use example.com or any placeholder data. A null is always acceptable; a guess is a failure.

Return JSON only in this shape:
{"students":[{"slot":1,"page_visible":true,"name":null,"email":null,"grade":null,"grade_number":null,"school_name":null}]}`;

export const AUDIT_PROMPT = `You are a transcription auditor for ONE photographed handwritten answer sheet, not an assistant.

The image has a dark printed header bar "Slot 1 · PDF page N", the sheet photo is below it.
Below is a candidate transcription produced by another reader. Your ONLY job is to remove wrong or invented values, not to re-read everything:
- For each non-null value: look for it on the sheet. If you find the same value (spelling, spacing or punctuation may differ slightly), KEEP it unchanged.
- Set a field to null ONLY when the value is not on the sheet at all, or it clearly looks invented or wrong.
- Never fill in, complete, correct or improve any value. Nulls stay null.
- Keep page_visible=true when any handwriting is readable; set page_visible=false only when the sheet is unreadable (blank/black/blurred/upside-down).
Return the final JSON in the same shape:
{"students":[{"slot":1,"page_visible":true,"name":null,"email":null,"grade":null,"grade_number":null,"school_name":null}]}

Candidate transcription to audit:
`;

export type ExtractUsage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export class ExtractionError extends Error {
  usage?: ExtractUsage;
  constructor(message: string, usage?: ExtractUsage) {
    super(message);
    this.name = "ExtractionError";
    this.usage = usage;
  }
}

function emptyToNull(value: string | null | undefined) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

const PLACEHOLDER_EMAIL =
  /@(example\.(com|org|net)|test\.com|email\.com|domain\.com|sample\.com)$/i;

function sanitizeEmail(value: string | null): string | null {
  if (!value) return null;
  return PLACEHOLDER_EMAIL.test(value) ? null : value;
}

function parseStudents(
  parsed: { students?: GeminiStudent[] },
  startPage: number,
  pagesInGroup: number
): StudentRecord[] {
  return (parsed.students || [])
    .filter((row) => row.slot >= 1 && row.slot <= pagesInGroup)
    .map((row) => {
      const grade = emptyToNull(row.grade);
      return {
        slot: row.slot,
        sourcePage: startPage + row.slot - 1,
        pageVisible: row.page_visible !== false,
        name: emptyToNull(row.name),
        email: sanitizeEmail(emptyToNull(row.email)?.toLowerCase() ?? null),
        grade,
        gradeNumber: parseGradeNumber(grade, row.grade_number ?? null),
        schoolName: emptyToNull(row.school_name),
      };
    });
}

function parseJsonPayload(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed) as {
    students?: GeminiStudent[];
  };
}

export function aiProvider() {
  const value = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (value === "deepseek") return "deepseek" as const;
  return "gemini" as const;
}

function addUsage(a: ExtractUsage, b: ExtractUsage): ExtractUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

export function aiModel() {
  if (aiProvider() === "deepseek") {
    return process.env.DEEPSEEK_MODEL || "deepseek-flash";
  }
  return process.env.GEMINI_MODEL || "gemini-3.8-flash";
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function geminiRequest(
  prompt: string,
  jpeg: Buffer
): Promise<{ text: string; usage: ExtractUsage }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is missing. Add it to .env.local");
  }
  const model = aiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  // Deliberately NO responseSchema: Gemini 3.8-flash silently omits fields
  // (even readable names) when a schema is attached. Plain JSON mode + the
  // strict prompt is far more accurate for this task.
  const generationConfig = {
    temperature: 0,
    responseMimeType: "application/json",
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: jpeg.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    const error = new Error(
      `Gemini HTTP ${response.status}: ${bodyText.slice(0, 300)}`
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }

  const payload = JSON.parse(bodyText) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      cachedContentTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };
  const text = (payload.candidates?.[0]?.content?.parts ?? [])
    .map((part) => part.text ?? "")
    .join("");
  if (!text) {
    throw new Error("Gemini returned empty content");
  }
  const meta = payload.usageMetadata;
  const usage: ExtractUsage = {
    promptTokens: meta?.promptTokenCount ?? 0,
    cachedTokens: meta?.cachedContentTokenCount ?? 0,
    completionTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens: meta?.totalTokenCount ?? 0,
  };
  return { text, usage };
}

async function geminiCall(
  prompt: string,
  jpeg: Buffer
): Promise<{ text: string; usage: ExtractUsage }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(5000 * attempt);
    try {
      return await geminiRequest(prompt, jpeg);
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status === 429 || status === 503) continue;
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function extractWithGemini(jpeg: Buffer) {
  const pass1 = await geminiCall(EXTRACT_PROMPT, jpeg);
  let auditText: string;
  let auditUsage: ExtractUsage;
  try {
    const audit = await geminiCall(
      `${AUDIT_PROMPT}${pass1.text}`,
      jpeg
    );
    auditText = audit.text;
    auditUsage = audit.usage;
  } catch (error) {
    // If the audit fails, fall back to the raw pass but keep the failure
    // visible so nothing is silently trusted.
    console.error("[extract] audit pass failed:", error);
    return pass1;
  }
  return { text: auditText, usage: addUsage(pass1.usage, auditUsage) };
}

async function deepseekCall(
  prompt: string,
  jpeg: Buffer
): Promise<{ text: string; usage: ExtractUsage }> {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error("DEEPSEEK_API_KEY is missing. Add it to .env.local");
  }

  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: aiModel(),
      temperature: 0,
      max_tokens: 8192,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: prompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe the answer sheets in this image as json.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
                detail: "original",
              },
            },
          ],
        },
      ],
    }),
  });

  const payload = (await response.json()) as {
    error?: { message?: string };
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      prompt_cache_hit_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
    };
  };
  if (!response.ok) {
    throw new Error(
      payload.error?.message || `DeepSeek HTTP ${response.status}`
    );
  }
  const text = payload.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("AI returned empty content");
  }

  const raw = payload.usage || {};
  const usage: ExtractUsage = {
    promptTokens: Number(raw.prompt_tokens || 0),
    cachedTokens: Number(
      raw.prompt_cache_hit_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? 0
    ),
    completionTokens: Number(raw.completion_tokens || 0),
    totalTokens: Number(raw.total_tokens || 0),
  };
  return { text, usage };
}

async function extractWithDeepSeek(jpeg: Buffer) {
  const pass1 = await deepseekCall(EXTRACT_PROMPT, jpeg);
  try {
    const audit = await deepseekCall(`${AUDIT_PROMPT}${pass1.text}`, jpeg);
    return { text: audit.text, usage: addUsage(pass1.usage, audit.usage) };
  } catch (error) {
    console.error("[extract] audit pass failed:", error);
    return pass1;
  }
}

export async function extractStudentsFromComposite(
  jpeg: Buffer,
  startPage: number,
  pagesInGroup: number
): Promise<{ students: StudentRecord[]; raw: unknown; usage: ExtractUsage }> {
  const provider = aiProvider();
  const { text, usage } =
    provider === "deepseek"
      ? await extractWithDeepSeek(jpeg)
      : await extractWithGemini(jpeg);

  let parsed: { students?: GeminiStudent[] };
  try {
    parsed = parseJsonPayload(text);
  } catch {
    throw new ExtractionError("AI returned malformed JSON", usage);
  }
  if (!Array.isArray(parsed.students)) {
    throw new ExtractionError("AI response missing students array", usage);
  }

  return {
    students: parseStudents(parsed, startPage, pagesInGroup),
    raw: parsed,
    usage,
  };
}
