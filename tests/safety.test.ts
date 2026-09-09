import { test } from "node:test";
import assert from "node:assert/strict";
import { db } from "../lib/db";
test("테스트 모드에서 원격 DB와 운영 토큰을 사용하지 못한다", async () => {
  process.env.GOM_TEST_MODE = "1";
  process.env.TURSO_DATABASE_URL = "libsql://not-a-real-test.example";
  await assert.rejects(() => db(), /TEST_DATABASE_REQUIRED/);
  process.env.TURSO_DATABASE_URL = "file:never-created.db";
  process.env.TURSO_AUTH_TOKEN = "fake-token";
  await assert.rejects(() => db(), /TEST_DATABASE_REQUIRED/);
});
