"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  Activity,
  ArrowUp,
  BarChart3,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Dumbbell,
  Flame,
  MessageCircle,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
} from "chart.js";
import { Line } from "react-chartjs-2";
import {
  parts,
  today,
  volume,
  type Exercise,
  type Log,
  type Message,
  type Summary,
} from "@/lib/domain";
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Filler,
);
type State = {
  date: string;
  chat: Message[];
  summary: Summary;
  pending: { id: number; content: string; date: string }[];
};
type Stats = {
  logs: Log[];
  weekVolume: number;
  monthDays: number;
  streak: number;
};
type Editor = { log?: Log; date: string; messageId?: number };
const number = (n: number) =>
  n.toLocaleString("ko-KR", { maximumFractionDigits: 1 });
const dateLabel = (d: string) =>
  `${Number(d.slice(5, 7))}월 ${Number(d.slice(8, 10))}일`;
async function api<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const r = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error ?? "잠시 후 다시 시도해 주세요.");
  return d;
}
type RequestEnvelope = {
  requestId: string;
  status: "processing" | "completed" | "failed";
  result: { text?: string; [key: string]: unknown } | null;
};
async function settled(result: RequestEnvelope) {
  for (let i = 0; result.status === "processing" && i < 50; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    result = await api<RequestEnvelope>("requests/" + result.requestId);
  }
  if (result.status === "processing")
    throw new Error("아직 처리 중이에요. 처리 확인을 눌러 주세요.");
  return result;
}
function Detail({ log }: { log: Exercise }) {
  return (
    <>
      {log.bodyPart === "유산소"
        ? `${number(log.durationMinutes ?? 0)}분`
        : `${log.weightKg === null ? "맨몸" : `${number(log.weightKg)}kg`} × ${log.reps}회${log.sets > 1 ? ` · ${log.sets}세트` : ""}`}
    </>
  );
}
function SummaryCard({
  data,
  onEdit,
}: {
  data: Summary;
  onEdit: (log: Log) => void;
}) {
  return (
    <section className="summary-card" aria-label="운동 요약">
      <div className="summary-heading">
        <span>{dateLabel(data.date)} 운동 요약</span>
        <span>
          <Clock3 size={16} />
          {data.durationMinutes}분
        </span>
      </div>
      <p className="volume-label">오늘의 총 볼륨</p>
      <div className="big-number">
        {number(data.totalVolumeKg)}
        <span> kg</span>
      </div>
      <div className="summary-metrics">
        <span>근력 {data.totalSets}세트</span>
        {data.cardioMinutes > 0 && (
          <span>유산소 {number(data.cardioMinutes)}분</span>
        )}
      </div>
      <div className="summary-logs">
        {data.logs.map((log) => (
          <button
            className="summary-row"
            key={log.id}
            onClick={() => onEdit(log)}
            aria-label={`${log.name} 기록 수정`}
          >
            <Dumbbell size={18} />
            <span>
              <strong>{log.name}</strong>
              <small>{log.bodyPart}</small>
            </span>
            <span className="log-value">
              <Detail log={log} />
            </span>
            <Pencil size={14} />
          </button>
        ))}
      </div>
      {data.streakCount > 0 && (
        <div className="streak">
          <Flame size={19} />
          {data.streakCount}일 연속 운동 중
        </div>
      )}
      <p className="feedback">
        {data.feedbackText || "오늘의 기록이 쌓였어요. 수고하셨어요."}
      </p>
    </section>
  );
}
function EditDialog({
  editor,
  onClose,
  onSaved,
}: {
  editor: Editor;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [part, setPart] = useState<Exercise["bodyPart"]>(
    editor.log?.bodyPart ?? "기타",
  );
  const requestId = useRef(crypto.randomUUID());
  const pendingManual = useRef<{
    exercise: Exercise;
    date: string;
    messageId?: number;
    requestId: string;
  } | null>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const val = (k: string) => String(f.get(k) ?? "");
    const exercise: Exercise = {
      name: val("name"),
      bodyPart: part,
      weightKg:
        part === "유산소" || val("weight") === ""
          ? null
          : Number(val("weight")),
      reps: part === "유산소" ? null : Number(val("reps")),
      sets: part === "유산소" ? 1 : Number(val("sets")),
      durationMinutes: part === "유산소" ? Number(val("minutes")) : null,
    };
    try {
      if (editor.log) await api("logs/" + editor.log.id, "PATCH", exercise);
      else {
        pendingManual.current ??= {
          exercise,
          date: editor.date,
          messageId: editor.messageId,
          requestId: requestId.current,
        };
        const result = await settled(
          await api<RequestEnvelope>("logs", "POST", pendingManual.current),
        );
        if (result.status === "failed") {
          pendingManual.current = null;
          requestId.current = crypto.randomUUID();
          throw new Error(result.result?.text ?? "기록을 완료하지 못했어요.");
        }
      }
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await api("logs/" + editor.log!.id, "DELETE");
      await onSaved();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      onCancel={(e) => {
        if (busy) e.preventDefault();
        else onClose();
      }}
      className="edit-dialog"
    >
      <div className="dialog-head">
        <h2>
          {deleting
            ? "기록을 삭제할까요?"
            : editor.log
              ? "기록 수정"
              : "직접 기록"}
        </h2>
        <button
          className="icon-button"
          aria-label="닫기"
          onClick={onClose}
          disabled={busy}
        >
          <X />
        </button>
      </div>
      {deleting ? (
        <>
          <p>이 운동 기록이 삭제되고 통계에 반영돼요.</p>
          <div className="dialog-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setDeleting(false)}
            >
              돌아가기
            </button>
            <button className="danger" disabled={busy} onClick={remove}>
              삭제하기
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={save}>
          <fieldset
            disabled={busy || !!pendingManual.current}
            className="editor-fields"
          >
            <p className="muted">{dateLabel(editor.date)}의 운동</p>
            <label>
              운동 이름
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={editor.log?.name}
                placeholder="예: 사이드 레터럴 레이즈"
                autoFocus
              />
            </label>
            <label>
              운동 부위
              <select
                value={part}
                onChange={(e) =>
                  setPart(e.target.value as Exercise["bodyPart"])
                }
              >
                {parts.map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
            {part === "유산소" ? (
              <label>
                운동 시간 (분)
                <input
                  name="minutes"
                  type="number"
                  min="0.1"
                  max="1440"
                  step="0.1"
                  required
                  defaultValue={editor.log?.durationMinutes ?? 15}
                />
              </label>
            ) : (
              <div className="field-grid">
                <label>
                  무게 (kg)
                  <input
                    name="weight"
                    type="number"
                    min="0"
                    max="2000"
                    step="0.1"
                    placeholder="맨몸은 빈칸"
                    defaultValue={editor.log?.weightKg ?? ""}
                  />
                </label>
                <label>
                  횟수
                  <input
                    name="reps"
                    type="number"
                    min="1"
                    max="10000"
                    required
                    defaultValue={editor.log?.reps ?? 10}
                  />
                </label>
                <label>
                  세트
                  <input
                    name="sets"
                    type="number"
                    min="1"
                    max="100"
                    required
                    defaultValue={editor.log?.sets ?? 1}
                  />
                </label>
              </div>
            )}
          </fieldset>
          <div className="dialog-actions">
            {editor.log && (
              <button
                type="button"
                className="delete-button"
                onClick={() => setDeleting(true)}
                disabled={busy}
              >
                <Trash2 size={18} />
                삭제
              </button>
            )}
            <button className="primary" type="submit" disabled={busy}>
              {busy
                ? "저장 중…"
                : pendingManual.current
                  ? "처리 확인·재전송"
                  : "저장하기"}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </dialog>
  );
}
function ExerciseChart({ logs }: { logs: Log[] }) {
  const days = [...new Set(logs.map((l) => l.date))].sort();
  const cardio = logs.every((l) => l.bodyPart === "유산소");
  const bodyweight = logs.every((l) => l.weightKg === null);
  const [metric, setMetric] = useState("weight");
  if (days.length < 3)
    return (
      <div className="chart-empty">
        <Activity size={25} />
        <p>기록이 더 쌓이면 그래프가 보여요</p>
        <small>서로 다른 날짜의 기록이 3일 이상 필요해요</small>
      </div>
    );
  const isVolume = metric === "volume";
  const label = cardio
    ? "운동 시간 (분)"
    : bodyweight
      ? "총 횟수 (회)"
      : isVolume
        ? "총 볼륨 (kg)"
        : "최고 무게 (kg)";
  const values = days.map((d) => {
    const a = logs.filter((l) => l.date === d);
    return cardio
      ? a.reduce((n, l) => n + (l.durationMinutes ?? 0), 0)
      : bodyweight
        ? a.reduce((n, l) => n + (l.reps ?? 0) * l.sets, 0)
        : isVolume
          ? a.reduce((n, l) => n + volume(l), 0)
          : Math.max(...a.map((l) => l.weightKg ?? 0));
  });
  return (
    <div className="chart-wrap">
      {!cardio && !bodyweight && (
        <div className="segmented">
          <button aria-pressed={!isVolume} onClick={() => setMetric("weight")}>
            최고 무게
          </button>
          <button aria-pressed={isVolume} onClick={() => setMetric("volume")}>
            총 볼륨
          </button>
        </div>
      )}
      <p className="muted">{label}</p>
      <div className="chart">
        <Line
          data={{
            labels: days.map((d) => d.slice(5).replace("-", "/")),
            datasets: [
              {
                label,
                data: values,
                borderColor: "#3182f6",
                backgroundColor: "rgba(49,130,246,.08)",
                fill: true,
                tension: 0.25,
                pointRadius: 4,
                pointBackgroundColor: "#3182f6",
              },
            ],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: {
              x: { grid: { display: false }, ticks: { color: "#8b95a1" } },
              y: {
                beginAtZero: true,
                grid: { color: "rgba(139,149,161,.13)" },
                ticks: { color: "#8b95a1" },
              },
            },
          }}
        />
      </div>
      <details className="chart-data">
        <summary>수치로 보기</summary>
        <table>
          <thead>
            <tr>
              <th>날짜</th>
              <th>{label}</th>
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d}>
                <td>{d}</td>
                <td>{number(values[i])}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </div>
  );
}
export default function Home() {
  const [tab, setTab] = useState<"chat" | "stats" | "history">("chat");
  const [state, setState] = useState<State | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [month, setMonth] = useState("");
  const [calendar, setCalendar] = useState<{ date: string; count: number }[]>(
    [],
  );
  const [detail, setDetail] = useState<Summary | null>(null);
  const [exerciseId, setExerciseId] = useState<number | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const [unresolved, setUnresolved] = useState<{
    message: string;
    requestId: string;
  } | null>(null);
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem("workout-request");
      if (saved) setUnresolved(JSON.parse(saved));
    } catch {}
  }, []);
  const sending = useRef(false);
  const load = useCallback(async () => {
    const [s, t] = await Promise.all([
      api<State>("state"),
      api<Stats>("exercises"),
    ]);
    setState(s);
    setStats(t);
    setMonth((m) => m || s.date.slice(0, 7));
  }, []);
  useEffect(() => {
    load().catch((e) => setError(e.message));
    const refresh = () => {
      if (document.visibilityState === "visible") load().catch(() => {});
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [load]);
  useEffect(() => {
    if (month)
      api<{ date: string; count: number }[]>("calendar?month=" + month)
        .then(setCalendar)
        .catch((e) => setError(e.message));
  }, [month, stats]);
  useEffect(() => {
    let cancelled = false;
    if (selected)
      api<Summary>("summary/" + selected)
        .then((s) => {
          if (!cancelled) setDetail(s);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    return () => {
      cancelled = true;
    };
  }, [selected, stats]);
  useEffect(() => {
    if (tab === "chat")
      bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [state?.chat.length, tab, busy]);
  const send = useCallback(
    async (
      message: string,
      resume?: { message: string; requestId: string },
    ) => {
      if (sending.current || !message.trim()) return;
      sending.current = true;
      setBusy(true);
      setError("");
      const payload = resume ?? { message, requestId: crypto.randomUUID() };
      setUnresolved(payload);
      try {
        sessionStorage.setItem("workout-request", JSON.stringify(payload));
      } catch {}
      try {
        const result = await settled(
          await api<RequestEnvelope>("chat", "POST", payload),
        );
        setUnresolved(null);
        try {
          sessionStorage.removeItem("workout-request");
        } catch {}
        setText("");
        if (result.status === "failed")
          setError(
            result.result?.text ?? "원문은 보관했어요. 직접 기록해 주세요.",
          );
        await load();
      } catch (e) {
        setError((e as Error).message);
        await load().catch(() => {});
      } finally {
        setBusy(false);
        sending.current = false;
      }
    },
    [load],
  );
  useEffect(() => {
    const context = (
      document as Document & {
        modelContext?: {
          registerTool: (tool: object, options: object) => void | Promise<void>;
        };
      }
    ).modelContext;
    if (!context) return;
    const controller = new AbortController();
    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: "open_workout_tab",
            description: "운동 앱의 채팅, 통계, 기록 탭을 엽니다.",
            inputSchema: {
              type: "object",
              properties: {
                tab: { type: "string", enum: ["chat", "stats", "history"] },
              },
              required: ["tab"],
              additionalProperties: false,
            },
            execute: async (input: unknown) => {
              const t = (input as { tab?: unknown })?.tab;
              if (t !== "chat" && t !== "stats" && t !== "history")
                throw new Error("잘못된 탭");
              setTab(t);
              return { tab: t };
            },
          },
          { signal: controller.signal },
        ),
      ).catch(() => {});
    } catch {}
    return () => controller.abort();
  }, []);
  const date = state?.date ?? today();
  const currentExercise =
    stats?.logs.filter((l) => l.exerciseId === exerciseId) ?? [];
  function changeMonth(delta: number) {
    const d = new Date(month + "-01T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + delta);
    setMonth(d.toISOString().slice(0, 7));
    setSelected(null);
    setDetail(null);
  }
  const cells = month
    ? Array.from(
        {
          length: new Date(
            Number(month.slice(0, 4)),
            Number(month.slice(5, 7)),
            0,
          ).getDate(),
        },
        (_, i) => i + 1,
      )
    : [];
  const offset = month ? new Date(month + "-01T00:00:00Z").getUTCDay() : 0;
  return (
    <main className="app-shell">
      <header className="app-header">
        <div className="brand">
          <Dumbbell size={25} />
          <h1>오늘의 운동</h1>
        </div>
        <span className="header-date">{dateLabel(date)}</span>
      </header>
      <div className="page-content">
        {error && (
          <div className="error-banner" role="alert">
            <span>{error}</span>
            <button
              onClick={() => {
                setError("");
                load().catch((e) => setError(e.message));
              }}
            >
              다시 확인
            </button>
          </div>
        )}
        {tab === "chat" && (
          <section className="chat-view" aria-label="운동 채팅">
            <div className="date-divider">
              <span>{dateLabel(date)}</span>
            </div>
            {!state ? (
              <div className="empty-state">
                <Activity />
                <p>기록을 불러오고 있어요</p>
              </div>
            ) : state.chat.length === 0 ? (
              <div className="welcome">
                <div className="welcome-icon">
                  <Dumbbell size={32} />
                </div>
                <h2>오늘도, 나의 페이스로</h2>
                <p>
                  운동을 마칠 때마다 편하게 적어 주세요.
                  <br />
                  모두 마쳤다면 ‘끝’으로 정리해요.
                </p>
                <div className="examples">
                  <button
                    onClick={() => setText("사이드 레터럴 레이즈 25kg × 20")}
                  >
                    사이드 레터럴 레이즈 25kg × 20
                  </button>
                  <button onClick={() => setText("천국의 계단 15분")}>
                    천국의 계단 15분
                  </button>
                </div>
              </div>
            ) : (
              <div className="messages" role="log" aria-label="오늘의 대화">
                {state.chat.map((m, i) =>
                  m.type === "summary_card" ? (
                    <div key={m.id}>
                      {m.date === state.summary.date ? (
                        <SummaryCard
                          data={state.summary}
                          onEdit={(log) => setEditor({ log, date: log.date })}
                        />
                      ) : (
                        <p className="muted">요약할 운동 기록이 없어요.</p>
                      )}
                    </div>
                  ) : (
                    <div key={m.id} className={`message ${m.role}`}>
                      <div className="bubble">
                        {m.role === "assistant" && m.status === "logged" && (
                          <Check size={19} />
                        )}
                        <span>{m.content}</span>
                      </div>
                      {m.role === "user" && m.status === "pending" && (
                        <button
                          className="pending-button"
                          onClick={() =>
                            setEditor({ date: m.date, messageId: m.id })
                          }
                        >
                          미기록 · 직접 기록하기
                        </button>
                      )}
                      {m.role === "assistant" &&
                        m.status === "logged" &&
                        i === state.chat.length - 1 && (
                          <button
                            className="text-button"
                            onClick={() => {
                              setSelected(date);
                              setTab("history");
                            }}
                          >
                            기록 확인·수정
                          </button>
                        )}
                    </div>
                  ),
                )}
              </div>
            )}
            {busy && (
              <div className="message assistant">
                <div className="bubble typing" role="status">
                  입력을 확인하고 있어요<span>···</span>
                </div>
              </div>
            )}
            <div ref={bottom} />
          </section>
        )}
        {tab === "stats" && (
          <section className="stats-view">
            <div className="section-title">
              <div>
                <p className="eyebrow">조금씩 쌓이는 변화</p>
                <h2>나의 운동 통계</h2>
              </div>
              <BarChart3 size={26} />
            </div>
            <div className="overview">
              <div>
                <span>이번 주 볼륨</span>
                <strong>
                  {number(stats?.weekVolume ?? 0)}
                  <small> kg</small>
                </strong>
              </div>
              <div>
                <span>이번 달 운동</span>
                <strong>
                  {stats?.monthDays ?? 0}
                  <small> 일</small>
                </strong>
              </div>
              <div>
                <span>연속 기록</span>
                <strong>
                  {stats?.streak ?? 0}
                  <small> 일</small>
                </strong>
              </div>
            </div>
            {exerciseId !== null && currentExercise.length > 0 ? (
              <section className="exercise-detail">
                <button
                  className="text-button"
                  onClick={() => setExerciseId(null)}
                >
                  <ChevronLeft size={18} />
                  운동 목록
                </button>
                <h3>{currentExercise[0].name}</h3>
                <ExerciseChart logs={currentExercise} />
                <h4>최근 기록</h4>
                {currentExercise
                  .slice(-10)
                  .reverse()
                  .map((log) => (
                    <button
                      key={log.id}
                      className="history-row"
                      onClick={() => setEditor({ log, date: log.date })}
                    >
                      <span>{dateLabel(log.date)}</span>
                      <span>
                        <Detail log={log} />
                      </span>
                      <Pencil size={15} />
                    </button>
                  ))}
              </section>
            ) : (
              <>
                <h3 className="list-heading">부위별 운동</h3>
                {parts.map((part) => {
                  const logs =
                    stats?.logs.filter((l) => l.bodyPart === part) ?? [];
                  const ids = [...new Set(logs.map((l) => l.exerciseId))];
                  return ids.length > 0 ? (
                    <details key={part} className="part-group" open>
                      <summary>
                        {part}
                        <span>{ids.length}</span>
                      </summary>
                      {ids.map((id) => {
                        const l = logs
                          .filter((l) => l.exerciseId === id)
                          .at(-1)!;
                        return (
                          <button
                            className="exercise-row"
                            key={id}
                            onClick={() => setExerciseId(id)}
                          >
                            <span>
                              <strong>{l.name}</strong>
                              <small>
                                최근 {dateLabel(l.date)} · <Detail log={l} />
                              </small>
                            </span>
                            <ChevronRight size={18} />
                          </button>
                        );
                      })}
                    </details>
                  ) : null;
                })}
                {!stats?.logs.length && (
                  <div className="empty-state">
                    <BarChart3 />
                    <p>첫 운동을 기록하면 변화가 쌓여요</p>
                    <button
                      className="text-button"
                      onClick={() => setTab("chat")}
                    >
                      운동 기록하기
                    </button>
                  </div>
                )}
              </>
            )}
          </section>
        )}
        {tab === "history" && (
          <section className="history-view">
            {!!state?.pending.length && (
              <details className="pending-records">
                <summary>
                  아직 기록하지 않은 입력 {state.pending.length}개
                </summary>
                {state.pending.map((m) => (
                  <button
                    className="exercise-row"
                    key={m.id}
                    onClick={() => setEditor({ date: m.date, messageId: m.id })}
                  >
                    <span>
                      <small>{m.date}</small>
                      <strong>{m.content}</strong>
                    </span>
                    <Pencil size={18} />
                  </button>
                ))}
              </details>
            )}
            <div className="section-title">
              <div>
                <p className="eyebrow">꾸준함의 흔적</p>
                <h2>운동 기록</h2>
              </div>
              <button
                className="icon-button add-record"
                aria-label="운동 직접 기록"
                onClick={() => setEditor({ date: selected ?? date })}
              >
                <Plus />
              </button>
            </div>
            <div className="history-streak">
              <Flame size={20} />
              <strong>{stats?.streak ?? 0}일</strong> 연속 기록 중
            </div>
            <div className="calendar">
              <div className="month-nav">
                <button
                  className="icon-button"
                  aria-label="이전 달"
                  onClick={() => changeMonth(-1)}
                  disabled={!month}
                >
                  <ChevronLeft />
                </button>
                <h3>
                  {month.slice(0, 4)}년 {Number(month.slice(5, 7)) || ""}월
                </h3>
                <button
                  className="icon-button"
                  aria-label="다음 달"
                  onClick={() => changeMonth(1)}
                  disabled={!month}
                >
                  <ChevronRight />
                </button>
              </div>
              <div className="calendar-grid">
                {["일", "월", "화", "수", "목", "금", "토"].map((d) => (
                  <span key={d} className="weekday">
                    {d}
                  </span>
                ))}
                {Array.from({ length: offset }, (_, i) => (
                  <span key={"blank" + i} />
                ))}
                {cells.map((day) => {
                  const d = month + "-" + String(day).padStart(2, "0");
                  const active = calendar.some((c) => c.date === d);
                  return (
                    <button
                      key={d}
                      className={`day ${d === date ? "today" : ""} ${selected === d ? "selected" : ""}`}
                      aria-label={`${dateLabel(d)}${active ? ", 운동 기록 있음" : ""}`}
                      aria-pressed={selected === d}
                      onClick={() => {
                        setDetail(null);
                        setSelected(d);
                      }}
                    >
                      <span>{day}</span>
                      <i className={active ? "dot active" : "dot"} />
                    </button>
                  );
                })}
              </div>
              <p className="calendar-legend">
                <i className="dot active" />
                운동한 날
              </p>
            </div>
            {selected ? (
              <div className="day-detail">
                <div className="day-detail-heading">
                  <h3>{dateLabel(selected)} 기록</h3>
                  <button
                    className="text-button"
                    onClick={() => setEditor({ date: selected })}
                  >
                    <Plus size={16} />
                    추가
                  </button>
                </div>
                {detail?.date === selected ? (
                  detail.logs.length || detail.version > 0 ? (
                    <SummaryCard
                      data={detail}
                      onEdit={(log) => setEditor({ log, date: selected })}
                    />
                  ) : (
                    <div className="empty-state">
                      <p>이날은 기록된 운동이 없어요</p>
                    </div>
                  )
                ) : (
                  <p className="muted">기록을 불러오고 있어요</p>
                )}
              </div>
            ) : (
              <p className="calendar-hint">
                날짜를 눌러 그날의 운동을 확인하세요
              </p>
            )}
          </section>
        )}
      </div>
      <div className="bottom-dock">
        {unresolved && !busy && (
          <div className="request-recovery">
            <span>이전 입력의 처리 결과를 확인해 주세요.</span>
            <button
              type="button"
              onClick={() => void send(unresolved.message, unresolved)}
            >
              처리 확인·재전송
            </button>
          </div>
        )}
        {tab === "chat" && (
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send(text);
            }}
          >
            <button
              type="button"
              className="icon-button"
              aria-label="운동 직접 기록"
              disabled={busy}
              onClick={() => setEditor({ date })}
            >
              <Plus size={22} />
            </button>
            <input
              aria-label="운동 내용"
              placeholder="운동명, 무게, 횟수를 적어 주세요"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={2000}
              disabled={busy}
            />
            <button
              className="send-button"
              type="submit"
              aria-label="전송"
              disabled={busy || !!unresolved || !text.trim()}
            >
              <ArrowUp size={22} />
            </button>
          </form>
        )}
        <nav className="tab-bar" aria-label="주 메뉴">
          {(
            [
              { id: "chat", label: "채팅", Icon: MessageCircle },
              { id: "stats", label: "통계", Icon: BarChart3 },
              { id: "history", label: "기록", Icon: CalendarDays },
            ] as const
          ).map(({ id, label, Icon }) => (
            <button
              key={id}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => setTab(id)}
            >
              <Icon size={23} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      {editor && (
        <EditDialog
          editor={editor}
          onClose={() => setEditor(null)}
          onSaved={load}
        />
      )}
    </main>
  );
}
