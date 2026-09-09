// Never log SQL, bound arguments, raw input, URLs, API keys or tokens.
export function errorDetails(error: unknown) {
  const e = error as { code?: unknown; message?: unknown };
  const message = String(e?.message ?? "");
  const code =
    typeof e?.code === "string" && /^[A-Z0-9_]{1,80}$/.test(e.code)
      ? e.code
      : "UNKNOWN";
  const category = /timeout|timed out|expired|transaction.*closed/i.test(
    message,
  )
    ? "timeout_or_closed_transaction"
    : /no such table|no such column|duplicate column/i.test(message)
      ? "schema"
      : /syntax|parse|HAVING/i.test(message)
        ? "sql_syntax"
        : /unauthorized|forbidden|auth/i.test(message)
          ? "authentication"
          : "unclassified";
  return { code, category };
}
export function reportServerError(stage: string, error: unknown) {
  console.error(
    "[gom-health]",
    JSON.stringify({ stage, ...errorDetails(error) }),
  );
}
