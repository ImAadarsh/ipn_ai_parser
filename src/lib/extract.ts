import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { parseGradeNumber } from "./grade";
import type { GeminiStudent, StudentRecord } from "./types";

export const EXTRACT_PROMPT = `You read a collage of QUEST 2026 Junior Category (Classes 6-8) handwritten answer sheets.
The collage is a 2-column by 3-row grid (up to 6 forms). Slots are numbered left-to-right, top-to-bottom:
1 2
3 4
5 6
Each cell has a dark header "Slot N · PDF page P".

For every visible filled form extract:
- name: Participant Name
- email: Email Address (fix obvious spacing, keep the address if readable)
- grade: Grade/Class exactly as written (example: 8th-G1, VIII-A)
- grade_number: the class as a plain number 1-12 (example: "8th-G1" -> 8, "VII-A" -> 7)
- school_name: Participant School Name

Use null when a field is blank or unreadable. Skip empty slots.
Return JSON only in this shape:
{"students":[{"slot":1,"name":"","email":"","grade":"","grade_number":8,"school_name":""}]}`;

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
        name: emptyToNull(row.name),
        email: emptyToNull(row.email)?.toLowerCase() ?? null,
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

async function extractWithGemini(jpeg: Buffer) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    throw new Error("GEMINI_API_KEY is missing. Add it to .env.local");
  }
  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          students: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                slot: { type: SchemaType.INTEGER },
                name: { type: SchemaType.STRING, nullable: true },
                email: { type: SchemaType.STRING, nullable: true },
                grade: { type: SchemaType.STRING, nullable: true },
                grade_number: { type: SchemaType.INTEGER, nullable: true },
                school_name: { type: SchemaType.STRING, nullable: true },
              },
              required: ["slot"],
            },
          },
        },
        required: ["students"],
      },
    },
  });

  const result = await model.generateContent([
    { text: EXTRACT_PROMPT },
    {
      inlineData: {
        mimeType: "image/jpeg",
        data: jpeg.toString("base64"),
      },
    },
  ]);

  const meta = result.response.usageMetadata;
  const usage: ExtractUsage = {
    promptTokens: meta?.promptTokenCount ?? 0,
    cachedTokens: meta?.cachedContentTokenCount ?? 0,
    completionTokens: meta?.candidatesTokenCount ?? 0,
    totalTokens: meta?.totalTokenCount ?? 0,
  };
  return { text: result.response.text(), usage };
}

async function extractWithDeepSeek(jpeg: Buffer) {
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
      model: process.env.DEEPSEEK_MODEL || "deepseek-flash",
      temperature: 0.1,
      max_tokens: 8192,
      thinking: { type: "disabled" },
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: EXTRACT_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract students from this 6-up JPEG as json.",
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
