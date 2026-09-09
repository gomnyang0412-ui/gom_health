import { z } from "zod";
export const parts = [
  "가슴",
  "등",
  "어깨",
  "팔",
  "하체",
  "코어",
  "유산소",
  "기타",
] as const;
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      !Number.isNaN(Date.parse(v)) &&
      new Date(v).toISOString().slice(0, 10) === v,
  );
export const exerciseSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    bodyPart: z.enum(parts),
    weightKg: z.number().min(0).max(2000).nullable().default(null),
    reps: z.number().int().min(1).max(10000).nullable().default(null),
    sets: z.number().int().min(1).max(100).default(1),
    durationMinutes: z.number().positive().max(1440).nullable().default(null),
  })
  .superRefine((v, ctx) => {
    if (v.bodyPart === "유산소" ? !v.durationMinutes : !v.reps)
      ctx.addIssue({
        code: "custom",
        message:
          v.bodyPart === "유산소"
            ? "운동 시간을 입력해 주세요"
            : "횟수를 입력해 주세요",
      });
    if (
      v.bodyPart === "유산소" &&
      (v.weightKg !== null || v.reps !== null || v.sets !== 1)
    )
      ctx.addIssue({
        code: "custom",
        message: "유산소는 시간만 입력해 주세요",
      });
  });
export type Exercise = z.infer<typeof exerciseSchema>;
export type Log = Exercise & {
  id: number;
  exerciseId: number;
  date: string;
  loggedAt: string;
  rawText: string;
};
export type Message = {
  id: number;
  role: "user" | "assistant";
  content: string;
  type: string;
  status: string;
  date: string;
};
export type Summary = {
  date: string;
  totalVolumeKg: number;
  totalSets: number;
  cardioMinutes: number;
  durationMinutes: number;
  streakCount: number;
  feedbackText: string;
  logs: Log[];
};
export function today(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}
export function shiftDate(date: string, days: number) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function isFinish(text: string) {
  return (
    text
      .trim()
      .replace(/[!.~。！]+$/g, "")
      .trim() === "끝"
  );
}
export function streak(dates: string[], date: string) {
  const set = new Set(dates);
  let n = 0;
  for (let d = date; set.has(d); d = shiftDate(d, -1)) n++;
  return n;
}
export function volume(log: Exercise) {
  return (log.weightKg ?? 0) * (log.reps ?? 0) * log.sets;
}
export function normalizeName(name: string) {
  return name.normalize("NFKC").replace(/\s+/g, "").toLowerCase();
}
export function inferPart(name: string): Exercise["bodyPart"] {
  if (/크런치|플랭크|윗몸/.test(name)) return "코어";
  if (/레터럴|숄더|어깨/.test(name)) return "어깨";
  if (/스쿼트|레그|런지/.test(name)) return "하체";
  if (/풀업|턱걸이|로우|풀다운/.test(name)) return "등";
  if (/벤치|푸시업|팔굽혀|체스트/.test(name)) return "가슴";
  if (/컬|푸시다운/.test(name)) return "팔";
  return "기타";
}
export function parseRule(text: string): Exercise | null {
  const s = text.trim().replace(/^오늘\s+/, "");
  const cardio = s.match(
    /^(.+?)\s+(\d+(?:\.\d+)?)\s*분(?:\s*(?:했어|했어요))?$/,
  );
  const strength = s.match(
    /^(.+?)\s+(?:(\d+(?:\.\d+)?)\s*kg\s*[x×*]?\s*)?(\d+)\s*(?:회|개)?(?:\s*(?:[x×*]\s*)?(\d+)\s*세트)?$/i,
  );
  if (strength && /\d|\bkg\b|[×*]/i.test(strength[1])) return null;
  const v = cardio
    ? {
        name: cardio[1],
        bodyPart: "유산소",
        durationMinutes: Number(cardio[2]),
      }
    : strength
      ? {
          name: strength[1],
          bodyPart: inferPart(strength[1]),
          weightKg: strength[2] ? Number(strength[2]) : null,
          reps: Number(strength[3]),
          sets: Number(strength[4] ?? 1),
        }
      : null;
  const result = exerciseSchema.safeParse(v);
  return result.success ? result.data : null;
}
