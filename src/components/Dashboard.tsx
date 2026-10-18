"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Student = {
  id: number;
  batch_id: number;
  source_page: number;
  slot: number;
  name: string | null;
  email: string | null;
  grade: string | null;
  school_name: string | null;
};

type Batch = {
  id: number;
  filename: string;
  file_size_bytes: number;
  total_pages: number;
  page_count: number;
  composite_count: number;
  composites_done: number;
  student_count: number;
  status: string;
  error_message?: string | null;
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Queued — split pages",
  extracting_pages: "Splitting PDF into pages",
  pages_ready: "Queued — pack 6-up",
  composing: "Packing 6 pages per image",
  composites_ready: "Queued — Gemini",
  parsing: "Gemini extracting",
  done: "Done",
  error: "Error",
};

export default function Dashboard() {
  const [file, setFile] = useState<File | null>(null);
  const [maxPdfMb, setMaxPdfMb] = useState(50);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);

  const load = useCallback(async () => {
    const [batchRes, studentRes, configRes] = await Promise.all([
      fetch("/api/batches"),
      fetch("/api/students"),
      fetch("/api/config"),
    ]);
    const batchJson = await batchRes.json();
    const studentJson = await studentRes.json();
    const configJson = await configRes.json();
    setBatches(batchJson.batches || []);
    setStudents(studentJson.students || []);
    if (configJson.maxPdfMb) setMaxPdfMb(configJson.maxPdfMb);
    if (batchJson.error) setError(batchJson.error);
    else if (studentJson.error) setError(studentJson.error);
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 4000);
    return () => clearInterval(timer);
  }, [load]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;
    if (file.size > maxPdfMb * 1024 * 1024) {
      setError(`PDF must be ${maxPdfMb} MB or smaller`);
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const body = new FormData();
      body.set("file", file);
      const res = await fetch("/api/upload", { method: "POST", body });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Upload failed");
      setNotice(json.message);
      setFile(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const csv = useMemo(() => {
    const header = "id,batch_id,source_page,name,email,grade,school_name";
    const rows = students.map((s) =>
      [s.id, s.batch_id, s.source_page, s.name, s.email, s.grade, s.school_name]
        .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
        .join(",")
    );
    return [header, ...rows].join("\n");
  }, [students]);

  function downloadCsv() {
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "quest-students.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const active = batches.find(
    (b) => b.status !== "done" && b.status !== "error"
  );

  return (
    <main className="mx-auto max-w-6xl px-5 py-10">
      <header className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-amber-800">
            QUEST 2026 · Season 04
          </p>
          <h1
            className="mt-1 text-4xl text-[#142033]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Sheet recovery
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
            Upload a scanned PDF (max {maxPdfMb} MB). After that you can leave
            it — cron jobs run on their own and fill the database.
          </p>
        </div>
        <button
          type="button"
          onClick={downloadCsv}
          className="self-start rounded-full border border-slate-300 bg-white px-4 py-2 text-sm"
        >
          Download CSV
        </button>
      </header>

      <form
        onSubmit={onSubmit}
        className="rounded-3xl border border-white/80 bg-white/80 p-6 shadow-sm backdrop-blur"
      >
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <label className="block text-sm">
            PDF of answer sheets
            <input
              type="file"
              accept="application/pdf"
              className="mt-2 block w-full rounded-2xl border border-slate-200 bg-white p-3"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </label>
          <button
            type="submit"
            disabled={!file || busy}
            className="rounded-2xl bg-[#142033] px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload to server"}
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Maximum size {maxPdfMb} MB.
        </p>
        {notice && <p className="mt-3 text-sm text-emerald-700">{notice}</p>}
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </form>

      {active && (
        <section className="mt-6 rounded-2xl bg-[#142033] p-5 text-white">
          <p className="text-sm text-amber-200">
            Batch #{active.id} · {active.filename}
          </p>
          <p className="mt-1 text-lg">
            {STATUS_LABEL[active.status] || active.status}
          </p>
          <p className="mt-2 text-sm text-slate-300">
            Pages {active.page_count}/{active.total_pages || "—"} · 6-up{" "}
            {active.composites_done}/{active.composite_count || "—"} · students{" "}
            {active.student_count}
          </p>
        </section>
      )}

      <section className="mt-8 grid gap-3 sm:grid-cols-3">
        <Stat label="Students in DB" value={students.length} />
        <Stat label="Uploads" value={batches.length} />
        <Stat
          label="Latest status"
          value={
            batches[0]
              ? STATUS_LABEL[String(batches[0].status)] ||
                String(batches[0].status)
              : "none"
          }
        />
      </section>

      <section className="mt-8 overflow-hidden rounded-3xl border border-white bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-medium">
          Server queue
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Pages</th>
                <th className="px-4 py-3">6-up</th>
                <th className="px-4 py-3">Students</th>
              </tr>
            </thead>
            <tbody>
              {batches.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-slate-400" colSpan={5}>
                    No PDFs on the server yet.
                  </td>
                </tr>
              )}
              {batches.map((b) => (
                <tr key={b.id} className="border-t border-slate-100">
                  <td className="px-4 py-3">{b.filename}</td>
                  <td className="px-4 py-3">
                    {STATUS_LABEL[b.status] || b.status}
                    {b.error_message ? (
                      <span className="mt-1 block text-xs text-red-600">
                        {b.error_message}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {b.page_count}/{b.total_pages || "—"}
                  </td>
                  <td className="px-4 py-3 text-slate-500">
                    {b.composites_done}/{b.composite_count || "—"}
                  </td>
                  <td className="px-4 py-3">{b.student_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-8 overflow-hidden rounded-3xl border border-white bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-medium">
          Extracted students
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3">Page</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Grade</th>
                <th className="px-4 py-3">School</th>
              </tr>
            </thead>
            <tbody>
              {students.length === 0 && (
                <tr>
                  <td className="px-4 py-8 text-slate-400" colSpan={5}>
                    Nothing in the database yet. Upload a PDF and the cron job
                    will start soon.
                  </td>
                </tr>
              )}
              {students.map((s) => (
                <tr key={s.id} className="border-t border-slate-100">
                  <td className="px-4 py-3 text-slate-500">{s.source_page}</td>
                  <td className="px-4 py-3">{s.name || "—"}</td>
                  <td className="px-4 py-3">{s.email || "—"}</td>
                  <td className="px-4 py-3">{s.grade || "—"}</td>
                  <td className="px-4 py-3">{s.school_name || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl bg-white p-4 shadow-sm">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-2xl" style={{ fontFamily: "var(--font-serif)" }}>
        {value}
      </p>
    </div>
  );
}
