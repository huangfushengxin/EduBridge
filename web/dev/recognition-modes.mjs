// 进程内识别闭环测试（仅开发用，不部署，绝不产生付费调用）。
// 用内存适配器 + 模拟模型直接跑 functions/routes.mjs 的真实路由，覆盖：
// 正常识别、幂等去重、重复 run、逐题修订/确认/重新确认、素材定位映射、草稿/人工分离、
// 原始输出留档、跨会话隔离、缺材料、预算上限、级联删除，以及模型超时/失败/格式错误/未配置。
import { application } from "../functions/routes.mjs";
import { makeDb, makeStorage, BackendError, errorResponse, makeMockModel } from "./memory-adapter.mjs";

let passed = 0;
let failed = 0;
function check(label, cond) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${label}`);
  }
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (n = 64) => Buffer.concat([PNG_HEADER, Buffer.alloc(n, 7)]);
const hexToken = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");

function makeApp(behavior = "ok") {
  const db = makeDb();
  const storage = makeStorage();
  const handle = application({ db, storage, BackendError, model: makeMockModel(behavior) });
  return { db, storage, handle };
}

async function call(handle, method, path, { token, json, raw } = {}) {
  const headers = {};
  if (token) headers["x-eb-session"] = token;
  let body;
  if (json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(json);
  } else if (raw !== undefined) {
    body = raw;
  }
  const req = new Request("http://localhost/functions/v1/app" + path, { method, headers, body });
  const requestId = crypto.randomUUID();
  let res;
  try {
    res = await handle({ request: req, requestId });
  } catch (error) {
    res = errorResponse(error, requestId);
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, data, text };
}

async function finishJob(handle, jobId, token) {
  for (let i = 0; i < 12; i++) {
    const result = await call(handle, "POST", `/api/jobs/${jobId}/run`, { token });
    if (result.data?.job?.status !== "queued") return result;
  }
  throw new Error("Mock recognition did not reach a terminal state");
}

// 建任务 + 上传原卷/答题卡，返回 { taskId, paperId, sheetId }
async function seedTask(handle, token, { withSheet = true, paper = true } = {}) {
  const taskId = crypto.randomUUID();
  await call(handle, "POST", "/api/tasks", { token, json: { id: taskId, kind: "manual" } });
  let paperId = null;
  let sheetId = null;
  if (paper) {
    const up = await call(handle, "POST", `/api/tasks/${taskId}/assets?kind=paper&name=p.png`, { token, raw: png() });
    paperId = up.data?.id;
  }
  if (withSheet) {
    const up = await call(handle, "POST", `/api/tasks/${taskId}/assets?kind=sheet&name=s.png`, { token, raw: png() });
    sheetId = up.data?.id;
  }
  return { taskId, paperId, sheetId };
}

/* ================= ok：完整闭环 ================= */
{
  const { db, storage, handle } = makeApp("ok");
  const tokenA = hexToken();
  const tokenB = hexToken();
  const { taskId, paperId, sheetId } = await seedTask(handle, tokenA);

  const cfg = await call(handle, "GET", "/api/recognition-config", { token: tokenA });
  check("ok config configured", cfg.status === 200 && cfg.data?.configured === true);
  check("ok config no secret values", cfg.data?.missing !== undefined && !JSON.stringify(cfg.data).includes("Bearer"));

  // 用户主动发起 → 202 queued（不调模型）
  const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token: tokenA, json: { idempotencyKey: "intent-1" } });
  check("ok recognize 202", rec.status === 202 && rec.data?.job?.status === "queued");
  check("ok recognize no model run yet", db._raw.model_runs.length === 0);
  const jobId = rec.data?.job?.id;

  // 重复点击（同幂等键 / 活跃任务）→ 去重，不新建任务
  const recDup = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token: tokenA, json: { idempotencyKey: "intent-1" } });
  check("ok recognize dedup same key", recDup.status === 200 && recDup.data?.deduped === true && recDup.data?.job?.id === jobId);
  const recDup2 = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token: tokenA, json: { idempotencyKey: "intent-2" } });
  check("ok recognize dedup active job", recDup2.status === 200 && recDup2.data?.job?.id === jobId);
  check("ok only one job created", db._raw.jobs.length === 1);

  // 轮询 queued
  const poll0 = await call(handle, "GET", `/api/jobs/${jobId}`, { token: tokenA });
  check("ok poll queued", poll0.status === 200 && poll0.data?.job?.status === "queued");

  // 原卷、答题卡各有一次题号目录和一次转录。
  const run = await finishJob(handle, jobId, tokenA);
  check("ok run succeeded", run.status === 200 && run.data?.job?.status === "succeeded" && run.data?.questionCount === 1);
  check("ok one model run per page", db._raw.model_runs.length === 2 && db._raw.model_runs.every((r) => r.status === "succeeded"));
  check("ok model run tracks metadata", db._raw.model_runs[0].actual_model_id === "mock-vision" && db._raw.model_runs[0].prompt_version === "recognition-v1.3-page-first");
  check("ok raw output object saved", typeof db._raw.jobs[0].raw_object_path === "string" && storage._objects.has(db._raw.jobs[0].raw_object_path));
  check("ok job draft saved", db._raw.jobs[0].draft?.schema_version === 1);

  // 重复 run（已成功）→ 幂等，不再调用模型
  const runAgain = await call(handle, "POST", `/api/jobs/${jobId}/run`, { token: tokenA });
  check("ok run idempotent", runAgain.status === 200 && runAgain.data?.job?.status === "succeeded");
  check("ok no extra model run on repeat", db._raw.model_runs.length === 2);

  // 恢复入口：recognition + questions
  const recog = await call(handle, "GET", `/api/tasks/${taskId}/recognition`, { token: tokenA });
  check("ok recognition job succeeded", recog.status === 200 && recog.data?.job?.status === "succeeded");
  check("ok recognition one question", recog.data?.questions?.length === 1);
  const q = recog.data?.questions?.[0];
  check("ok question awaiting_confirmation", q?.status === "awaiting_confirmation" && q?.confirmedVersion === 0);
  check("ok question draft present human null", q?.draft?.number === "1" && q?.human === null && q?.stem?.startsWith("（模拟）"));
  check("ok question teacher_result transcribes visible grading", q?.teacherResult === "wrong");
  check("ok question teacher_marks transcribed", Array.isArray(q?.teacherMarks) && q.teacherMarks[0]?.kind === "cross");
  check("ok question source linkage mapped", q?.sourceAssetId === paperId && q?.sourcePageIndex === 0);
  check("ok question answer linkage mapped", q?.answerAssetId === sheetId && q?.answerPageIndex === 0);
  check("ok question no fabricated bbox", q?.draft?.bbox === undefined);
  const questionId = q?.id;

  const qlist = await call(handle, "GET", `/api/tasks/${taskId}/questions`, { token: tokenA });
  check("ok questions list", qlist.status === 200 && qlist.data?.items?.length === 1);

  // 人工修订（不确认）→ human 保存，仍 awaiting_confirmation
  const rev = await call(handle, "POST", `/api/questions/${questionId}/revision`, {
    token: tokenA,
    json: { baseVersion: 0, number: "第 1 题", stem: q.stem, studentAnswer: "学生作答（人工修订）", gradingResult: "wrong", gradingNote: "等号取不到" },
  });
  check("ok revision saved", rev.status === 200 && rev.data?.human?.gradingResult === "wrong" && rev.data?.status === "awaiting_confirmation");
  check("ok revision keeps draft", rev.data?.draft?.number === "1");
  check("ok revision not confirmed yet", rev.data?.confirmedVersion === 0);

  // 确认 → confirmedVersion 1, confirmed
  const conf = await call(handle, "POST", `/api/questions/${questionId}/confirm`, {
    token: tokenA,
    json: { baseVersion: 0, number: "第 1 题", stem: q.stem, studentAnswer: "学生作答（人工修订）", gradingResult: "wrong", gradingNote: "等号取不到" },
  });
  check("ok confirm v1", conf.status === 200 && conf.data?.confirmedVersion === 1 && conf.data?.status === "confirmed");
  check("ok confirm saved human", conf.data?.human?.studentAnswer === "学生作答（人工修订）");

  // 陈旧 baseVersion → 409
  const stale = await call(handle, "POST", `/api/questions/${questionId}/confirm`, {
    token: tokenA,
    json: { baseVersion: 0, number: "x", stem: "y", studentAnswer: "z", gradingResult: "wrong", gradingNote: "" },
  });
  check("ok stale confirm 409", stale.status === 409);

  // 修改已确认题目 → stale，需重新确认
  const rev2 = await call(handle, "POST", `/api/questions/${questionId}/revision`, {
    token: tokenA,
    json: { baseVersion: 1, number: "第 1 题", stem: q.stem, studentAnswer: "再次修订", gradingResult: "right", gradingNote: "" },
  });
  check("ok edit confirmed becomes stale", rev2.status === 200 && rev2.data?.status === "stale");
  const conf2 = await call(handle, "POST", `/api/questions/${questionId}/confirm`, {
    token: tokenA,
    json: { baseVersion: 1, number: "第 1 题", stem: q.stem, studentAnswer: "再次修订", gradingResult: "right", gradingNote: "" },
  });
  check("ok re-confirm v2", conf2.status === 200 && conf2.data?.confirmedVersion === 2 && conf2.data?.status === "confirmed");

  // 留空允许（题号/题干/作答可 null）
  const blank = await call(handle, "POST", `/api/questions/${questionId}/revision`, {
    token: tokenA,
    json: { baseVersion: 2, number: "", stem: "", studentAnswer: "", gradingResult: "unclear", gradingNote: "" },
  });
  check("ok blank fields allowed", blank.status === 200 && blank.data?.number === null && blank.data?.stem === null);
  check("ok invalid grading rejected", (await call(handle, "POST", `/api/questions/${questionId}/revision`, { token: tokenA, json: { baseVersion: 2, gradingResult: "bogus" } })).status === 400);

  // 跨会话隔离
  check("iso B recognize 404", (await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token: tokenB, json: {} })).status === 404);
  check("iso B run job 404", (await call(handle, "POST", `/api/jobs/${jobId}/run`, { token: tokenB })).status === 404);
  check("iso B poll job 404", (await call(handle, "GET", `/api/jobs/${jobId}`, { token: tokenB })).status === 404);
  check("iso B recognition 404", (await call(handle, "GET", `/api/tasks/${taskId}/recognition`, { token: tokenB })).status === 404);
  check("iso B questions 404", (await call(handle, "GET", `/api/tasks/${taskId}/questions`, { token: tokenB })).status === 404);
  check("iso B confirm 404", (await call(handle, "POST", `/api/questions/${questionId}/confirm`, { token: tokenB, json: { baseVersion: 2, gradingResult: "wrong" } })).status === 404);
  check("iso B revision 404", (await call(handle, "POST", `/api/questions/${questionId}/revision`, { token: tokenB, json: { baseVersion: 2, gradingResult: "wrong" } })).status === 404);
  check("iso config requires session", (await call(handle, "GET", "/api/recognition-config", {})).status === 401);

  // 刷新恢复：重新读取仍在
  const recover = await call(handle, "GET", `/api/tasks/${taskId}/recognition`, { token: tokenA });
  check("ok refresh recovery persists", recover.data?.questions?.length === 1 && recover.data?.job?.status === "succeeded");

  // 级联删除：任务删除清理 jobs/model_runs/questions + raw 对象
  const rawPath = db._raw.jobs[0].raw_object_path;
  const del = await call(handle, "DELETE", `/api/tasks/${taskId}`, { token: tokenA });
  check("ok cascade delete task", del.status === 200 && del.data?.deleted === true);
  check("ok cascade jobs cleared", db._raw.jobs.length === 0);
  check("ok cascade model_runs cleared", db._raw.model_runs.length === 0);
  check("ok cascade questions cleared", db._raw.questions.length === 0);
  check("ok cascade raw object removed", !storage._objects.has(rawPath));
  check("ok recognition after delete 404", (await call(handle, "GET", `/api/tasks/${taskId}/recognition`, { token: tokenA })).status === 404);
}

/* ================= 缺材料 ================= */
{
  const { handle } = makeApp("ok");
  const token = hexToken();
  const { taskId } = await seedTask(handle, token, { paper: false, withSheet: false });
  const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  check("missing material 409", rec.status === 409 && rec.data?.error === "missing_material");
}

/* ================= 仅原卷无答题卡（仍可识别，批改标记缺失） ================= */
{
  const { handle } = makeApp("ok");
  const token = hexToken();
  const { taskId } = await seedTask(handle, token, { withSheet: false });
  const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  check("paper-only recognize 202", rec.status === 202);
  const run = await finishJob(handle, rec.data.job.id, token);
  check("paper-only run succeeded", run.status === 200 && run.data?.job?.status === "succeeded");
}

/* ================= 预算上限 ================= */
{
  const { db, handle } = makeApp("ok");
  const token = hexToken();
  const { taskId } = await seedTask(handle, token, { withSheet: false });
  for (let i = 0; i < 12; i++) {
    const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
    check(`budget run ${i + 1} recognized`, rec.status === 202);
    const run = await finishJob(handle, rec.data.job.id, token);
    check(`budget run ${i + 1} succeeded`, run.data?.job?.status === "succeeded");
  }
  check("budget 12 model runs", db._raw.model_runs.length === 12);
  const over = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  check("budget exceeded 429", over.status === 429 && over.data?.error === "budget_exceeded");
}

/* ================= 模型超时 ================= */
{
  const { db, handle } = makeApp("timeout");
  const token = hexToken();
  const { taskId, paperId } = await seedTask(handle, token);
  const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  const run = await finishJob(handle, rec.data.job.id, token);
  check("timeout job failed", run.status === 200 && run.data?.job?.status === "failed" && run.data?.job?.errorCode === "model_timeout");
  check("timeout model run status", db._raw.model_runs[0]?.status === "timeout");
  check("timeout no questions created", db._raw.questions.length === 0);
  check("timeout material preserved", db._raw.assets.some((a) => a.id === paperId));
  // 失败后复用同一个任务。
  const rec2 = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  check("timeout retry resumes the existing job", rec2.status === 200 && rec2.data?.job?.id === rec.data.job.id && rec2.data?.job?.status === "queued");
}

/* ================= 模型失败 ================= */
{
  const { handle } = makeApp("fail");
  const token = hexToken();
  const { taskId } = await seedTask(handle, token);
  const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  const run = await finishJob(handle, rec.data.job.id, token);
  check("fail job failed", run.data?.job?.status === "failed" && run.data?.job?.errorCode === "model_failed");
}

/* ================= 格式错误（结构校验拦截） ================= */
{
  const { db, storage, handle } = makeApp("badjson");
  const token = hexToken();
  const { taskId } = await seedTask(handle, token);
  const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  const run = await finishJob(handle, rec.data.job.id, token);
  check("badjson schema_invalid", run.data?.job?.status === "failed" && run.data?.job?.errorCode === "schema_invalid");
  check("badjson no questions入库", db._raw.questions.length === 0);
  check("badjson raw still saved", typeof db._raw.jobs[0].raw_object_path === "string" && storage._objects.has(db._raw.jobs[0].raw_object_path));
}

/* ================= 未配置识别服务 ================= */
{
  const { handle } = makeApp("unconfigured");
  const token = hexToken();
  const { taskId } = await seedTask(handle, token);
  const cfg = await call(handle, "GET", "/api/recognition-config", { token });
  check("unconfigured config false", cfg.status === 200 && cfg.data?.configured === false);
  const rec = await call(handle, "POST", `/api/tasks/${taskId}/recognize`, { token, json: {} });
  check("unconfigured recognize 503", rec.status === 503 && rec.data?.error === "not_configured");
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
