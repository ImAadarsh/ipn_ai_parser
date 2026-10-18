export type BatchStatus =
  | "uploaded"
  | "extracting_pages"
  | "pages_ready"
  | "composing"
  | "composites_ready"
  | "parsing"
  | "done"
  | "error";

export type CompositeStatus = "pending" | "processing" | "done" | "error";

export type StudentRecord = {
  slot: number;
  sourcePage: number;
  name: string | null;
  email: string | null;
  grade: string | null;
  schoolName: string | null;
};

export type GeminiStudent = {
  slot: number;
  name: string | null;
  email: string | null;
  grade: string | null;
  school_name: string | null;
};

export type BatchRow = {
  id: number;
  filename: string;
  stored_path: string;
  file_size_bytes: number;
  total_pages: number;
  pages_per_composite: number;
  status: BatchStatus;
  error_message: string | null;
};

export type PageRow = {
  id: number;
  batch_id: number;
  page_number: number;
  file_path: string;
};

export type CompositeRow = {
  id: number;
  batch_id: number;
  start_page: number;
  end_page: number;
  file_path: string;
  status: CompositeStatus;
};
