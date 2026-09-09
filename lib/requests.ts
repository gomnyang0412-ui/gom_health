import type { Transaction, Row } from "@libsql/client";
import { db } from "./db";

export const REQUEST_LIFETIME_MS = 90000;
export class RequestConflict extends Error {}
export type RequestResult = {
  requestId: string;
  status: "processing" | "completed" | "failed";
  date: string;
  result: Record<string, unknown> | null;
  errorCode: string | null;
};
export function view(r: Row): RequestResult {
  return {
    requestId: String(r.id),
    status: r.status as RequestResult["status"],
    date: String(r.date),
    result: r.response ? JSON.parse(String(r.response)) : null,
    errorCode: r.error_code ? String(r.error_code) : null,
  };
}
export async function expireRequests() {
  const c = await db();
  await c.execute({
    sql: "UPDATE requests SET status='failed',error_code='PROCESSING_EXPIRED',completed_at=?,response=? WHERE status='processing' AND expires_at<=?",
    args: [
      new Date().toISOString(),
      JSON.stringify({
        text: "처리가 중단됐어요. 원문은 보관했으니 직접 기록해 주세요.",
        pending: true,
      }),
      new Date().toISOString(),
    ],
  });
}
export async function requestState(id: string) {
  await expireRequests();
  const r = (
    await (
      await db()
    ).execute({ sql: "SELECT * FROM requests WHERE id=?", args: [id] })
  ).rows[0];
  return r ? view(r) : null;
}
export async function beginRequest(
  id: string,
  kind: string,
  input: string,
  date: string,
  raw: string,
) {
  await expireRequests();
  const tx = await (await db()).transaction("write");
  try {
    const old = (
      await tx.execute({ sql: "SELECT * FROM requests WHERE id=?", args: [id] })
    ).rows[0];
    if (old) {
      if (old.kind !== kind || old.input !== input)
        throw new RequestConflict("같은 요청 ID에 다른 입력을 보낼 수 없어요.");
      await tx.commit();
      return { fresh: false, row: old };
    }
    const now = new Date().toISOString();
    const m = await tx.execute({
      sql: "INSERT INTO messages(role,content,status,date,created_at) VALUES('user',?,'pending',?,?)",
      args: [raw, date, now],
    });
    await tx.execute({
      sql: "INSERT INTO requests(id,kind,input,date,created_at,status,message_id,expires_at) VALUES(?,?,?,?,?,'processing',?,?)",
      args: [
        id,
        kind,
        input,
        date,
        now,
        m.lastInsertRowid!,
        new Date(Date.now() + REQUEST_LIFETIME_MS).toISOString(),
      ],
    });
    const row = (
      await tx.execute({ sql: "SELECT * FROM requests WHERE id=?", args: [id] })
    ).rows[0];
    await tx.commit();
    return { fresh: true, row };
  } finally {
    tx.close();
  }
}
// The write lock and conditional lease check fence late workers and manual recovery.
export async function completeRequest(
  id: string,
  work: (
    tx: Transaction,
    row: Row,
  ) => Promise<{
    result: Record<string, unknown>;
    failed?: boolean;
    type?: string;
    errorCode?: string;
  }>,
) {
  await expireRequests();
  const tx = await (await db()).transaction("write");
  try {
    const row = (
      await tx.execute({ sql: "SELECT * FROM requests WHERE id=?", args: [id] })
    ).rows[0];
    if (row.status !== "processing") {
      await tx.commit();
      return view(row);
    }
    if (String(row.expires_at) <= new Date().toISOString()) {
      await tx.rollback();
      return (await requestState(id))!;
    }
    const output = await work(tx, row);
    const status = output.failed ? "failed" : "completed";
    const now = new Date().toISOString();
    await tx.execute({
      sql: "UPDATE messages SET status=? WHERE id=?",
      args: [
        output.failed && output.result.pending !== false
          ? "pending"
          : output.result.logged
            ? "logged"
            : "done",
        row.message_id,
      ],
    });
    await tx.execute({
      sql: "INSERT INTO messages(role,content,type,status,date,created_at) VALUES('assistant',?,?,?,?,?)",
      args: [
        String(output.result.text ?? ""),
        output.type ?? "text",
        output.result.logged ? "logged" : "done",
        row.date,
        now,
      ],
    });
    await tx.execute({
      sql: "UPDATE requests SET status=?,response=?,completed_at=?,error_code=? WHERE id=?",
      args: [
        status,
        JSON.stringify(output.result),
        now,
        output.errorCode ?? null,
        id,
      ],
    });
    const result = (
      await tx.execute({ sql: "SELECT * FROM requests WHERE id=?", args: [id] })
    ).rows[0];
    await tx.commit();
    return view(result);
  } finally {
    tx.close();
  }
}
export async function failRequest(id: string) {
  return completeRequest(id, async () => ({
    failed: true,
    errorCode: "PROCESSING_FAILED",
    result: {
      pending: true,
      text: "처리를 완료하지 못했어요. 원문은 보관했으니 직접 기록해 주세요.",
    },
  }));
}
