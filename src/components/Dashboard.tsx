"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type User = { id: number; username: string; role: string };

type Student = {
  id: number;
  batch_id: number;
  source_page: number;
  slot: number;
  name: string | null;
  email: string | null;
  grade: string | null;
  grade_number: number | null;
  school_name: string | null;
  issues: string | null;
  is_duplicate: number;
  valid_email: number;
};

type Batch = {
  id: number;
  filename: string;
  total_pages: number;
  pages_per_composite: number;
  page_count: number;
  composite_count: number;
  composites_done: number;
  composites_review: number;
  composites_processing: number;
  student_count: number;
  status: string;
  error_message?: string | null;
};

type ReviewItem = {
  id: number;
  batch_id: number;
  start_page: number;
  end_page: number;
  error_message: string | null;
  filename: string;
};

type Breakdown = { label: string; total: number; grade_number?: number };

type Usage = {
  paused: boolean;
  hasWork: boolean;
  worker: { running: boolean; step: number; lastError: string | null };

  retentionDays: number;
  lastCleanupAt: string | null;
  pipelines: {
    pagesDone: number;
    pagesTotal: number;
    imagesDone: number;
    imagesProcessed: number;
    imagesOk: number;
    imagesReview: number;
    students: number;
    batches: number;
  };
  students: {
    total: number;
    named: number;
    withEmail: number;
    validEmails: number;
    duplicates: number;
    invalidEmails: number;
    withGrade: number;
    withSchool: number;
    schools: number;
    grades: number;
  };
  schools: Breakdown[];
  grades: Breakdown[];
};

type AdminUser = {
  id: number;
  username: string;
  role: string;
  active: number;
};

const STATUS_LABEL: Record<string, string> = {
  uploaded: "Queued — split pages",
  extracting_pages: "P1 · splitting into pages",
  pages_ready: "Queued — images processing",
  composing: "P2 · images Processing",
  composites_ready: "Queued — AI extraction",
  parsing: "P3 · AI extracting",
  needs_review: "Needs review",
  done: "Done",
  error: "Error",
};

const TABS = ["process", "students", "review", "results", "users"] as const;
type Tab = (typeof TABS)[number];

function pct(done: number, total: number) {
  if (!total) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

function expectedImages(batch: Batch) {
  if (!batch.total_pages) return 0;
  const per = batch.pages_per_composite || 6;
  return Math.ceil(batch.total_pages / per);
}

export default function Dashboard({ user }: { user: User }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("process");
  const [files, setFiles] = useState<File[]>([]);
  const [maxPdfMb, setMaxPdfMb] = useState(200);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [review, setReview] = useState<ReviewItem[]>([]);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [filterBatch, setFilterBatch] = useState("");
  const [query, setQuery] = useState("");
  const [flag, setFlag] = useState("");
  const [grade, setGrade] = useState("");
  const [showAllBatches, setShowAllBatches] = useState(false);
  const [zoom, setZoom] = useState<ReviewItem | null>(null);

  const authRedirect = useCallback(
    (status: number) => {
      if (status === 401) router.replace("/login");
    },
    [router]
  );

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (filterBatch) params.set("batchId", filterBatch);
    if (query) params.set("q", query);
    if (flag) params.set("flag", flag);
    if (grade) params.set("grade", grade);

    const requests: Promise<Response>[] = [
      fetch("/api/batches"),
      fetch(`/api/students?${params.toString()}`),
      fetch("/api/config"),
      fetch("/api/usage"),
      fetch("/api/review"),
    ];
    if (user.role === "admin") requests.push(fetch("/api/users"));

    const [batchRes, studentRes, configRes, usageRes, reviewRes, usersRes] =
      await Promise.all(requests);

    authRedirect(batchRes.status);
    const [batchJson, studentJson, configJson, usageJson, reviewJson] =
      await Promise.all([
        batchRes.json(),
        studentRes.json(),
        configRes.json(),
        usageRes.json(),
        reviewRes.json(),
      ]);

    setBatches(batchJson.batches || []);
    setStudents(studentJson.students || []);
    if (configJson.maxPdfMb) setMaxPdfMb(configJson.maxPdfMb);
    if (!usageJson.error) setUsage(usageJson);
    setReview(reviewJson.items || []);
    if (usersRes) {
      const usersJson = await usersRes.json();
      setUsers(usersJson.users || []);
    }
    if (batchJson.error) setError(batchJson.error);
    else if (studentJson.error) setError(studentJson.error);
  }, [authRedirect, filterBatch, query, flag, grade, user.role]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  async function onUpload(event: React.FormEvent) {
    event.preventDefault();
    if (!files.length) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      let uploaded = 0;
      for (const file of files) {
        if (file.size > maxPdfMb * 1024 * 1024) {
          throw new Error(`${file.name} is larger than ${maxPdfMb} MB`);
        }
        const body = new FormData();
        body.set("file", file);
        const res = await fetch("/api/upload", { method: "POST", body });
        authRedirect(res.status);
        const json = await res.json();
        if (!res.ok) throw new Error(`${file.name}: ${json.error}`);
        uploaded += 1;
      }
      setNotice(`${uploaded} PDF(s) queued. Press "Start processing".`);
      setFiles([]);
      await load();
      setTab("process");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  const control = useCallback(
    async (action: string) => {
      setError(null);
      const res = await fetch("/api/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      authRedirect(res.status);
      const json = await res.json();
      if (!res.ok) setError(json.error || "Action failed");
      await load();
    },
    [authRedirect, load]
  );

  async function reviewAction(id: number, action: string) {
    const res = await fetch(`/api/review/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    authRedirect(res.status);
    await load();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  function exportCsv() {
    const params = new URLSearchParams();
    if (filterBatch) params.set("batchId", filterBatch);
    if (query) params.set("q", query);
    if (flag) params.set("flag", flag);
    if (grade) params.set("grade", grade);
    window.location.href = `/api/students/export?${params.toString()}`;
  }

  const activeBatches = useMemo(
    () =>
      batches.filter(
        (b) => b.status !== "done" && b.status !== "error"
      ),
    [batches]
  );
  const queueBatches = showAllBatches ? batches : activeBatches;

  const totals = useMemo(() => {
    const pagesTotal = batches.reduce((s, b) => s + (b.total_pages || 0), 0);
    const pagesDone = batches.reduce((s, b) => s + (b.page_count || 0), 0);
    const imagesExpected = batches.reduce((s, b) => s + expectedImages(b), 0);
    const imagesDone = batches.reduce((s, b) => s + (b.composite_count || 0), 0);
    const imagesSettled = batches.reduce(
      (s, b) => s + (b.composites_done || 0) + (b.composites_review || 0),
      0
    );
    return { pagesTotal, pagesDone, imagesExpected, imagesDone, imagesSettled };
  }, [batches]);

  const p = usage?.pipelines;
  const pagesPct = p ? pct(p.pagesDone, p.pagesTotal || totals.pagesTotal) : 0;
  const imagesPct = p
    ? pct(p.imagesDone, totals.imagesExpected || p.imagesDone)
    : 0;
  const aiPct = p ? pct(p.imagesProcessed, p.imagesDone) : 0;
  const running = usage?.worker.running ?? false;
  const paused = usage?.paused ?? false;

  return (
    <main className="mx-auto max-w-6xl px-5 py-8">
      <header className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-amber-800">
            QUEST 2026 · Season 04
          </p>
          <h1
            className="mt-1 text-4xl text-[#142033]"
            style={{ fontFamily: "var(--font-serif)" }}
          >
            Recovery console
          </h1>
          <p className="mt-2 text-sm text-slate-600">
            Signed in as <strong>{user.username}</strong>
            {user.role === "admin" ? " (admin)" : ""}.
          </p>
          <p className="mt-2 inline-block rounded-full bg-amber-100 px-3 py-1 text-xs text-amber-900">
            Auto-cleanup: PDFs &amp; images are deleted{" "}
            {usage?.retentionDays ?? 10} days after upload. Extracted student
            data is kept.
          </p>
        </div>
        <button
          type="button"
          onClick={logout}
          className="self-start rounded-full border border-slate-300 bg-white px-4 py-2 text-sm"
        >
          Sign out
        </button>
      </header>

      <section className="rounded-3xl border border-white/80 bg-[#142033] p-6 text-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.2em] text-amber-200">
              Worker
            </p>
            <p className="mt-1 text-2xl" style={{ fontFamily: "var(--font-serif)" }}>
              {running ? "Running" : paused ? "Paused" : "Idle"}
            </p>
            <p className="mt-1 text-xs text-slate-300">
              {running
                ? `Working… step ${usage?.worker.step ?? 0}`
                : usage?.hasWork
                  ? "Queue has pending work"
                  : "Queue empty"}
              {usage?.worker.lastError
                ? ` · last error: ${usage.worker.lastError}`
                : ""}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {running ? (
              <button
                type="button"
                onClick={() => control("pause")}
                className="rounded-2xl bg-amber-300 px-6 py-3 text-sm font-semibold text-[#142033]"
              >
                Pause
              </button>
            ) : (
              <button
                type="button"
                onClick={() => control("start")}
                className="rounded-2xl bg-emerald-400 px-6 py-3 text-sm font-semibold text-[#142033]"
              >
                Start processing
              </button>
            )}
            <button
              type="button"
              onClick={() => control("run")}
              className="rounded-2xl border border-white/30 px-5 py-3 text-sm"
            >
              Kick once
            </button>
            <button
              type="button"
              onClick={() => control("recover")}
              className="rounded-2xl border border-white/30 px-5 py-3 text-sm"
            >
              Recover stuck
            </button>
          </div>
        </div>

        <div className="mt-6 rounded-2xl bg-white/10 p-5">
          <p className="text-xs uppercase tracking-[0.2em] text-amber-200">
            Students recovered
          </p>
          <div className="mt-1 flex flex-wrap items-end gap-x-4 gap-y-1">
            <p
              className="text-5xl font-semibold"
              style={{ fontFamily: "var(--font-serif)" }}
            >
              {(p?.students ?? 0).toLocaleString()}
            </p>
            <p className="text-lg text-slate-200">
              out of {(p?.pagesTotal || totals.pagesTotal).toLocaleString()}{" "}
              pages
            </p>
            <p className="ml-auto text-lg font-semibold text-emerald-300">
              {pct(p?.students ?? 0, p?.pagesTotal || totals.pagesTotal)}%
            </p>
          </div>
          <div className="mt-3 h-2.5 w-full overflow-hidden rounded-full bg-white/20">
            <div
              className="h-full rounded-full bg-emerald-400 transition-all"
              style={{
                width: `${pct(
                  p?.students ?? 0,
                  p?.pagesTotal || totals.pagesTotal
                )}%`,
              }}
            />
          </div>
          <p className="mt-2 text-xs text-slate-300">
            Every processed page should yield one participant form.
          </p>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-3">
          <PipelineBar
            label="P1 · Pages Splits"
            hint={`${(p?.pagesDone ?? 0).toLocaleString()} / ${(
              p?.pagesTotal || totals.pagesTotal
            ).toLocaleString()} pages`}
            value={pagesPct}
          />
          <PipelineBar
            label="P2 · images Processing"
            hint={`${((p?.imagesDone ?? 0) * 6).toLocaleString()} / ${(
              totals.imagesExpected * 6
            ).toLocaleString()} images`}
            value={imagesPct}
          />
          <PipelineBar
            label="P3 · AI extraction"
            hint={`${((p?.imagesProcessed ?? 0) * 6).toLocaleString()} / ${(
              (p?.imagesDone ?? 0) * 6
            ).toLocaleString()} images`}
            value={aiPct}
          />
        </div>
      </section>

      <form
        onSubmit={onUpload}
        className="mt-6 rounded-3xl border border-white/80 bg-white/80 p-6 shadow-sm backdrop-blur"
      >
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <label className="block text-sm">
            PDFs of answer sheets (multiple allowed)
            <input
              type="file"
              accept="application/pdf"
              multiple
              className="mt-2 block w-full rounded-2xl border border-slate-200 bg-white p-3"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
          </label>
          <button
            type="submit"
            disabled={!files.length || busy}
            className="rounded-2xl bg-[#142033] px-6 py-3 text-sm font-medium text-white disabled:opacity-50"
          >
            {busy ? "Uploading…" : "Upload to server"}
          </button>
        </div>
        <p className="mt-3 text-xs text-slate-500">
          Max {maxPdfMb} MB per file · each PDF becomes its own batch.
        </p>
        {notice && <p className="mt-3 text-sm text-emerald-700">{notice}</p>}
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
      </form>

      <nav className="mt-6 flex flex-wrap gap-2">
        {TABS.filter((t) => t !== "users" || user.role === "admin").map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`rounded-full px-4 py-2 text-sm capitalize ${
              tab === t
                ? "bg-[#142033] text-white"
                : "border border-slate-300 bg-white text-slate-700"
            }`}
          >
            {t}
            {t === "review" && review.length > 0 ? ` (${review.length})` : ""}
          </button>
        ))}
      </nav>

      {tab === "process" && (
        <ProcessTab
          batches={queueBatches}
          activeCount={activeBatches.length}
          showAll={showAllBatches}
          setShowAll={setShowAllBatches}
          onStart={() => control("start")}
          onPause={() => control("pause")}
          running={running}
        />
      )}
      {tab === "students" && (
        <StudentsTab
          students={students}
          batches={batches}
          filterBatch={filterBatch}
          setFilterBatch={setFilterBatch}
          query={query}
          setQuery={setQuery}
          flag={flag}
          setFlag={setFlag}
          grade={grade}
          setGrade={setGrade}
          gradeOptions={usage?.grades || []}
          onExport={exportCsv}
        />
      )}
      {tab === "review" && (
        <ReviewTab
          items={review}
          onAction={reviewAction}
          onZoom={setZoom}
          onRetryAll={() => control("retry-review")}
        />
      )}
      {tab === "results" && <ResultsTab usage={usage} batches={batches} />}
      {tab === "users" && user.role === "admin" && (
        <UsersTab users={users} currentUserId={user.id} onChanged={load} />
      )}

      {zoom && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setZoom(null)}
        >
          <div
            className="max-h-full w-full max-w-4xl overflow-auto rounded-2xl bg-white p-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/review/${zoom.id}/image`}
              alt={`Composite ${zoom.id}`}
              className="w-full object-contain"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm text-slate-600">
                Batch #{zoom.batch_id} · pages {zoom.start_page}-{zoom.end_page}
                {zoom.error_message ? ` · ${zoom.error_message}` : ""}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    reviewAction(zoom.id, "retry");
                    setZoom(null);
                  }}
                  className="rounded-full bg-[#142033] px-4 py-2 text-xs text-white"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => {
                    reviewAction(zoom.id, "discard");
                    setZoom(null);
                  }}
                  className="rounded-full border border-slate-300 px-4 py-2 text-xs"
                >
                  Mark done
                </button>
                <button
                  type="button"
                  onClick={() => setZoom(null)}
                  className="rounded-full border border-slate-300 px-4 py-2 text-xs"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <footer className="mt-10 border-t border-slate-200 pt-4 text-xs text-slate-500">
        <p>
          Storage policy: uploaded PDFs, split page images and processed
          images are permanently deleted {usage?.retentionDays ?? 10} days after upload by
          the automated cron job. Extracted student records remain in the
          database.
          {usage?.lastCleanupAt
            ? ` Last cleanup run: ${new Date(
                usage.lastCleanupAt
              ).toLocaleString()}.`
            : ""}
        </p>
      </footer>
    </main>
  );
}

function ProcessTab({
  batches,
  activeCount,
  showAll,
  setShowAll,
  onStart,
  onPause,
  running,
}: {
  batches: Batch[];
  activeCount: number;
  showAll: boolean;
  setShowAll: (v: boolean) => void;
  onStart: () => void;
  onPause: () => void;
  running: boolean;
}) {
  return (
    <section className="mt-6 overflow-hidden rounded-3xl border border-white bg-white shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3">
        <p className="text-sm font-medium">
          Active &amp; queued PDFs
          <span className="ml-2 text-xs text-slate-400">
            {activeCount} in flight
          </span>
        </p>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={showAll ? onStart : onPause}
            className="rounded-full bg-[#142033] px-4 py-2 text-xs text-white"
          >
            {showAll ? "Show active only" : running ? "Pause" : "Start"}
          </button>
          <label className="flex items-center gap-2 text-xs text-slate-500">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
            />
            Show completed
          </label>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3">File</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3 w-40">P1 · Pages</th>
              <th className="px-4 py-3 w-40">P2 · Images</th>
              <th className="px-4 py-3">Students</th>
              <th className="px-4 py-3">Recovery</th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-slate-400" colSpan={6}>
                  Nothing running or queued. Upload a PDF to begin.
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
                <td className="px-4 py-3">
                  <MiniBar
                    value={pct(b.page_count, b.total_pages)}
                    hint={`${b.page_count}/${b.total_pages || "—"}`}
                  />
                </td>
                <td className="px-4 py-3">
                  <MiniBar
                    value={pct(b.composite_count, expectedImages(b))}
                    hint={`${(b.composite_count * 6).toLocaleString()} / ${(
                      expectedImages(b) * 6
                    ).toLocaleString()}`}
                  />
                </td>
                <td className="px-4 py-3">{b.student_count}</td>
                <td className="px-4 py-3 text-slate-500">
                  {pct(b.student_count, b.total_pages)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function PipelineBar({
  label,
  hint,
  value,
}: {
  label: string;
  hint: string;
  value: number;
}) {
  return (
    <div className="rounded-2xl bg-white/10 p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm">{label}</p>
        <p className="text-lg font-semibold">{value}%</p>
      </div>
      <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-white/20">
        <div
          className="h-full rounded-full bg-emerald-400 transition-all"
          style={{ width: `${value}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-slate-300">{hint}</p>
    </div>
  );
}

function MiniBar({ value, hint }: { value: number; hint: string }) {
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200">
        <div
          className="h-full rounded-full bg-[#142033]"
          style={{ width: `${value}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {hint} · {value}%
      </p>
    </div>
  );
}

function StudentsTab({
  students,
  batches,
  filterBatch,
  setFilterBatch,
  query,
  setQuery,
  flag,
  setFlag,
  grade,
  setGrade,
  gradeOptions,
  onExport,
}: {
  students: Student[];
  batches: Batch[];
  filterBatch: string;
  setFilterBatch: (v: string) => void;
  query: string;
  setQuery: (v: string) => void;
  flag: string;
  setFlag: (v: string) => void;
  grade: string;
  setGrade: (v: string) => void;
  gradeOptions: Breakdown[];
  onExport: () => void;
}) {
  return (
    <section className="mt-6 overflow-hidden rounded-3xl border border-white bg-white shadow-sm">
      <div className="flex flex-wrap items-end gap-3 border-b border-slate-100 px-5 py-4">
        <label className="text-xs text-slate-500">
          Batch
          <select
            value={filterBatch}
            onChange={(e) => setFilterBatch(e.target.value)}
            className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All batches</option>
            {batches.map((b) => (
              <option key={b.id} value={b.id}>
                #{b.id} {b.filename}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Search
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="name, email, school"
            className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          />
        </label>
        <label className="text-xs text-slate-500">
          Class
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">All classes</option>
            {gradeOptions.map((g) => (
              <option key={g.label} value={g.grade_number ?? ""}>
                {g.label} ({g.total})
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          Flag
          <select
            value={flag}
            onChange={(e) => setFlag(e.target.value)}
            className="mt-1 block rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">Any</option>
            <option value="issues">Has issues</option>
            <option value="duplicate">Duplicate email</option>
            <option value="invalid_email">Invalid email</option>
          </select>
        </label>
        <button
          type="button"
          onClick={onExport}
          className="ml-auto rounded-full border border-slate-300 bg-white px-4 py-2 text-sm"
        >
          Export CSV
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3">Batch</th>
              <th className="px-4 py-3">Page</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">Grade</th>
              <th className="px-4 py-3">Class #</th>
              <th className="px-4 py-3">School</th>
              <th className="px-4 py-3">Flags</th>
            </tr>
          </thead>
          <tbody>
            {students.length === 0 && (
              <tr>
                <td className="px-4 py-8 text-slate-400" colSpan={8}>
                  Nothing in the database yet.
                </td>
              </tr>
            )}
            {students.map((s) => (
              <tr key={s.id} className="border-t border-slate-100">
                <td className="px-4 py-3 text-slate-500">{s.batch_id}</td>
                <td className="px-4 py-3 text-slate-500">{s.source_page}</td>
                <td className="px-4 py-3">{s.name || "—"}</td>
                <td className="px-4 py-3">{s.email || "—"}</td>
                <td className="px-4 py-3">{s.grade || "—"}</td>
                <td className="px-4 py-3">
                  {s.grade_number ? (
                    <Badge tone="slate">Class {s.grade_number}</Badge>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-3">{s.school_name || "—"}</td>
                <td className="px-4 py-3">
                  {s.is_duplicate ? <Badge tone="amber">duplicate</Badge> : null}
                  {!s.valid_email ? <Badge tone="red">email</Badge> : null}
                  {s.issues && !s.is_duplicate && s.valid_email ? (
                    <Badge tone="slate">{s.issues}</Badge>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ReviewTab({
  items,
  onAction,
  onZoom,
  onRetryAll,
}: {
  items: ReviewItem[];
  onAction: (id: number, action: string) => void;
  onZoom: (item: ReviewItem) => void;
  onRetryAll: () => void;
}) {
  if (!items.length) {
    return (
      <section className="mt-6 rounded-3xl border border-white bg-white p-8 text-center text-sm text-slate-400 shadow-sm">
        Nothing needs review.
      </section>
    );
  }
  return (
    <section className="mt-6">
      <div className="mb-3 flex justify-end">
        <button
          type="button"
          onClick={onRetryAll}
          className="rounded-full border border-slate-300 bg-white px-4 py-2 text-sm"
        >
          Retry all ({items.length})
        </button>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((item) => (
          <div
            key={item.id}
            className="overflow-hidden rounded-3xl border border-white bg-white shadow-sm"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`/api/review/${item.id}/image`}
              alt={`Composite ${item.id}`}
              onClick={() => onZoom(item)}
              className="h-64 w-full cursor-zoom-in bg-slate-100 object-contain"
            />
            <div className="p-4">
              <p className="text-sm font-medium">
                Batch #{item.batch_id} · pages {item.start_page}-{item.end_page}
              </p>
              <p className="mt-1 text-xs text-slate-500">{item.filename}</p>
              {item.error_message ? (
                <p className="mt-2 text-xs text-red-600">{item.error_message}</p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <button
                  type="button"
                  onClick={() => onAction(item.id, "retry")}
                  className="rounded-full bg-[#142033] px-4 py-2 text-xs text-white"
                >
                  Retry
                </button>
                <button
                  type="button"
                  onClick={() => onAction(item.id, "discard")}
                  className="rounded-full border border-slate-300 px-4 py-2 text-xs"
                >
                  Mark done
                </button>
                <button
                  type="button"
                  onClick={() => onZoom(item)}
                  className="rounded-full border border-slate-300 px-4 py-2 text-xs"
                >
                  Zoom
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResultsTab({ usage, batches }: { usage: Usage | null; batches: Batch[] }) {
  const p = usage?.pipelines;
  const s = usage?.students;
  const processed = p?.imagesProcessed ?? 0;
  const forms = processed * 6;
  const recovered = s?.total ?? 0;
  const pagesTotal = p?.pagesTotal ?? 0;
  const pagesDone = p?.pagesDone ?? 0;
  const recoveryRate = pagesTotal
    ? Math.round((recovered / pagesTotal) * 100)
    : 0;
  const emailRate = recovered
    ? Math.round(((s?.validEmails ?? 0) / recovered) * 100)
    : 0;

  const maxSchool = Math.max(1, ...(usage?.schools || []).map((r) => r.total));
  const maxGrade = Math.max(1, ...(usage?.grades || []).map((r) => r.total));

  return (
    <>
      <section className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <BigStat
          label={`Students recovered (of ${pagesTotal.toLocaleString()} pages)`}
          value={recovered.toLocaleString()}
          highlight
        />
        <BigStat
          label="Recovery rate (students ÷ pages)"
          value={`${recoveryRate}%`}
          highlight
        />
        <BigStat label="Processed images" value={forms.toLocaleString()} />
        <Stat label="Pages processed" value={pagesDone.toLocaleString()} />
        <Stat label="Valid emails" value={(s?.validEmails ?? 0).toLocaleString()} />
        <Stat label="Emails on file" value={(s?.withEmail ?? 0).toLocaleString()} />
        <Stat label="Valid email rate" value={`${emailRate}%`} />
        <Stat label="Duplicates flagged" value={(s?.duplicates ?? 0).toLocaleString()} />
        <Stat label="Invalid emails" value={(s?.invalidEmails ?? 0).toLocaleString()} />
        <Stat label="Schools covered" value={(s?.schools ?? 0).toLocaleString()} />
        <Stat label="Grades seen" value={(s?.grades ?? 0).toLocaleString()} />
        <Stat label="Needs review" value={(p?.imagesReview ?? 0).toLocaleString()} />
        <Stat label="Batches" value={(p?.batches ?? batches.length).toLocaleString()} />
      </section>

      <section className="mt-6 grid gap-4 lg:grid-cols-2">
        <BreakdownCard
          title="Students by class"
          rows={usage?.grades || []}
          max={maxGrade}
        />
        <BreakdownCard
          title="Top schools"
          rows={usage?.schools || []}
          max={maxSchool}
        />
      </section>

      <section className="mt-6 overflow-hidden rounded-3xl border border-white bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-medium">
          Recovery by batch
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-4 py-3">Batch</th>
                <th className="px-4 py-3">File</th>
                <th className="px-4 py-3">Pages</th>
                <th className="px-4 py-3">Images</th>
                <th className="px-4 py-3">Students</th>
                <th className="px-4 py-3">Recovery</th>
              </tr>
            </thead>
            <tbody>
              {batches.map((b) => {
                const images = (b.composites_done + b.composites_review) * 6;
                return (
                  <tr key={b.id} className="border-t border-slate-100">
                    <td className="px-4 py-3 text-slate-500">#{b.id}</td>
                    <td className="px-4 py-3">{b.filename}</td>
                    <td className="px-4 py-3">
                      {b.page_count}/{b.total_pages || "—"}
                    </td>
                    <td className="px-4 py-3">{images}</td>
                    <td className="px-4 py-3">{b.student_count}</td>
                    <td className="px-4 py-3">
                      {pct(b.student_count, b.total_pages)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function BreakdownCard({
  title,
  rows,
  max,
}: {
  title: string;
  rows: Breakdown[];
  max: number;
}) {
  return (
    <div className="rounded-3xl border border-white bg-white p-5 shadow-sm">
      <p className="text-sm font-medium">{title}</p>
      {rows.length === 0 && (
        <p className="mt-3 text-xs text-slate-400">No data yet.</p>
      )}
      <div className="mt-3 space-y-2">
        {rows.map((row) => (
          <div key={row.label}>
            <div className="flex items-center justify-between text-xs text-slate-600">
              <span className="truncate pr-2">{row.label}</span>
              <span>{row.total}</span>
            </div>
            <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-[#142033]"
                style={{ width: `${Math.round((row.total / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function UsersTab({
  users,
  currentUserId,
  onChanged,
}: {
  users: AdminUser[];
  currentUserId: number;
  onChanged: () => void;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [error, setError] = useState<string | null>(null);

  async function create(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const res = await fetch("/api/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password, role }),
    });
    const json = await res.json();
    if (!res.ok) {
      setError(json.error || "Failed");
      return;
    }
    setUsername("");
    setPassword("");
    setRole("user");
    onChanged();
  }

  async function toggleActive(u: AdminUser) {
    await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: !u.active }),
    });
    onChanged();
  }

  async function resetPassword(u: AdminUser) {
    const next = window.prompt(`New password for ${u.username} (6+ chars)`);
    if (!next) return;
    const res = await fetch(`/api/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: next }),
    });
    const json = await res.json();
    if (!res.ok) window.alert(json.error || "Failed");
  }

  async function remove(u: AdminUser) {
    if (!window.confirm(`Delete user ${u.username}?`)) return;
    await fetch(`/api/users/${u.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="overflow-hidden rounded-3xl border border-white bg-white shadow-sm">
        <div className="border-b border-slate-100 px-5 py-3 text-sm font-medium">
          Console users
        </div>
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-4 py-3">Username</th>
              <th className="px-4 py-3">Role</th>
              <th className="px-4 py-3">Active</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className="border-t border-slate-100">
                <td className="px-4 py-3">{u.username}</td>
                <td className="px-4 py-3">{u.role}</td>
                <td className="px-4 py-3">{u.active ? "yes" : "no"}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => toggleActive(u)}
                      disabled={u.id === currentUserId}
                      className="rounded-full border border-slate-300 px-3 py-1 text-xs disabled:opacity-40"
                    >
                      {u.active ? "Deactivate" : "Activate"}
                    </button>
                    <button
                      type="button"
                      onClick={() => resetPassword(u)}
                      className="rounded-full border border-slate-300 px-3 py-1 text-xs"
                    >
                      Reset password
                    </button>
                    <button
                      type="button"
                      onClick={() => remove(u)}
                      disabled={u.id === currentUserId}
                      className="rounded-full border border-red-300 px-3 py-1 text-xs text-red-700 disabled:opacity-40"
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form
        onSubmit={create}
        className="rounded-3xl border border-white bg-white p-5 shadow-sm"
      >
        <p className="text-sm font-medium">Add user</p>
        <label className="mt-3 block text-xs text-slate-500">
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-3 block text-xs text-slate-500">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          />
        </label>
        <label className="mt-3 block text-xs text-slate-500">
          Role
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="mt-1 block w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
          >
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </label>
        {error && <p className="mt-3 text-xs text-red-700">{error}</p>}
        <button
          type="submit"
          disabled={!username || password.length < 6}
          className="mt-4 w-full rounded-2xl bg-[#142033] px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          Create user
        </button>
      </form>
    </section>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "amber" | "red" | "slate";
  children: React.ReactNode;
}) {
  const tones = {
    amber: "bg-amber-100 text-amber-800",
    red: "bg-red-100 text-red-700",
    slate: "bg-slate-100 text-slate-600",
  };
  return (
    <span
      className={`mr-1 inline-block rounded-full px-2 py-0.5 text-xs ${tones[tone]}`}
    >
      {children}
    </span>
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

function BigStat({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string | number;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl p-5 shadow-sm ${
        highlight ? "bg-[#142033] text-white" : "bg-white"
      }`}
    >
      <p
        className={`text-xs uppercase tracking-wide ${
          highlight ? "text-amber-200" : "text-slate-500"
        }`}
      >
        {label}
      </p>
      <p
        className="mt-1 text-3xl"
        style={{ fontFamily: "var(--font-serif)" }}
      >
        {value}
      </p>
    </div>
  );
}
