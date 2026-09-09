import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { callGemini, interpret } from "../lib/gemini";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_MODELS;
});
test("429에서만 환경변수의 다음 모델로 전환", async () => {
  process.env.GEMINI_API_KEY = "test";
  process.env.GEMINI_MODELS = "first,second";
  const urls: string[] = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    return urls.length === 1
      ? new Response("", { status: 429 })
      : Response.json({ ok: true });
  };
  assert.deepEqual(await callGemini({}), { ok: true });
  assert.match(urls[1], /second:generateContent/);
});
test("404와 네트워크 오류에서 다른 모델을 호출하지 않는다", async () => {
  process.env.GEMINI_API_KEY = "test";
  process.env.GEMINI_MODELS = "first,second";
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("", { status: 404 });
  };
  await assert.rejects(() => callGemini({}), /HTTP_404/);
  assert.equal(calls, 1);
});
test("모든 할당량 소진 시 기본 형식 저장, 모호한 원문은 미기록", async () => {
  process.env.GEMINI_API_KEY = "test";
  process.env.GEMINI_MODELS = "first,second";
  globalThis.fetch = async () => new Response("", { status: 429 });
  assert.equal(
    (await interpret("천국의 계단 15분", [])).exercises[0].durationMinutes,
    15,
  );
  assert.equal((await interpret("운동 많이 했어", [])).pending, true);
});
test("AI가 잘못된 구조를 반환하면 저장하지 않는다", async () => {
  process.env.GEMINI_API_KEY = "test";
  process.env.GEMINI_MODELS = "first";
  globalThis.fetch = async () =>
    Response.json({
      candidates: [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: "log_exercise",
                  args: { name: "벤치프레스", bodyPart: "가슴", reps: -3 },
                },
              },
            ],
          },
        },
      ],
    });
  const r = await interpret("벤치프레스", []);
  assert.equal(r.pending, true);
  assert.equal(r.exercises.length, 0);
});
