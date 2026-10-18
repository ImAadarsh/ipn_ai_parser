const ROMAN: Record<string, number> = {
  I: 1,
  II: 2,
  III: 3,
  IV: 4,
  V: 5,
  VI: 6,
  VII: 7,
  VIII: 8,
  IX: 9,
  X: 10,
  XI: 11,
  XII: 12,
};

export const GRADE_LABELS: Record<number, string> = {
  1: "Class 1",
  2: "Class 2",
  3: "Class 3",
  4: "Class 4",
  5: "Class 5",
  6: "Class 6",
  7: "Class 7",
  8: "Class 8",
  9: "Class 9",
  10: "Class 10",
  11: "Class 11",
  12: "Class 12",
};

/**
 * Normalise any grade label (e.g. "VII-A", "8th-G1", "Class 7", "7-B")
 * into a plain class number between 1 and 12. Prefers the value the AI
 * returned when it is valid, otherwise parses the text.
 */
export function parseGradeNumber(
  grade: string | null | undefined,
  preferred?: number | null
): number | null {
  if (preferred && preferred >= 1 && preferred <= 12) return preferred;
  if (!grade) return null;

  const text = String(grade).toUpperCase();

  let match = text.match(/^\s*(?:GRADE|CLASS|STD\.?|STANDARD)?\s*(\d{1,2})/);
  if (match) {
    const n = Number(match[1]);
    if (n >= 1 && n <= 12) return n;
  }

  match = text.match(
    /^\s*(?:GRADE|CLASS|STD\.?|STANDARD)?\s*(XII|XI|X|IX|VIII|VII|VI|IV|V|III|II|I)\b/
  );
  if (match) return ROMAN[match[1]] ?? null;

  match = text.match(/\b(\d{1,2})(?:TH|ST|ND|RD)\b/);
  if (match) {
    const n = Number(match[1]);
    if (n >= 1 && n <= 12) return n;
  }

  match = text.match(/\b(XII|XI|X|IX|VIII|VII|VI|IV|V|III|II|I)\b/);
  if (match) return ROMAN[match[1]] ?? null;

  match = text.match(/\b(\d{1,2})\b/);
  if (match) {
    const n = Number(match[1]);
    if (n >= 1 && n <= 12) return n;
  }

  return null;
}

export function gradeLabel(number: number | null | undefined) {
  if (!number) return "—";
  return GRADE_LABELS[number] || `Class ${number}`;
}
