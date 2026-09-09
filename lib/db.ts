import { createClient, type Client, type InStatement } from "@libsql/client";
import {
  normalizeName,
  streak,
  volume,
  type Log,
  type Message,
  type Summary,
  type Exercise,
} from "./domain";
import { migrate } from "./migrate";
import { UPDATED_FEEDBACK } from "./domain";
export type Executor = Pick<Client, "execute">;
let client: Client;
let ready: Promise<unknown> | undefined;
export async function db() {
  if (!client) {
    if (
      process.env.GOM_TEST_MODE === "1" &&
      (!process.env.TURSO_DATABASE_URL?.startsWith("file:") ||
        process.env.TURSO_AUTH_TOKEN)
    )
      throw new Error("TEST_DATABASE_REQUIRED");
    const url =
      process.env.TURSO_DATABASE_URL ||
      (process.env.VERCEL ? "" : "file:local.db");
    if (!url) throw new Error("TURSO_NOT_CONFIGURED");
    client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  if (!ready)
    ready = client
      .batch(
        [
          `CREATE TABLE IF NOT EXISTS exercises(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, body_part TEXT NOT NULL)`,
          `CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, role TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'text', status TEXT NOT NULL DEFAULT 'done', date TEXT NOT NULL, created_at TEXT NOT NULL)`,
          `CREATE TABLE IF NOT EXISTS logs(id INTEGER PRIMARY KEY, exercise_id INTEGER NOT NULL REFERENCES exercises(id), body_part TEXT NOT NULL, weight REAL, reps INTEGER, sets INTEGER NOT NULL CHECK(sets>0), minutes REAL, date TEXT NOT NULL, logged_at TEXT NOT NULL, raw_text TEXT NOT NULL, message_id INTEGER REFERENCES messages(id))`,
          `CREATE INDEX IF NOT EXISTS logs_date ON logs(date)`,
          `CREATE INDEX IF NOT EXISTS logs_exercise ON logs(exercise_id,date)`,
          `CREATE TABLE IF NOT EXISTS summaries(date TEXT PRIMARY KEY, finished_at TEXT NOT NULL, feedback TEXT NOT NULL DEFAULT '')`,
          `CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, input TEXT NOT NULL, date TEXT NOT NULL, response TEXT, created_at TEXT NOT NULL)`,
        ],
        "write",
      )
      .then(() => migrate(client))
      .catch((e) => {
        ready = undefined;
        throw e;
      });
  await ready;
  return client;
}
export async function allLogs(
  date?: string,
  executor?: Executor,
): Promise<Log[]> {
  const c = executor ?? (await db());
  const r = await c.execute({
    sql: `SELECT l.*,e.name FROM logs l JOIN exercises e ON e.id=l.exercise_id ${date ? "WHERE l.date=?" : ""} ORDER BY l.logged_at,l.id`,
    args: date ? [date] : [],
  });
  return r.rows.map((r) => ({
    id: Number(r.id),
    exerciseId: Number(r.exercise_id),
    name: String(r.name),
    bodyPart: r.body_part as Log["bodyPart"],
    weightKg: r.weight === null ? null : Number(r.weight),
    reps: r.reps === null ? null : Number(r.reps),
    sets: Number(r.sets),
    durationMinutes: r.minutes === null ? null : Number(r.minutes),
    date: String(r.date),
    loggedAt: String(r.logged_at),
    rawText: String(r.raw_text),
  }));
}
export async function messages(date: string): Promise<Message[]> {
  const c = await db();
  const r = await c.execute({
    sql: "SELECT m.*, CASE WHEN EXISTS(SELECT 1 FROM requests r WHERE r.message_id=m.id AND r.status='processing') THEN 'processing' ELSE m.status END AS visible_status FROM messages m WHERE date=? AND (type!='summary_card' OR id=(SELECT MAX(id) FROM messages WHERE date=? AND type='summary_card')) ORDER BY id",
    args: [date, date],
  });
  return r.rows.map((r) => ({
    id: Number(r.id),
    role: r.role as Message["role"],
    content: String(r.content),
    type: String(r.type),
    status: String(r.visible_status),
    date: String(r.date),
  }));
}
export async function summary(
  date: string,
  executor?: Executor,
): Promise<Summary> {
  if (!executor) {
    const tx = await (await db()).transaction("read");
    try {
      const result = await summary(date, tx);
      await tx.commit();
      return result;
    } finally {
      tx.close();
    }
  }
  const c = executor;
  const logs = await allLogs(date, c);
  const state = (
    await c.execute({
      sql: "SELECT * FROM day_state WHERE date=?",
      args: [date],
    })
  ).rows[0];
  const [days, finished] = await Promise.all([
    c.execute("SELECT DISTINCT date FROM logs"),
    c.execute({ sql: "SELECT * FROM summaries WHERE date=?", args: [date] }),
  ]);
  const end = finished.rows[0]?.finished_at;
  const last = logs.at(-1)?.loggedAt;
  const duration = logs.length
    ? Math.max(
        0,
        Math.round(
          (Date.parse(String(end ?? last)) - Date.parse(logs[0].loggedAt)) /
            60000,
        ),
      )
    : 0;
  return {
    date,
    version: Number(state?.version ?? 0),
    logs,
    totalVolumeKg: logs.reduce((n, l) => n + volume(l), 0),
    totalSets: logs
      .filter((l) => l.bodyPart !== "유산소")
      .reduce((n, l) => n + l.sets, 0),
    cardioMinutes: logs.reduce((n, l) => n + (l.durationMinutes ?? 0), 0),
    durationMinutes: duration,
    streakCount: streak(
      days.rows.map((r) => String(r.date)),
      date,
    ),
    feedbackText:
      state?.feedback_state === "changed"
        ? UPDATED_FEEDBACK
        : String(finished.rows[0]?.feedback ?? ""),
  };
}
export function insertLogStatements(
  ex: Exercise,
  date: string,
  raw: string,
  messageId: number | null,
  now: string,
): InStatement[] {
  const key = normalizeName(ex.name);
  return [
    {
      sql: "INSERT INTO exercises(name,name_key,body_part) VALUES(?,?,?) ON CONFLICT(name_key) DO NOTHING",
      args: [ex.name, key, ex.bodyPart],
    },
    {
      sql: "INSERT INTO logs(exercise_id,body_part,weight,reps,sets,minutes,date,logged_at,raw_text,message_id) VALUES((SELECT id FROM exercises WHERE name_key=?),?,?,?,?,?,?,?,?,?)",
      args: [
        key,
        ex.bodyPart,
        ex.weightKg,
        ex.reps,
        ex.sets,
        ex.durationMinutes,
        date,
        now,
        raw,
        messageId,
      ],
    },
    ...invalidateStatements(date),
  ];
}

export function invalidateStatements(date: string): InStatement[] {
  return [
    {
      sql: "INSERT INTO day_state(date,version,feedback_state) VALUES(?,1,'changed') ON CONFLICT(date) DO UPDATE SET version=version+1,feedback_state='changed'",
      args: [date],
    },
    { sql: "UPDATE summaries SET feedback='' WHERE date=?", args: [date] },
  ];
}
