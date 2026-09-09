import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NextRequest } from "next/server";
import { createClient } from "@libsql/client";
import { GET, POST, PATCH, DELETE } from "../app/api/[...path]/route";
import { db, allLogs, summary, insertLogStatements, messages } from "../lib/db";
import { beginRequest, completeRequest, requestState } from "../lib/requests";
import { migrate } from "../lib/migrate";
import {
  today,
  shiftDate,
  UPDATED_FEEDBACK,
  exerciseSchema,
} from "../lib/domain";

test("독립 테스트 DB의 요청 복구·날짜·마이그레이션 검증", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "gom-reliability-"));
  process.env.GOM_TEST_MODE = "1";
  process.env.TURSO_DATABASE_URL = pathToFileURL(join(dir, "test.db")).href;
  delete process.env.TURSO_AUTH_TOKEN;
  delete process.env.GEMINI_API_KEY;
  const originalFetch = globalThis.fetch;
  const c = await db();
  const date = today();
  const yesterday = shiftDate(date, -1);
  async function req(path: string, method = "GET", body?: unknown) {
    const handler =
      method === "POST"
        ? POST
        : method === "PATCH"
          ? PATCH
          : method === "DELETE"
            ? DELETE
            : GET;
    const r = await handler(
      new NextRequest("http://localhost/api/" + path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      }),
      { params: Promise.resolve({ path: path.split("?")[0].split("/") }) },
    );
    return { code: r.status, body: await r.json() };
  }
  const chat = (message: string, requestId = crypto.randomUUID()) =>
    req("chat", "POST", { message, requestId });
  try {
    await t.test(
      "실제 Host의 동일 출처는 허용하고 다른 출처는 차단",
      async () => {
        for (const [origin, expected] of [
          ["http://127.0.0.1:3100", 200],
          ["https://other.example", 403],
        ] as const) {
          const r = await POST(
            new NextRequest("http://localhost:3100/api/chat", {
              method: "POST",
              headers: {
                host: "127.0.0.1:3100",
                origin,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                message: "끝",
                requestId: crypto.randomUUID(),
              }),
            }),
            { params: Promise.resolve({ path: ["chat"] }) },
          );
          assert.equal(r.status, expected);
        }
      },
    );
    await t.test(
      "새 ID의 동일 문장은 각각 저장하고 완료 ID는 원래 결과 반환",
      async () => {
        const id = crypto.randomUUID();
        const a = await chat("벤치프레스 20kg x 10", id);
        assert.equal(a.body.status, "completed");
        assert.match(a.body.result.text, /20kg × 10회 · 1세트/);
        assert.deepEqual((await chat("벤치프레스 20kg x 10", id)).body, a.body);
        await chat("벤치프레스 20kg x 10");
        assert.equal((await allLogs()).length, 2);
        assert.equal((await chat("벤치프레스 30kg x 10", id)).code, 409);
      },
    );
    await t.test(
      "처리 중 재전송은 조회만 하고 날짜를 다시 정하지 않는다",
      async () => {
        const id = crypto.randomUUID();
        await beginRequest(
          id,
          "chat",
          "벤치프레스 20kg x 10",
          yesterday,
          "벤치프레스 20kg x 10",
        );
        const n = (await allLogs()).length;
        const r = await chat("벤치프레스 20kg x 10", id);
        assert.equal(r.body.status, "processing");
        assert.equal(r.body.date, yesterday);
        assert.equal((await allLogs()).length, n);
      },
    );
    await t.test("접수 트랜잭션 실패는 요청만 남기지 않는다", async () => {
      await c.execute(
        "CREATE TRIGGER reject_message BEFORE INSERT ON messages WHEN NEW.content='접수 오류' BEGIN SELECT RAISE(ABORT,'test'); END",
      );
      const id = crypto.randomUUID();
      await assert.rejects(() =>
        beginRequest(id, "chat", "접수 오류", date, "접수 오류"),
      );
      assert.equal(await requestState(id), null);
      await c.execute("DROP TRIGGER reject_message");
    });
    await t.test("부분 저장을 롤백하고 원문을 보존한다", async () => {
      const id = crypto.randomUUID();
      const claim = await beginRequest(
        id,
        "chat",
        "원문 보존",
        date,
        "원문 보존",
      );
      const n = (await allLogs()).length;
      await assert.rejects(() =>
        completeRequest(id, async (tx) => {
          for (const stmt of insertLogStatements(
            exerciseSchema.parse({
              name: "테스트 운동",
              bodyPart: "기타",
              reps: 10,
            }),
            date,
            "원문 보존",
            Number(claim.row.message_id),
            new Date().toISOString(),
          ))
            await tx.execute(stmt);
          throw new Error("interrupt");
        }),
      );
      assert.equal((await allLogs()).length, n);
      assert.equal((await requestState(id))?.status, "processing");
      assert.equal(
        (
          await c.execute({
            sql: "SELECT content FROM messages WHERE id=?",
            args: [claim.row.message_id],
          })
        ).rows[0].content,
        "원문 보존",
      );
    });
    await t.test(
      "만료 후 늦은 작업은 실행되지 않으며 직접 기록 복구는 한 번만 저장",
      async () => {
        const id = crypto.randomUUID();
        const claim = await beginRequest(
          id,
          "chat",
          "중단된 원문",
          yesterday,
          "중단된 원문",
        );
        await c.execute({
          sql: "UPDATE requests SET expires_at=? WHERE id=?",
          args: ["2000-01-01T00:00:00.000Z", id],
        });
        assert.equal((await requestState(id))?.status, "failed");
        let called = false;
        await completeRequest(id, async () => {
          called = true;
          return { result: {} };
        });
        assert.equal(called, false);
        const body = {
          requestId: crypto.randomUUID(),
          messageId: Number(claim.row.message_id),
          date: yesterday,
          exercise: {
            name: "턱걸이",
            bodyPart: "등",
            reps: 10,
            sets: 1,
            weightKg: null,
            durationMinutes: null,
          },
        };
        const a = await req("logs", "POST", body);
        assert.equal(a.body.status, "completed");
        assert.deepEqual((await req("logs", "POST", body)).body, a.body);
        assert.equal(
          (
            await req("logs", "POST", {
              ...body,
              requestId: crypto.randomUUID(),
            })
          ).body.status,
          "failed",
        );
        const logs = await allLogs(yesterday);
        assert.equal(logs.length, 1);
        assert.equal(logs[0].rawText, "중단된 원문");
        assert.equal(
          (
            await req("logs", "POST", {
              ...body,
              exercise: { ...body.exercise, reps: 20 },
            })
          ).code,
          409,
        );
      },
    );
    await t.test("처리 중 원문의 직접 복구는 차단한다", async () => {
      const claim = await beginRequest(
        crypto.randomUUID(),
        "chat",
        "아직 처리 중",
        date,
        "아직 처리 중",
      );
      const r = await req("logs", "POST", {
        requestId: crypto.randomUUID(),
        date,
        messageId: Number(claim.row.message_id),
        exercise: { name: "턱걸이", bodyPart: "등", reps: 10 },
      });
      assert.equal(r.body.status, "failed");
    });
    await t.test("양방향 필드 검증과 다중 AI 결과의 전체 롤백", async () => {
      assert.equal(
        exerciseSchema.safeParse({
          name: "벤치",
          bodyPart: "가슴",
          reps: 10,
          durationMinutes: 5,
        }).success,
        false,
      );
      assert.equal(
        exerciseSchema.safeParse({
          name: "달리기",
          bodyPart: "유산소",
          durationMinutes: 10,
          reps: 10,
        }).success,
        false,
      );
      process.env.GEMINI_API_KEY = "fake-test";
      process.env.GEMINI_MODELS = "test";
      globalThis.fetch = async () =>
        Response.json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: "log_exercise",
                      args: { name: "벤치", bodyPart: "가슴", reps: 10 },
                    },
                  },
                  {
                    functionCall: {
                      name: "log_exercise",
                      args: {
                        name: "벤치",
                        bodyPart: "가슴",
                        reps: 10,
                        durationMinutes: 5,
                      },
                    },
                  },
                ],
              },
            },
          ],
        });
      const n = (await allLogs()).length;
      const r = await chat("AI 검증 실패 원문");
      assert.equal(r.body.status, "failed");
      assert.equal((await allLogs()).length, n);
      delete process.env.GEMINI_API_KEY;
      globalThis.fetch = originalFetch;
    });
    await t.test("날짜별 요약 하나와 수정·삭제 후 피드백 무효화", async () => {
      await chat("끝");
      await chat("끝");
      assert.equal(
        (await messages(date)).filter((m) => m.type === "summary_card").length,
        1,
      );
      const before = await summary(yesterday);
      const l = (await allLogs(date))[0];
      const r = await req("logs/" + l.id, "PATCH", {
        name: l.name,
        bodyPart: l.bodyPart,
        weightKg: 30,
        reps: 10,
        sets: 2,
        durationMinutes: null,
      });
      assert.equal(r.body.summary.totalVolumeKg, 800);
      assert.equal(r.body.summary.feedbackText, UPDATED_FEEDBACK);
      assert.deepEqual(await summary(yesterday), before);
      await chat("끝");
      assert.notEqual((await summary(date)).feedbackText, UPDATED_FEEDBACK);
      for (const l of await allLogs(date)) await req("logs/" + l.id, "DELETE");
      const empty = await summary(date);
      assert.equal(empty.totalVolumeKg, 0);
      assert.equal(empty.totalSets, 0);
      assert.equal(empty.feedbackText, UPDATED_FEEDBACK);
      assert.equal((await allLogs(yesterday)).length, 1);
    });
    await t.test(
      "AI 피드백 생성 중 수정되면 오래된 피드백을 저장하지 않는다",
      async () => {
        await chat("벤치프레스 20kg x 10");
        process.env.GEMINI_API_KEY = "fake-test";
        process.env.GEMINI_MODELS = "test";
        let release!: (r: Response) => void;
        let entered!: () => void;
        const started = new Promise<void>((r) => (entered = r));
        globalThis.fetch = async () => {
          entered();
          return new Promise<Response>((r) => (release = r));
        };
        const finishing = chat("끝");
        await started;
        const l = (await allLogs(date))[0];
        await req("logs/" + l.id, "PATCH", {
          name: l.name,
          bodyPart: "가슴",
          weightKg: 40,
          reps: 10,
          sets: 1,
          durationMinutes: null,
        });
        release(
          Response.json({
            candidates: [{ content: { parts: [{ text: "오래된 피드백" }] } }],
          }),
        );
        await finishing;
        assert.equal((await summary(date)).feedbackText, UPDATED_FEEDBACK);
        delete process.env.GEMINI_API_KEY;
        globalThis.fetch = originalFetch;
      },
    );
    await t.test(
      "AI 실행 중 같은 ID 동시 요청은 호출과 저장을 추가하지 않는다",
      async () => {
        process.env.GEMINI_API_KEY = "fake-test";
        process.env.GEMINI_MODELS = "test";
        let release!: (r: Response) => void;
        let entered!: () => void;
        let calls = 0;
        const started = new Promise<void>((r) => (entered = r));
        globalThis.fetch = async () => {
          calls++;
          entered();
          return new Promise<Response>((r) => (release = r));
        };
        const id = crypto.randomUUID();
        const n = (await allLogs()).length;
        const first = chat("동시 요청", id);
        await started;
        const second = await chat("동시 요청", id);
        assert.equal(second.body.status, "processing");
        release(
          Response.json({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        name: "log_exercise",
                        args: { name: "동시 운동", bodyPart: "기타", reps: 10 },
                      },
                    },
                  ],
                },
              },
            ],
          }),
        );
        await first;
        assert.equal(calls, 1);
        assert.equal((await allLogs()).length, n + 1);
        delete process.env.GEMINI_API_KEY;
        globalThis.fetch = originalFetch;
      },
    );
    await t.test(
      "기존 스키마 마이그레이션을 반복해도 기존 운동과 원문 보존",
      async () => {
        const old = createClient({
          url: pathToFileURL(join(dir, "legacy.db")).href,
        });
        try {
          await old.batch(
            [
              "CREATE TABLE requests(id TEXT PRIMARY KEY,input TEXT,date TEXT,response TEXT,created_at TEXT)",
              "CREATE TABLE messages(id INTEGER PRIMARY KEY,role TEXT,content TEXT,status TEXT,date TEXT,created_at TEXT)",
              "CREATE TABLE logs(id INTEGER PRIMARY KEY,raw_text TEXT)",
              "INSERT INTO logs VALUES(1,'기존 기록')",
              "INSERT INTO requests VALUES('legacy','미완료 원문','2026-09-08',NULL,'2026-09-08T00:00:00Z')",
              "INSERT INTO requests VALUES('done','완료 원문','2026-09-08','{\"logged\":true}','2026-09-08T00:00:00Z')",
            ],
            "write",
          );
          await migrate(old);
          await migrate(old);
          assert.equal(
            (await old.execute("SELECT * FROM logs")).rows[0].raw_text,
            "기존 기록",
          );
          assert.equal(
            (await old.execute("SELECT status FROM requests WHERE id='done'"))
              .rows[0].status,
            "completed",
          );
          assert.equal(
            (await old.execute("SELECT status FROM requests WHERE id='legacy'"))
              .rows[0].status,
            "failed",
          );
          assert.equal(
            (await old.execute("SELECT COUNT(*) AS n FROM messages")).rows[0].n,
            1,
          );
        } finally {
          old.close();
        }
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    c.close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 200,
    });
  }
});
