import { parseGradeNumber } from "./grade";
import type { StudentRecord } from "./types";

export const FORENSIC_PROMPT = `You are a literal forensic transcription engine. Extract the handwritten student fields from ONE photographed answer sheet. The image has a dark printed header bar, the sheet photo is below it. The sheet may be dim, angled, shadowed, sideways or upside-down - rotate it mentally and read it.

CRITICAL RULES:
1. NEVER guess, autocomplete or spell-correct any character. Never "fix" email domains or school names.
2. For every field report status:
   - READABLE = you can see every character clearly,
   - BLURRED = the field has writing but at least one character is uncertain, smudged, cut off or overwritten,
   - NO_DATA = the field is blank or empty.
3. When status is READABLE, put the exact handwritten text in value. Otherwise put the same word as the status in value.
4. quality: CLEAR (everything readable), BLURRED, BLANK (no sheet), CUT_OFF (sheet partially outside the photo).
5. Never invent. A BLURRED status is always acceptable; a wrong value is a failure.

Return JSON only in this shape:
{"students":[{"slot":1,"quality":"CLEAR","name":{"status":"READABLE","value":"..."},"email":{"status":"BLURRED","value":"BLURRED"},"grade":{"status":"NO_DATA","value":"NO_DATA"},"school_name":{"status":"READABLE","value":"..."}}]}`;

const FIELD_SCHEMA = {
  type: "OBJECT",
  properties: {
    status: {
      type: "STRING",
      enum: ["READABLE", "BLURRED", "NO_DATA"],
    },
    value: { type: "STRING" },
  },
  required: ["status", "value"],
};

export const SHEET_SCHEMA = {
  type: "OBJECT",
  properties: {
    students: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          slot: { type: "INTEGER" },
          quality: {
            type: "STRING",
            enum: ["CLEAR", "BLURRED", "BLANK", "CUT_OFF"],
          },
          name: FIELD_SCHEMA,
          email: FIELD_SCHEMA,
          grade: FIELD_SCHEMA,
          school_name: FIELD_SCHEMA,
        },
        required: ["slot", "quality", "name", "email", "grade", "school_name"],
      },
    },
  },
  required: ["students"],
};

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

type FieldValue = { status?: string; value?: string };
type RawSheetRow = {
  slot?: number;
  quality?: string;
  name?: FieldValue;
  email?: FieldValue;
  grade?: FieldValue;
  school_name?: FieldValue;
};
type RawSheet = { students?: RawSheetRow[] };

const STATUS_WORDS = new Set(["BLURRED", "NO_DATA", "N/A", "NA", "NULL", "NONE"]);

function readField(field?: FieldValue): { status: string; value: string | null } {
  const status = String(field?.status || "NO_DATA").toUpperCase();
  const raw = String(field?.value ?? "").trim();
  const readable =
    status === "READABLE" && raw.length > 0 && !STATUS_WORDS.has(raw.toUpperCase());
  if (readable) return { status: "READABLE", value: raw };
  if (status === "READABLE") return { status: "NO_DATA", value: null };
  return { status, value: null };
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function mergeField(
  a: { status: string; value: string | null },
  b: { status: string; value: string | null }
): { status: string; value: string | null } {
  if (a.status === "READABLE" && b.status === "READABLE" && a.value && b.value) {
    if (norm(a.value) === norm(b.value)) {
      return { status: "READABLE", value: a.value };
    }
    return { status: "AMBIGUOUS", value: null };
  }
  if (a.status === "READABLE" || b.status === "READABLE") {
    // Only one independent read saw a value: not confirmed, keep it out.
    return { status: "UNCONFIRMED", value: null };
  }
  if (a.status === "BLURRED" || b.status === "BLURRED") {
    return { status: "BLURRED", value: null };
  }
  return { status: "NO_DATA", value: null };
}

function mergeQuality(a?: string, b?: string) {
  const qa = String(a || "").toUpperCase();
  const qb = String(b || "").toUpperCase();
  if (qa === "BLANK" || qb === "BLANK") return "BLANK";
  if (qa === "CUT_OFF" || qb === "CUT_OFF") return "CUT_OFF";
  if (qa === "CLEAR" && qb === "CLEAR") return "CLEAR";
  return "BLURRED";
}

const PLACEHOLDER_EMAIL =
  /@(example\.(com|org|net)|test\.com|email\.com|domain\.com|sample\.com)$/i;

function mergeSheets(
  rawA: RawSheet,
  rawB: RawSheet,
  startPage: number,
  pagesInGroup: number
): StudentRecord[] {
  const rowsA = new Map<number, RawSheetRow>();
  const rowsB = new Map<number, RawSheetRow>();
  for (const row of rawA.students || []) {
    if (row.slot) rowsA.set(row.slot, row);
  }
  for (const row of rawB.students || []) {
    if (row.slot) rowsB.set(row.slot, row);
  }

  const records: StudentRecord[] = [];
  for (let slot = 1; slot <= pagesInGroup; slot += 1) {
    const rowA = rowsA.get(slot);
    const rowB = rowsB.get(slot);
    const quality = mergeQuality(rowA?.quality, rowB?.quality);

    const name = mergeField(readField(rowA?.name), readField(rowB?.name));
    let email = mergeField(readField(rowA?.email), readField(rowB?.email));
    if (
      email.value &&
      PLACEHOLDER_EMAIL.test(email.value.toLowerCase())
    ) {
      email = { status: "BLURRED", value: null };
    }
    const grade = mergeField(readField(rowA?.grade), readField(rowB?.grade));
    const school = mergeField(
      readField(rowA?.school_name),
      readField(rowB?.school_name)
    );

    records.push({
      slot,
      sourcePage: startPage + slot - 1,
      nameStatus: name.status,
      quality,
      name: name.value,
      email: email.value ? email.value.toLowerCase() : null,
      grade: grade.value,
      gradeNumber: parseGradeNumber(grade.value, null),
      schoolName: school.value,
    });
  }
  return records;
}

function parseJsonPayload(text: string) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : trimmed) as RawSheet;
}

export function aiProvider() {
  const value = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (value === "deepseek") return "deepseek" as const;
  return "gemini" as const;
}

export function aiModel() {
  if (aiProvider() === "deepseek") {
    return process.env.DEEPSEEK_MODEL || "deepseek-flash";
  }
  return process.env.GEMINI_MODEL || "gemini-3.8-flash";
}

function addUsage(a: ExtractUsage, b: ExtractUsage): ExtractUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  };
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function geminiRequest(
  jpeg: Buffer
): Promise<{ text: string; usage: ExtractUsage }> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is missing. Add it to .env.local");
  }
  const model = aiModel();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: FORENSIC_PROMPT },
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: jpeg.toString("base64"),
              },
            },
          ],
        },
      ],
      generationConfig: {
        temperature: 0,
        responseMimeType: "application/json",
        responseSchema: SHEET_SCHEMA,
        // Gemini 3.x defaults to thinking mode (~26s/read); low thinking is
        // ~7s/read and measured MORE accurate on these answer sheets.
        thinkingConfig: { thinkingLevel: "low" },
      },
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
  jpeg: Buffer
): Promise<{ text: string; usage: ExtractUsage }> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(5000 * attempt);
    try {
      return await geminiRequest(jpeg);
    } catch (error) {
      lastError = error;
      const status = (error as { status?: number }).status;
      if (status === 429 || status === 503) continue;
      break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function deepseekRequest(
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
        { role: "system", content: FORENSIC_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Transcribe the answer sheet in this image as json.",
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

async function readSheetOnce(
  jpeg: Buffer
): Promise<{ sheet: RawSheet; usage: ExtractUsage }> {
  const provider = aiProvider();
  let text: string;
  let usage: ExtractUsage;
  if (provider === "deepseek") {
    const result = await deepseekRequest(jpeg);
    text = result.text;
    usage = result.usage;
  } else {
    const result = await geminiCall(jpeg);
    text = result.text;
    usage = result.usage;
  }
  try {
    const sheet = parseJsonPayload(text);
    if (!Array.isArray(sheet.students)) {
      throw new Error("missing students array");
    }
    return { sheet, usage };
  } catch {
    throw new ExtractionError("AI returned malformed JSON", usage);
  }
}

export async function extractStudentsFromComposite(
  jpeg: Buffer,
  startPage: number,
  pagesInGroup: number
): Promise<{ students: StudentRecord[]; raw: unknown; usage: ExtractUsage }> {
  // Two INDEPENDENT reads of the same sheet, in parallel. A value is only
  // accepted when both reads agree; any disagreement or single-read value is
  // dropped (0-hallucination policy).
  const [resA, resB] = await Promise.allSettled([
    readSheetOnce(jpeg),
    readSheetOnce(jpeg),
  ]);

  if (resA.status === "rejected") {
    throw resA.reason;
  }
  const readA = resA.value;

  if (resB.status === "rejected") {
    // Second read failed: nothing can be confirmed, so every field stays
    // unconfirmed (page goes to the cannot-extract records).
    const error = resB.reason;
    const usageB =
      error instanceof ExtractionError && error.usage ? error.usage : null;
    return {
      students: mergeSheets(readA.sheet, { students: [] }, startPage, pagesInGroup),
      raw: { a: readA.sheet, b: null },
      usage: usageB ? addUsage(readA.usage, usageB) : readA.usage,
    };
  }

  return {
    students: mergeSheets(readA.sheet, resB.value.sheet, startPage, pagesInGroup),
    raw: { a: readA.sheet, b: resB.value.sheet },
    usage: addUsage(readA.usage, resB.value.usage),
  };
}
