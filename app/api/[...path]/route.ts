import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  db,
  allLogs,
  messages,
  summary,
  insertLogStatements,
  invalidateStatements,
} from "@/lib/db";
import {
  dateSchema,
  exerciseSchema,
  isFinish,
  normalizeName,
  shiftDate,
  streak,
  today,
  volume,
  savedReply,
  UPDATED_FEEDBACK,
} from "@/lib/domain";
import { feedback, interpret } from "@/lib/gemini";
import { reportServerError } from "@/lib/server-errors";
import {
  beginRequest,
  completeRequest,
  failRequest,
  requestState,
  expireRequests,
  RequestConflict,
  view,
} from "@/lib/requests";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
type Context = { params: Promise<{ path: string[] }> };
const json = (data: unknown, status = 200) =>
  NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
async function input(req: NextRequest) {
  if (Number(req.headers.get("content-length") ?? 0) > 16000)
    throw new Error("TOO_LARGE");
  const text = await req.text();
  if (text.length > 16000) throw new Error("TOO_LARGE");
  return JSON.parse(text);
}
async function handle(req: NextRequest, ctx: Context) {
  try {
    const path = (await ctx.params).path;
    const key = path.join("/");
    if (req.method !== "GET") {
      const origin = req.headers.get("origin");
      // Next.js may construct nextUrl using an internal localhost hostname.
      // Compare against the actual HTTP Host, never an arbitrary forwarded host.
      if (
        origin &&
        new URL(origin).host !== (req.headers.get("host") ?? req.nextUrl.host)
      )
        return json({ error: "허용되지 않은 요청이에요." }, 403);
    }
    const c = await db();
    if (req.method === "GET") {
      await expireRequests();
      if (path[0] === "requests" && path.length === 2) {
        const state = await requestState(z.string().uuid().parse(path[1]));
        return state
          ? json(state)
          : json({ error: "요청을 찾을 수 없어요." }, 404);
      }
      if (key === "state") {
        const date = dateSchema.parse(
          req.nextUrl.searchParams.get("date") ?? today(),
        );
        const [chat, stats] = await Promise.all([
          messages(date),
          summary(date),
        ]);
        const pending = await c.execute(
          "SELECT id,content,date FROM messages m WHERE role='user' AND status='pending' AND NOT EXISTS(SELECT 1 FROM requests r WHERE r.message_id=m.id AND r.status='processing') ORDER BY id DESC",
        );
        return json({ date, chat, summary: stats, pending: pending.rows });
      }
      if (key === "exercises") {
        const logs = await allLogs();
        const dates = [...new Set(logs.map((l) => l.date))];
        const now = today();
        const day = new Date(now + "T00:00:00Z").getUTCDay();
        const week = shiftDate(now, -((day + 6) % 7));
        return json({
          logs,
          weekVolume: logs
            .filter((l) => l.date >= week && l.date <= now)
            .reduce((n, l) => n + volume(l), 0),
          monthDays: dates.filter((d) => d.startsWith(now.slice(0, 7))).length,
          streak: streak(dates, dates.includes(now) ? now : shiftDate(now, -1)),
        });
      }
      if (path[0] === "exercises" && path[2] === "history") {
        const id = z.coerce.number().int().positive().parse(path[1]);
        const logs = (await allLogs()).filter((l) => l.exerciseId === id);
        return json(
          [...new Set(logs.map((l) => l.date))].map((date) => {
            const rows = logs.filter((l) => l.date === date);
            return {
              date,
              weightKg: Math.max(...rows.map((l) => l.weightKg ?? 0)),
              volumeKg: rows.reduce((n, l) => n + volume(l), 0),
              durationMinutes: rows.reduce(
                (n, l) => n + (l.durationMinutes ?? 0),
                0,
              ),
              reps: rows.reduce((n, l) => n + (l.reps ?? 0) * l.sets, 0),
            };
          }),
        );
      }
      if (key === "calendar") {
        const month = z
          .string()
          .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
          .parse(req.nextUrl.searchParams.get("month"));
        const r = await c.execute({
          sql: "SELECT date,COUNT(*) AS count FROM logs WHERE date LIKE ? GROUP BY date",
          args: [month + "-%"],
        });
        return json(r.rows);
      }
      if (path[0] === "summary" && path.length === 2)
        return json(await summary(dateSchema.parse(path[1])));
    }
    if (key === "chat" && req.method === "POST") {
      const body = z
        .object({
          message: z
            .string()
            .min(1)
            .max(2000)
            .refine((value) => value.trim().length > 0),
          requestId: z.string().uuid(),
        })
        .parse(await input(req));
      const claim = await beginRequest(
        body.requestId,
        "chat",
        body.message,
        today(),
        body.message,
      );
      if (!claim.fresh) return json(view(claim.row));
      const date = String(claim.row.date);
      try {
        if (isFinish(body.message)) {
          const stats = await summary(date);
          const text = stats.logs.length
            ? await feedback({
                totalVolumeKg: stats.totalVolumeKg,
                totalSets: stats.totalSets,
                cardioMinutes: stats.cardioMinutes,
                streakCount: stats.streakCount,
              })
            : "오늘은 기록된 운동이 없어요.";
          return json(
            await completeRequest(body.requestId, async (tx) => {
              const current = await summary(date, tx);
              const changed = current.version !== stats.version;
              const reply = changed ? UPDATED_FEEDBACK : text;
              if (!changed && stats.logs.length) {
                await tx.execute({
                  sql: "INSERT INTO summaries(date,finished_at,feedback) VALUES(?,?,?) ON CONFLICT(date) DO UPDATE SET finished_at=excluded.finished_at,feedback=excluded.feedback",
                  args: [date, new Date().toISOString(), reply],
                });
                await tx.execute({
                  sql: "UPDATE day_state SET feedback_state='' WHERE date=?",
                  args: [date],
                });
              }
              return {
                type: current.logs.length || changed ? "summary_card" : "text",
                result: {
                  type: current.logs.length || changed ? "summary" : "reply",
                  text: reply,
                  date,
                  summary: await summary(date, tx),
                },
              };
            }),
          );
        }
        const names = await c.execute(
          "SELECT e.name,e.body_part FROM exercises e LEFT JOIN logs l ON e.id=l.exercise_id GROUP BY e.id ORDER BY MAX(l.logged_at) DESC",
        );
        const parsed = await interpret(
          body.message,
          names.rows.map((r) => ({
            name: String(r.name),
            bodyPart: String(r.body_part),
          })),
        );
        return json(
          await completeRequest(body.requestId, async (tx, row) => {
            const saved = [];
            for (const ex of parsed.exercises) {
              for (const stmt of insertLogStatements(
                ex,
                date,
                body.message,
                Number(row.message_id),
                String(row.created_at),
              ))
                await tx.execute(stmt);
              const canonical = (
                await tx.execute({
                  sql: "SELECT name FROM exercises WHERE name_key=?",
                  args: [normalizeName(ex.name)],
                })
              ).rows[0];
              saved.push({ ...ex, name: String(canonical.name) });
            }
            return {
              failed: parsed.pending,
              errorCode: parsed.pending ? "INTERPRETATION_FAILED" : undefined,
              result: {
                type: "reply",
                text: saved.length ? savedReply(saved) : parsed.reply,
                logged: saved.length > 0,
                pending: parsed.pending,
                date,
                exercises: saved,
              },
            };
          }),
        );
      } catch {
        return json(await failRequest(body.requestId));
      }
    }
    if (key === "logs" && req.method === "POST") {
      const body = z
        .object({
          exercise: exerciseSchema,
          date: dateSchema,
          messageId: z.number().int().positive().optional(),
          requestId: z.string().uuid(),
        })
        .parse(await input(req));
      const payload = JSON.stringify({
        exercise: body.exercise,
        date: body.date,
        messageId: body.messageId ?? null,
      });
      const claim = await beginRequest(
        body.requestId,
        "manual",
        payload,
        body.date,
        savedReply([body.exercise]),
      );
      if (!claim.fresh) return json(view(claim.row));
      try {
        return json(
          await completeRequest(body.requestId, async (tx, row) => {
            let raw = "직접 입력";
            if (body.messageId) {
              const original = (
                await tx.execute({
                  sql: "SELECT * FROM messages WHERE id=? AND date=? AND role='user' AND status='pending'",
                  args: [body.messageId, body.date],
                })
              ).rows[0];
              const active = await tx.execute({
                sql: "SELECT id FROM requests WHERE message_id=? AND status='processing'",
                args: [body.messageId],
              });
              if (!original || active.rows.length)
                return {
                  failed: true,
                  errorCode: "ALREADY_HANDLED",
                  result: {
                    text: "이미 처리됐거나 처리 중인 입력이에요.",
                    pending: false,
                  },
                };
              raw = String(original.content);
              await tx.execute({
                sql: "UPDATE messages SET status='logged' WHERE id=?",
                args: [body.messageId],
              });
            }
            for (const stmt of insertLogStatements(
              body.exercise,
              body.date,
              raw,
              body.messageId ?? Number(row.message_id),
              String(row.created_at),
            ))
              await tx.execute(stmt);
            const canonical = (
              await tx.execute({
                sql: "SELECT name FROM exercises WHERE name_key=?",
                args: [normalizeName(body.exercise.name)],
              })
            ).rows[0];
            return {
              result: {
                ok: true,
                logged: true,
                text: savedReply([
                  { ...body.exercise, name: String(canonical.name) },
                ]),
                summary: await summary(body.date, tx),
              },
            };
          }),
        );
      } catch {
        return json(await failRequest(body.requestId));
      }
    }

    if (
      path[0] === "logs" &&
      path.length === 2 &&
      (req.method === "PATCH" || req.method === "DELETE")
    ) {
      const id = z.coerce.number().int().positive().parse(path[1]);
      const original = (
        await c.execute({ sql: "SELECT * FROM logs WHERE id=?", args: [id] })
      ).rows[0];
      if (!original) return json({ error: "기록을 찾을 수 없어요." }, 404);
      if (req.method === "DELETE") {
        await c.batch(
          [
            { sql: "DELETE FROM logs WHERE id=?", args: [id] },
            ...invalidateStatements(String(original.date)),
          ],
          "write",
        );
      } else {
        const ex = exerciseSchema.parse(await input(req));
        await c.batch(
          [
            {
              sql: "INSERT INTO exercises(name,name_key,body_part) VALUES(?,?,?) ON CONFLICT(name_key) DO NOTHING",
              args: [ex.name, normalizeName(ex.name), ex.bodyPart],
            },
            {
              sql: "UPDATE logs SET exercise_id=(SELECT id FROM exercises WHERE name_key=?),body_part=?,weight=?,reps=?,sets=?,minutes=? WHERE id=?",
              args: [
                normalizeName(ex.name),
                ex.bodyPart,
                ex.weightKg,
                ex.reps,
                ex.sets,
                ex.durationMinutes,
                id,
              ],
            },
            ...invalidateStatements(String(original.date)),
          ],
          "write",
        );
      }
      return json({ ok: true, summary: await summary(String(original.date)) });
    }
    return json({ error: "페이지를 찾을 수 없어요." }, 404);
  } catch (e) {
    reportServerError("api_request", e);
    if (e instanceof RequestConflict) return json({ error: e.message }, 409);
    if (e instanceof z.ZodError)
      return json(
        { error: e.issues[0]?.message ?? "입력값을 확인해 주세요." },
        400,
      );
    if (e instanceof SyntaxError)
      return json({ error: "입력 형식을 확인해 주세요." }, 400);
    return json(
      {
        error:
          e instanceof Error && e.message === "TURSO_NOT_CONFIGURED"
            ? "저장소 연결 설정이 필요해요."
            : "요청을 완료하지 못했어요. 잠시 후 다시 확인해 주세요.",
      },
      503,
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const DELETE = handle;
