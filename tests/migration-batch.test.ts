import { test } from "node:test";
import assert from "node:assert/strict";
import { createClient, type Client } from "@libsql/client";
import { migrate } from "../lib/migrate";
import { errorDetails } from "../lib/server-errors";

async function fixture(run: (c: Client) => Promise<void>) {
  // A private in-memory database per fixture avoids Windows file-handle cleanup races.
  const c = createClient({ url: "file::memory:" });
  try {
    await c.batch(
      [
        "CREATE TABLE requests(id TEXT PRIMARY KEY,input TEXT,date TEXT,response TEXT,created_at TEXT)",
        "CREATE TABLE messages(id INTEGER PRIMARY KEY,role TEXT,content TEXT,status TEXT,date TEXT,created_at TEXT)",
        "CREATE TABLE logs(id INTEGER PRIMARY KEY,raw_text TEXT)",
        "INSERT INTO logs VALUES(1,'기존 기록 보존')",
        "INSERT INTO requests VALUES('a','같은 원문','2026-09-09',NULL,'2026-09-09T00:00:00Z')",
        "INSERT INTO requests VALUES('b','같은 원문','2026-09-09',NULL,'2026-09-09T00:00:00Z')",
      ],
      "write",
    );
    await run(c);
  } finally {
    c.close();
  }
}
test("마이그레이션은 네트워크 왕복별 트랜잭션 없이 단일 batch로 수행", () =>
  fixture(async (c) => {
    let batches = 0;
    const remoteLike = {
      execute: c.execute.bind(c),
      batch: async (...args: Parameters<Client["batch"]>) => {
        batches++;
        return c.batch(...args);
      },
      transaction: () => {
        throw new Error("Interactive transaction forbidden in migration");
      },
    } as unknown as Client;
    await migrate(remoteLike);
    assert.equal(batches, 1);
    const r = await c.execute("SELECT message_id FROM requests ORDER BY id");
    assert.notEqual(r.rows[0].message_id, r.rows[1].message_id);
    assert.equal(
      (await c.execute("SELECT COUNT(*) AS n FROM messages")).rows[0].n,
      2,
    );
    assert.equal(
      (await c.execute("SELECT raw_text FROM logs")).rows[0].raw_text,
      "기존 기록 보존",
    );
    await migrate(remoteLike);
    assert.equal(
      (await c.execute("SELECT COUNT(*) AS n FROM messages")).rows[0].n,
      2,
    );
  }));
test("동시 초기화로 이미 적용된 스키마는 재조회 후 정상 처리", () =>
  fixture(async (c) => {
    let race = true;
    const racing = {
      execute: c.execute.bind(c),
      batch: async (...args: Parameters<Client["batch"]>) => {
        if (race) {
          race = false;
          await migrate(c);
        }
        return c.batch(...args);
      },
    } as unknown as Client;
    await migrate(racing);
    assert.equal(
      (await c.execute("SELECT COUNT(*) AS n FROM messages")).rows[0].n,
      2,
    );
  }));
test("batch 중 실패하면 스키마·원문 추가도 전부 롤백", () =>
  fixture(async (c) => {
    const failing = {
      execute: c.execute.bind(c),
      batch: async (statements: Parameters<Client["batch"]>[0]) =>
        c.batch(
          [...statements, "INSERT INTO does_not_exist VALUES(1)"],
          "write",
        ),
    } as unknown as Client;
    await assert.rejects(() => migrate(failing));
    assert.equal(
      (await c.execute("PRAGMA table_info(requests)")).rows.some(
        (r) => r.name === "status",
      ),
      false,
    );
    assert.equal(
      (await c.execute("SELECT COUNT(*) AS n FROM messages")).rows[0].n,
      0,
    );
    assert.equal(
      (await c.execute("SELECT raw_text FROM logs")).rows[0].raw_text,
      "기존 기록 보존",
    );
  }));
test("서버 진단에는 비밀키·주소·원문을 포함하지 않는다", () => {
  const result = errorDetails({
    code: "SQLITE_ERROR",
    message:
      "no such table libsql://private-url secret-token private-user-text",
  });
  assert.deepEqual(result, { code: "SQLITE_ERROR", category: "schema" });
});
