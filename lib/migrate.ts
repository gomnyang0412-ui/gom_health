import type { Client } from "@libsql/client";

// Additive, transactional migration. Never rewrite or delete existing exercise logs.
export async function migrate(c: Client) {
  const tx = await c.transaction("write");
  try {
    const columns = (await tx.execute("PRAGMA table_info(requests)")).rows.map(
      (r) => String(r.name),
    );
    if (!columns.includes("status")) {
      for (const column of [
        "status TEXT NOT NULL DEFAULT 'failed' CHECK(status IN ('processing','completed','failed'))",
        "kind TEXT NOT NULL DEFAULT 'chat'",
        "message_id INTEGER",
        "expires_at TEXT",
        "completed_at TEXT",
        "error_code TEXT",
      ])
        await tx.execute(`ALTER TABLE requests ADD COLUMN ${column}`);
      await tx.execute(
        `UPDATE requests SET status=CASE WHEN response IS NOT NULL THEN 'completed' ELSE 'failed' END, kind=CASE WHEN input='manual' THEN 'legacy_manual' ELSE 'chat' END, completed_at=created_at, error_code=CASE WHEN response IS NULL THEN 'LEGACY_INTERRUPTED' ELSE NULL END`,
      );
      // Only associate a legacy message when the original timestamp/content match uniquely.
      await tx.execute(
        `UPDATE requests SET message_id=(SELECT MIN(m.id) FROM messages m WHERE m.role='user' AND m.content=requests.input AND m.date=requests.date AND m.created_at=requests.created_at HAVING COUNT(*)=1) WHERE kind='chat'`,
      );
      await tx.execute(
        `UPDATE requests SET status='failed',error_code='INTERPRETATION_FAILED' WHERE status='completed' AND message_id IN (SELECT id FROM messages WHERE status='pending')`,
      );
      const orphans = (
        await tx.execute(
          "SELECT * FROM requests WHERE kind='chat' AND status='failed' AND message_id IS NULL",
        )
      ).rows;
      for (const r of orphans) {
        const m = await tx.execute({
          sql: "INSERT INTO messages(role,content,status,date,created_at) VALUES('user',?,'pending',?,?)",
          args: [r.input, r.date, r.created_at],
        });
        await tx.execute({
          sql: "UPDATE requests SET message_id=? WHERE id=?",
          args: [m.lastInsertRowid!, r.id],
        });
      }
    }
    await tx.execute(
      "CREATE TABLE IF NOT EXISTS day_state(date TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, feedback_state TEXT NOT NULL DEFAULT '')",
    );
    await tx.execute(
      "CREATE INDEX IF NOT EXISTS requests_status_expiry ON requests(status,expires_at)",
    );
    await tx.commit();
  } finally {
    tx.close();
  }
}
