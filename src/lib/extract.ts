import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
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
- grade: Grade/Class (example: 8th-G1, VIII-A)
- school_name: Participant School Name

Use null when a field is blank or unreadable. Skip empty slots.
Return JSON only in this shape:
{"students":[{"slot":1,"name":"","email":"","grade":"","school_name":""}]}`;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    .map((row) => ({
      slot: row.slot,
      sourcePage: startPage + row.slot - 1,
      name: emptyToNull(row.name),
      email: emptyToNull(row.email)?.toLowerCase() ?? null,
      grade: emptyToNull(row.grade),
      schoolName: emptyToNull(row.school_name),
    }));
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
  return parseJsonPayload(result.response.text());
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
      max_tokens: 4096,
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
  };
  if (!response.ok) {
    throw new Error(payload.error?.message || `DeepSeek HTTP ${response.status}`);
  }
  const text = payload.choices?.[0]?.message?.content;
  if (!text) {
    throw new Error("DeepSeek returned empty content");
  }
  return parseJsonPayload(text);
}

export async function extractStudentsFromComposite(
  jpeg: Buffer,
  startPage: number,
  pagesInGroup: number
): Promise<{ students: StudentRecord[]; raw: unknown }> {
  let lastError: unknown;
  const provider = aiProvider();

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const parsed =
        provider === "deepseek"
          ? await extractWithDeepSeek(jpeg)
          : await extractWithGemini(jpeg);
      return {
        students: parseStudents(parsed, startPage, pagesInGroup),
        raw: parsed,
      };
    } catch (error) {
      lastError = error;
      await sleep(Math.min(30000, 1500 * 2 ** (attempt - 1)));
    }
  }

  throw lastError;
}
