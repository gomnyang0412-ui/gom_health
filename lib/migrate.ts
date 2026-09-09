import type { Client, InStatement } from "@libsql/client";
import { reportServerError } from "./server-errors";
const additions = [
  "status TEXT NOT NULL DEFAULT 'failed' CHECK(status IN ('processing','completed','failed'))",
  "kind TEXT NOT NULL DEFAULT 'chat'",
  "message_id INTEGER",
  "expires_at TEXT",
  "completed_at TEXT",
  "error_code TEXT",
];
// One server-side batch avoids Turso's short interactive transaction lifetime.
export async function migrate(c: Client) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const columns = (await c.execute("PRAGMA table_info(requests)")).rows.map(
      (r) => String(r.name),
    );
    const statements: InStatement[] = [];
    if (!columns.includes("status")) {
      const orphans = (
        await c.execute(
          `SELECT r.id FROM requests r WHERE r.response IS NULL AND r.input!='manual' AND (SELECT COUNT(*) FROM messages m WHERE m.role='user' AND m.content=r.input AND m.date=r.date AND m.created_at=r.created_at)!=1`,
        )
      ).rows;
      statements.push(
        ...additions.map(
          (column) => `ALTER TABLE requests ADD COLUMN ${column}`,
        ),
      );
      statements.push(
        `UPDATE requests SET status=CASE WHEN response IS NOT NULL THEN 'completed' ELSE 'failed' END, kind=CASE WHEN input='manual' THEN 'legacy_manual' ELSE 'chat' END, completed_at=created_at, error_code=CASE WHEN response IS NULL THEN 'LEGACY_INTERRUPTED' ELSE NULL END`,
        `UPDATE requests SET message_id=(SELECT CASE WHEN COUNT(*)=1 THEN MIN(m.id) ELSE NULL END FROM messages m WHERE m.role='user' AND m.content=requests.input AND m.date=requests.date AND m.created_at=requests.created_at) WHERE kind='chat'`,
        `UPDATE requests SET status='failed',error_code='INTERPRETATION_FAILED' WHERE status='completed' AND message_id IN (SELECT id FROM messages WHERE status='pending')`,
      );
      for (const r of orphans) {
        statements.push(
          {
            sql: "INSERT INTO messages(role,content,status,date,created_at) SELECT 'user',input,'pending',date,created_at FROM requests WHERE id=? AND status='failed' AND message_id IS NULL",
            args: [r.id],
          },
          {
            sql: "UPDATE requests SET message_id=last_insert_rowid() WHERE id=? AND message_id IS NULL",
            args: [r.id],
          },
        );
      }
    }
    statements.push(
      "CREATE TABLE IF NOT EXISTS day_state(date TEXT PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, feedback_state TEXT NOT NULL DEFAULT '')",
      "CREATE INDEX IF NOT EXISTS requests_status_expiry ON requests(status,expires_at)",
    );
    try {
      await c.batch(statements, "write");
      return;
    } catch (e) {
      // A competing cold start may have migrated since our inspection. A failed
      // batch rolls back entirely; re-read and accept only the complete schema.
      if (attempt === 0 && !columns.includes("status")) {
        const current = (
          await c.execute("PRAGMA table_info(requests)")
        ).rows.map((r) => String(r.name));
        if (additions.every((a) => current.includes(a.split(" ")[0]))) continue;
      }
      reportServerError("db_migration", e);
      throw e;
    }
  }
}
