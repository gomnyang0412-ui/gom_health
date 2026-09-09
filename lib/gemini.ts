import { exerciseSchema, parts, parseRule, type Exercise } from "./domain";
export class GeminiError extends Error {
  constructor(public kind: string) {
    super(kind);
  }
}
export function modelChain() {
  return (process.env.GEMINI_MODELS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
function timeoutSetting(key: string, fallback: number) {
  const n = Number(process.env[key]);
  return Number.isFinite(n) && n >= 100 && n <= 28000 ? n : fallback;
}
export async function callGemini(body: object) {
  if (!process.env.GEMINI_API_KEY) throw new GeminiError("NOT_CONFIGURED");
  const models = modelChain();
  if (!models.length) throw new GeminiError("MODELS_NOT_CONFIGURED");
  const deadline =
    Date.now() + timeoutSetting("GEMINI_TOTAL_TIMEOUT_MS", 25000);
  for (const model of models) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GeminiError("TIMEOUT");
    let response: Response;
    try {
      response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": process.env.GEMINI_API_KEY,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(
            Math.min(remaining, timeoutSetting("GEMINI_TIMEOUT_MS", 8000)),
          ),
        },
      );
    } catch {
      throw new GeminiError("NETWORK_OR_TIMEOUT");
    }
    if (response.status === 429) continue;
    if (!response.ok) throw new GeminiError(`HTTP_${response.status}`);
    return response.json();
  }
  throw new GeminiError("ALL_MODELS_EXHAUSTED");
}
export async function interpret(
  text: string,
  names: (string | { name: string; bodyPart: string })[],
): Promise<{ exercises: Exercise[]; reply: string; pending: boolean }> {
  try {
    const data = await callGemini({
      systemInstruction: {
        parts: [
          {
            text: `운동 기록 도우미입니다. 지금 메시지에 명시된 완료한 운동만 log_exercise로 기록하세요. 운동명이나 횟수/시간이 부족하면 질문하세요. 추측하거나 이전 메시지에서 가져오지 마세요. 여러 운동은 각각 호출하세요. 유산소는 durationMinutes만 사용하고 reps와 weightKg는 null, sets는 1입니다. 무게를 두 배로 바꾸지 마세요. 기존 운동의 띄어쓰기·대소문자·명확한 약칭·영어/한글 표기 차이만 있고 동일한 운동임이 확실할 때만 기존 이름을 정확히 재사용하세요. 장비, 각도, 동작이 다르거나 확신이 없으면 새 이름으로 기록하세요. 이름이 비슷하다는 이유로 합치지 마세요. 근력·맨몸은 durationMinutes=null입니다. 기존 운동 이름과 부위 목록: ${JSON.stringify(names)}. 한국어 존댓말로 간결하게 답하세요.`,
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text }] }],
      tools: [
        {
          functionDeclarations: [
            {
              name: "log_exercise",
              description: "완료한 운동 기록",
              parameters: {
                type: "OBJECT",
                properties: {
                  name: { type: "STRING" },
                  bodyPart: { type: "STRING", enum: parts },
                  weightKg: { type: "NUMBER", nullable: true },
                  reps: { type: "INTEGER", nullable: true },
                  sets: { type: "INTEGER" },
                  durationMinutes: { type: "NUMBER", nullable: true },
                },
                required: ["name", "bodyPart"],
              },
            },
          ],
        },
      ],
    });
    const responseParts = data.candidates?.[0]?.content?.parts ?? [];
    const calls = responseParts.filter(
      (p: { functionCall?: { name: string } }) =>
        p.functionCall?.name === "log_exercise",
    );
    const exercises = calls.map((p: { functionCall: { args: unknown } }) =>
      exerciseSchema.parse(p.functionCall.args),
    );
    if (exercises.length > 20) throw new GeminiError("INVALID_RESPONSE");
    return {
      exercises,
      reply: exercises.length
        ? `${exercises.map((e: Exercise) => e.name).join(", ")} 기록했어요`
        : responseParts
            .map((p: { text?: string }) => p.text ?? "")
            .join("")
            .trim()
            .slice(0, 1000) ||
          "운동명과 무게·횟수 또는 시간을 함께 적어 주세요.",
      pending: false,
    };
  } catch (e) {
    const kind = e instanceof GeminiError ? e.kind : "INVALID_RESPONSE";
    if (kind === "ALL_MODELS_EXHAUSTED" || kind === "NOT_CONFIGURED") {
      const ex = parseRule(text);
      if (ex)
        return {
          exercises: [ex],
          reply: `${ex.name} 기록했어요. 기본 입력 형식으로 저장했어요.`,
          pending: false,
        };
    }
    return {
      exercises: [],
      reply:
        kind === "ALL_MODELS_EXHAUSTED"
          ? "오늘 AI 사용량을 다 썼어요. 입력은 보관했으니 직접 기록해 주세요."
          : "입력은 보관했어요. 지금은 자동으로 기록하지 못했으니 직접 기록해 주세요.",
      pending: true,
    };
  }
}
export async function feedback(stats: object) {
  try {
    const d = await callGemini({
      systemInstruction: {
        parts: [
          {
            text: "운동 기록의 수치만 근거로 한국어 존댓말 1~2문장 피드백을 쓰세요. 제공되지 않은 과거 기록, 증가 추세, 건강 효과를 지어내지 마세요. 느낌표는 쓰지 마세요.",
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: JSON.stringify(stats) }] }],
    });
    return String(
      d.candidates?.[0]?.content?.parts?.find((p: { text?: string }) => p.text)
        ?.text ?? "오늘의 운동을 기록했어요. 수고하셨어요.",
    ).slice(0, 500);
  } catch {
    return "오늘의 운동을 기록했어요. 수고하셨어요.";
  }
}
