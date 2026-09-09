import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, allLogs, messages, summary, insertLogStatements } from "@/lib/db";
import {
  dateSchema,
  exerciseSchema,
  isFinish,
  normalizeName,
  shiftDate,
  streak,
  today,
  volume,
} from "@/lib/domain";
import { feedback, interpret } from "@/lib/gemini";
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
      if (origin && origin !== req.nextUrl.origin)
        return json({ error: "허용되지 않은 요청이에요." }, 403);
    }
    const c = await db();
    if (req.method === "GET") {
      if (key === "state") {
        const date = dateSchema.parse(
          req.nextUrl.searchParams.get("date") ?? today(),
        );
        const [chat, stats] = await Promise.all([
          messages(date),
          summary(date),
        ]);
        const pending = await c.execute(
          "SELECT id,content,date FROM messages WHERE role='user' AND status='pending' ORDER BY id DESC",
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
          message: z.string().trim().min(1).max(2000),
          requestId: z.string().uuid(),
        })
        .parse(await input(req));
      const date = today();
      const now = new Date().toISOString();
      const claim = await c.execute({
        sql: "INSERT INTO requests(id,input,date,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        args: [body.requestId, body.message, date, now],
      });
      if (!claim.rowsAffected) {
        const old = (
          await c.execute({
            sql: "SELECT * FROM requests WHERE id=?",
            args: [body.requestId],
          })
        ).rows[0];
        if (old.input !== body.message)
          return json({ error: "다른 입력에 사용된 요청이에요." }, 409);
        if (old.response) return json(JSON.parse(String(old.response)));
        return json(
          { error: "입력을 처리 중이에요. 잠시 후 기록을 확인해 주세요." },
          409,
        );
      }
      // Persist the original before any external AI call.
      const user = await c.execute({
        sql: "INSERT INTO messages(role,content,status,date,created_at) VALUES(?,?,?,?,?)",
        args: ["user", body.message, "pending", date, now],
      });
      const messageId = Number(user.lastInsertRowid);
      let reply: string;
      let type = "text";
      let pending = false;
      let exercises: z.infer<typeof exerciseSchema>[] = [];
      if (isFinish(body.message)) {
        const stats = await summary(date);
        if (!stats.logs.length) reply = "오늘은 기록된 운동이 없어요.";
        else {
          const existing = await c.execute({
            sql: "SELECT finished_at FROM summaries WHERE date=?",
            args: [date],
          });
          const hasNew =
            !existing.rows.length ||
            stats.logs.some(
              (l) => l.loggedAt > String(existing.rows[0].finished_at),
            );
          if (hasNew)
            await c.execute({
              sql: "INSERT INTO summaries(date,finished_at) VALUES(?,?) ON CONFLICT(date) DO UPDATE SET finished_at=excluded.finished_at",
              args: [date, now],
            });
          reply = await feedback({
            totalVolumeKg: stats.totalVolumeKg,
            totalSets: stats.totalSets,
            cardioMinutes: stats.cardioMinutes,
            streakCount: stats.streakCount,
          });
          await c.execute({
            sql: "UPDATE summaries SET feedback=? WHERE date=?",
            args: [reply, date],
          });
          type = "summary_card";
        }
      } else {
        const names = await c.execute(
          "SELECT e.name FROM exercises e LEFT JOIN logs l ON e.id=l.exercise_id GROUP BY e.id ORDER BY MAX(l.logged_at) DESC LIMIT 40",
        );
        const result = await interpret(
          body.message,
          names.rows.map((r) => String(r.name)),
        );
        reply = result.reply;
        pending = result.pending;
        exercises = result.exercises;
      }
      const response = {
        type: type === "summary_card" ? "summary" : "reply",
        text: reply,
        logged: exercises.length > 0,
        pending,
        date,
      };
      await c.batch(
        [
          ...exercises.flatMap((ex) =>
            insertLogStatements(ex, date, body.message, messageId, now),
          ),
          {
            sql: "UPDATE messages SET status=? WHERE id=?",
            args: [
              pending ? "pending" : exercises.length ? "logged" : "done",
              messageId,
            ],
          },
          {
            sql: "INSERT INTO messages(role,content,type,status,date,created_at) VALUES(?,?,?,?,?,?)",
            args: [
              "assistant",
              reply,
              type,
              exercises.length ? "logged" : "done",
              date,
              now,
            ],
          },
          {
            sql: "UPDATE requests SET response=? WHERE id=?",
            args: [JSON.stringify(response), body.requestId],
          },
        ],
        "write",
      );
      return json(response);
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
      const tx = await c.transaction("write");
      try {
        const existing = await tx.execute({
          sql: "SELECT id FROM requests WHERE id=?",
          args: [body.requestId],
        });
        if (existing.rows.length) {
          await tx.rollback();
          return json({ ok: true });
        }
        if (body.messageId) {
          const m = await tx.execute({
            sql: "SELECT id FROM messages WHERE id=? AND date=? AND role='user' AND status='pending'",
            args: [body.messageId, body.date],
          });
          if (!m.rows.length) {
            await tx.rollback();
            return json({ error: "이미 처리된 입력이에요." }, 409);
          }
        }
        const now = new Date().toISOString();
        for (const stmt of insertLogStatements(
          body.exercise,
          body.date,
          "직접 입력",
          body.messageId ?? null,
          now,
        ))
          await tx.execute(stmt);
        if (body.messageId)
          await tx.execute({
            sql: "UPDATE messages SET status='logged' WHERE id=?",
            args: [body.messageId],
          });
        await tx.execute({
          sql: "INSERT INTO requests(id,input,date,response,created_at) VALUES(?,?,?,?,?)",
          args: [body.requestId, "manual", body.date, '{"ok":true}', now],
        });
        await tx.commit();
        return json({ ok: true });
      } finally {
        tx.close();
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
            {
              sql: "UPDATE summaries SET feedback='' WHERE date=?",
              args: [original.date],
            },
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
            {
              sql: "UPDATE summaries SET feedback='' WHERE date=?",
              args: [original.date],
            },
          ],
          "write",
        );
      }
      return json({ ok: true });
    }
    return json({ error: "페이지를 찾을 수 없어요." }, 404);
  } catch (e) {
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
