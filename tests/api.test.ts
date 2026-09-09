import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { GET, POST, PATCH, DELETE } from "../app/api/[...path]/route";
import { db } from "../lib/db";
import { today } from "../lib/domain";
test("실제 DB: 채팅, 중복 전송, CRUD, 요약 갱신, 미기록 복구, 달력", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gom-health-test-"));
  process.env.TURSO_DATABASE_URL = pathToFileURL(join(dir, "test.db")).href;
  delete process.env.GEMINI_API_KEY;
  async function request(path: string, method = "GET", body?: unknown) {
    const fn =
      method === "POST"
        ? POST
        : method === "PATCH"
          ? PATCH
          : method === "DELETE"
            ? DELETE
            : GET;
    const res = await fn(
      new NextRequest("http://localhost/api/" + path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: body ? { "Content-Type": "application/json" } : undefined,
      }),
      { params: Promise.resolve({ path: path.split("?")[0].split("/") }) },
    );
    return { status: res.status, data: await res.json() };
  }
  try {
    const payload = {
      requestId: crypto.randomUUID(),
      message: "사이드 레터럴 레이즈 25kg x 20",
    };
    assert.equal((await request("chat", "POST", payload)).data.logged, true);
    await request("chat", "POST", payload);
    let state = (await request("state")).data;
    assert.equal(state.summary.logs.length, 1);
    assert.equal(state.summary.totalVolumeKg, 500);
    await request("chat", "POST", {
      requestId: crypto.randomUUID(),
      message: "천국의 계단 15분",
    });
    await request("chat", "POST", {
      requestId: crypto.randomUUID(),
      message: "끝",
    });
    state = (await request("state")).data;
    assert.equal(state.summary.cardioMinutes, 15);
    assert.equal(state.chat.at(-1).type, "summary_card");
    const first = state.summary.logs[0];
    await request("logs/" + first.id, "PATCH", {
      name: first.name,
      bodyPart: "어깨",
      weightKg: 30,
      reps: 20,
      sets: 2,
      durationMinutes: null,
    });
    state = (await request("state")).data;
    assert.equal(state.summary.totalVolumeKg, 1200);
    assert.equal(state.summary.feedbackText, "");
    const pending = await request("chat", "POST", {
      requestId: crypto.randomUUID(),
      message: "운동 기록 애매한 입력",
    });
    assert.equal(pending.data.pending, true);
    state = (await request("state")).data;
    const messageId = state.chat.find(
      (m: { status: string; role: string }) =>
        m.role === "user" && m.status === "pending",
    ).id;
    const manual = {
      requestId: crypto.randomUUID(),
      date: today(),
      messageId,
      exercise: {
        name: "턱걸이",
        bodyPart: "등",
        reps: 10,
        sets: 1,
        weightKg: null,
        durationMinutes: null,
      },
    };
    assert.equal((await request("logs", "POST", manual)).status, 200);
    await request("logs", "POST", manual);
    assert.equal(
      (
        await request("logs", "POST", {
          ...manual,
          requestId: crypto.randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal((await request("state")).data.summary.logs.length, 3);
    assert.equal(
      (await request("calendar?month=" + today().slice(0, 7))).data[0].count,
      3,
    );
    assert.equal((await request("summary/2026-02-30")).status, 400);
    assert.equal(
      (
        await request("logs/" + first.id, "PATCH", {
          ...manual.exercise,
          reps: 0,
        })
      ).status,
      400,
    );
    await request("logs/" + first.id, "DELETE");
    assert.equal((await request("state")).data.summary.totalVolumeKg, 0);
    assert.equal((await request("logs/" + first.id, "DELETE")).status, 404);
  } finally {
    (await db()).close();
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  }
});
