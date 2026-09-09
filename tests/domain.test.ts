import { test } from "node:test";
import assert from "node:assert/strict";
import {
  today,
  shiftDate,
  streak,
  isFinish,
  parseRule,
  exerciseSchema,
  volume,
  dateSchema,
} from "../lib/domain";
test("한국 자정 전후의 날짜와 월 경계", () => {
  assert.equal(today(new Date("2026-09-08T14:59:59Z")), "2026-09-08");
  assert.equal(today(new Date("2026-09-08T15:00:00Z")), "2026-09-09");
  assert.equal(shiftDate("2026-03-01", -1), "2026-02-28");
  assert.equal(dateSchema.safeParse("2026-02-30").success, false);
});
test("끝 트리거는 문장 전체를 비교한다", () => {
  for (const v of ["끝", " 끝! ", "끝...", "끝 ~"])
    assert.equal(isFinish(v), true);
  for (const v of ["끝나면 알려줘", "끝 20회", "오늘 끝"])
    assert.equal(isFinish(v), false);
});
test("중복 날짜를 제외한 연속 운동일", () => {
  assert.equal(
    streak(
      ["2026-09-09", "2026-09-09", "2026-09-08", "2026-09-06"],
      "2026-09-09",
    ),
    2,
  );
});
test("근력, 맨몸, 유산소 파싱 및 볼륨", () => {
  const a = parseRule("사이드 레터럴 레이즈 25kg x 20 3세트")!;
  assert.equal(a.sets, 3);
  assert.equal(volume(a), 1500);
  assert.equal(a.bodyPart, "어깨");
  assert.equal(parseRule("턱걸이 10회")?.weightKg, null);
  assert.equal(parseRule("천국의 계단 15분")?.durationMinutes, 15);
  assert.equal(parseRule("인터벌러닝 15분")?.reps, null);
  assert.equal(parseRule("같은 무게로 15개 더"), null);
  assert.equal(parseRule("벤치프레스 -20kg x 10"), null);
});
test("잘못된 세트/횟수와 유산소 혼합 입력을 거부", () => {
  assert.equal(
    exerciseSchema.safeParse({ name: "운동", bodyPart: "가슴", reps: 0 })
      .success,
    false,
  );
  assert.equal(
    exerciseSchema.safeParse({
      name: "러닝",
      bodyPart: "유산소",
      durationMinutes: 15,
      weightKg: 10,
    }).success,
    false,
  );
});
