import { parseGradeNumber } from "./grade";
import type { GeminiStudent, StudentRecord } from "./types";

export const EXTRACT_PROMPT = `You transcribe handwritten QUEST 2026 answer sheets. You are a strict transcription engine, not an assistant. You NEVER guess and you NEVER invent.

The image is a 2-column by 3-row collage of photographed answer sheets (up to 6 forms).
Slots run left-to-right, top-to-bottom: 1 2 / 3 4 / 5 6. Each cell has a dark printed header "Slot N · PDF page P".
The photos may be dim, angled or shadowed, but they are usually readable.

For each slot decide page_visible FIRST:
- false only when the page is blank, black, blurred beyond reading, torn, missing or upside-down so no handwriting is readable.
- true when any handwriting on the page is readable.

If page_visible is false, return {"slot":N,"page_visible":false} and no field values. NEVER invent data for an unreadable page.

If visible, transcribe ONLY the characters you can actually see:
- name: Participant Name as handwritten
- email: Email Address exactly, character by character (do not infer or complete domains)
- grade: Grade/Class exactly as written
- grade_number: the plain class number 1-12, or null
- school_name: School name as handwritten

HARD RULES:
- If ANY character of a field is uncertain, smudged, cut off or blank, set that field to null.
- Never fix spellings, never complete a word, never add "gmail.com" or any domain that is not clearly written.
- Never use example.com or any placeholder data. A null is always acceptable; a guess is a failure.

Return JSON only in this shape:
{"students":[{"slot":1,"page_visible":true,"name":null,"email":null,"grade":null,"grade_number":null,"school_name":null}]}`;

export const AUDIT_PROMPT = `You are a transcription auditor for handwritten answer sheet photos, not an assistant.

The image is a 2-column by 3-row collage of answer sheets. Cells are labeled "Slot N · PDF page P" (slots 1-6, left-to-right, top-to-bottom).
Below is a candidate transcription. For EVERY slot and EVERY non-null field:
- locate the value in the image and confirm it character by character,
- if you cannot confirm it exactly, set that field to null,
- if a value is already null, keep it null.
Additionally set page_visible=false if that page is unreadable (blank/black/blurred/upside-down).
Never fill in, complete, correct or improve a value. Never add domains or placeholder data.
Return the audited JSON in the same shape:
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

const STUDENTS_SCHEMA = {
  type: "OBJECT",
  properties: {
    students: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          slot: { type: "INTEGER" },
          page_visible: { type: "BOOLEAN", nullable: true },
          name: { type: "STRING", nullable: true },
          email: { type: "STRING", nullable: true },
          grade: { type: "STRING", nullable: true },
          grade_number: { type: "INTEGER", nullable: true },
          school_name: { type: "STRING", nullable: true },
        },
        required: ["slot"],
      },
    },
  },
  required: ["students"],
};

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
  jpeg: Buffer,
  withSchema: boolean
): Promise<{ text: string; usage: ExtractUsage }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is missing. Add it to .env.local");
  }
  const model = aiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
  const generationConfig: Record<string, unknown> = {
    temperature: 0,
    responseMimeType: "application/json",
  };
  if (withSchema) {
    generationConfig.responseSchema = STUDENTS_SCHEMA;
  }

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
      return await geminiRequest(prompt, jpeg, true);
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status === 429 || status === 503) continue;
      if (status === 400) {
        // Some deployments reject responseSchema; retry plain JSON mode.
        try {
          return await geminiRequest(prompt, jpeg, false);
        } catch (retryError) {
          lastError = retryError;
        }
      }
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
