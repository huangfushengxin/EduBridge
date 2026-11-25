// EduBridge AI 业务路由（Sites Function）。
// 依赖注入仅用于本地测试；index.ts 保留 Deno.serve。
// 本模块从不从客户端接收 owner ID、对象路径或数据库凭据。
//
// 阶段二第3天（文件与任务）：
// - 匿名会话凭据由服务端签发（256-bit 随机 token），服务端只保存其 SHA-256 哈希
//   作为归属键（owner_token_hash）。每次请求把出示的 token 哈希后与记录上的归属键
//   比对；task_id 本身、客户端自报 owner_id 都不作为授权依据。
// - 原卷/答题卡分区上传：裸二进制请求体（无 multipart 开销），服务端按魔数校验真实
//   类型、按实际字节校验大小（单文件 ≤ 10,000,000 字节，每任务合计 ≤ 10 张），
//   复用已实测的私有存储 upload/download/remove。10,000,000 字节相对网关整个请求体
//   上限 10,485,760 字节留有约 485,760 字节余量（见 docs/deployment-check.md 第5轮）。
// - 任务读取/列表/删除、附件上传/预览/排序/删除、人工确认读写均校验归属；
//   其他会话即使知道 ID 也得到 404，不泄露存在性。
// - 学生图片私有保存；页面加载不触发任何付费模型调用。
// - 保留 health 与 storage-test（服务端生成 1x1 脱敏 PNG）作为既有回归入口。
//
// 阶段二第4天（真实图片识别与人工确认闭环）：
// - 识别由用户主动触发（POST /api/tasks/{id}/recognize → 202 job），上传/刷新/预览
//   绝不自动调用模型。采用两阶段任务状态机规避网关 ~60s 截断：
//     recognize 仅排队（不调模型）→ POST /api/jobs/{id}/run 原子认领后做"单次"受限
//     模型调用（AbortController < 网关超时）→ GET /api/jobs/{id} 轮询状态。
//   不假设 HTTP 返回/截断后后台代码仍会继续执行（Brief §9）。
// - 幂等：同 (task_id, idempotency_key) 去重 + 活跃任务检查，防止重复点击/刷新产生
//   重复付费调用；每任务视觉调用预算上限；running 超时（>120s）可回收重试。
// - 模型输出经服务端结构校验（validateRecognition）后才落库为"草稿"，绝不直接当作
//   已确认数据。模型原始结果（raw 对象 + draft）、人工修订（human）、确认状态/版本
//   分别保存以便追溯。未确认内容不进入后续诊断；本轮不做错因诊断。
// - 老师批改是判错依据：teacher_marks 单独转录，模型不得用自身解题结论覆盖；
//   看不清/对应关系不确定/批改不明确一律标"待人工确认"，允许留空，不伪造坐标。
// - 逐题素材定位：source_image_index/answer_image_index 映射为 asset_id+page_index，
//   无法可靠定位时置 null 并文字提示，bbox 恒为 null（不伪造像素区域）。
// - API Key 仅在服务端 model.mjs 读取 Secret；config 端点只返回存在性，不返回值。

import {
  RECOGNITION_SCHEMA_VERSION,
  RECOGNITION_PROMPT,
} from "./recognition.mjs";

import { applyMaterialResult, decodeMaterial, pickMaterial, planForMaterial, promptForMaterial } from "./recognition-page.mjs";
import { learningRoutes } from "./learning-routes.mjs";
import { modelBudget } from "./model-budget.mjs";
import { mergeQuestionRows, questionKey, teacherResult } from "./question-merge.mjs";
import { workspaceLogin } from "./workspace-login.mjs";

export function application({ db, storage, BackendError, model, verifyMath, authorizeReviewer, budgetOverrides = {}, login }) {
  const uuid = (v) =>
    typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
  const fail = (code, status) => {
    throw new BackendError(code, status);
  };
  const rows = (result) => {
    if (result.error) fail(result.error.code, result.error.status);
    return result.data;
  };

  const GRADING_RESULTS = new Set(["wrong", "right", "ungraded", "unclear"]);
  const SOURCES = new Set(["demo", "manual"]);
  const KINDS = new Set(["demo", "manual"]);
  const ASSET_KINDS = new Set(["paper", "sheet"]);

  // 项目初始限制（须同时满足平台限制）：单文件 ≤ 10,000,000 字节，每任务合计 ≤ 10 张。
  const MAX_FILE_BYTES = 10_000_000;
  const MAX_ASSETS_PER_TASK = 10;
  const SESSION_COOKIE = "eb_session";
  const SESSION_HEADER = "x-eb-session";
  const TOKEN_RE = /^[0-9a-f]{64}$/;

  // 第4天识别限制（须同时满足平台限制与预算）：
  // - 每任务最多 10 张图片；每次只送一张，先读题号目录，再按最多 4 题分块。
  // - 每任务视觉模型调用预算上限 12 次（目录、分块、失败与超时均计入），超出返回 budget_exceeded。
  // - running 任务超过 120s 视为陈旧（可能上次请求被网关截断），允许回收重试。
  const MAX_RECOGNIZE_IMAGES = MAX_ASSETS_PER_TASK;
  const MAX_RECOGNIZE_TOTAL_BYTES = 9_000_000;
  // 默认每任务 12 次；站点环境变量可按任务覆盖（仅联调），识别预检与 reserve 共用同一上限。
  const budget = modelBudget(db, rows, { overrides: budgetOverrides });
  const STALE_RUNNING_MS = 120_000;
  const PROMPT_VERSION = "recognition-v1.3-page-first";
  const JOB_STATUSES = new Set(["queued", "running", "succeeded", "failed"]);
  const QUESTION_STATUSES = new Set(["awaiting_confirmation", "confirmed", "stale"]);

  // 1x1 透明 PNG（服务端生成的脱敏测试图片，68 字节）
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  /* ---------- 编码 / 哈希 / 类型工具 ---------- */

  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  async function sha256Hex(input) {
    const data = typeof input === "string" ? new TextEncoder().encode(input) : input;
    const digest = await crypto.subtle.digest("SHA-256", data);
    return hex(new Uint8Array(digest));
  }

  // 按文件头魔数判定真实图片类型（不信任客户端 Content-Type / 扩展名）。
  function detectImageType(bytes) {
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return { mime: "image/jpeg", ext: "jpg" };
    }
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    ) {
      return { mime: "image/png", ext: "png" };
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return { mime: "image/webp", ext: "webp" };
    }
    return null;
  }

  function parseCookie(header, name) {
    if (!header) return null;
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx < 0) continue;
      if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
    }
    return null;
  }

  // 出示的会话 token → 归属键（SHA-256）。无有效凭据返回 null。
  const guestToken = (request) =>
    request.headers.get(SESSION_HEADER) || parseCookie(request.headers.get("cookie"), SESSION_COOKIE);

  async function resolveOwner(request) {
    const token = guestToken(request);
    if (!token || !TOKEN_RE.test(token)) return null;
    return sha256Hex(token);
  }

  async function requireOwner(request) {
    const owner = await resolveOwner(request);
    if (!owner) fail("session_required", 401);
    return owner;
  }

  // 归属校验：仅返回属于当前会话的任务；不存在或他人任务一律 404（不泄露存在性）。
  async function ownedTask(taskId, owner) {
    const found = rows(
      await db.from("tasks").select("id,kind,owner_token_hash").eq("id", taskId).eq("owner_token_hash", owner).limit(1),
    );
    if (!found?.length) fail("not_found", 404);
    return found[0];
  }

  /* ---------- 请求体读取 ---------- */

  async function readBody(request, maxBytes) {
    const reader = request.body?.getReader();
    if (!reader) fail("invalid_input", 400);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maxBytes) {
          await reader.cancel();
          fail("payload_too_large", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }

  async function input(request) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) fail("invalid_input", 400);
    const bytes = await readBody(request, 8192);
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("invalid_input", 400);
    }
  }

  const noStore = { "Cache-Control": "no-store" };

  /* ---------- 记录映射 ---------- */

  const taskFields = "id,kind,student_alias,grade,chapter,status,created_at";
  const mapTask = (row) => ({
    id: row.id,
    kind: row.kind,
    studentAlias: row.student_alias ?? null,
    grade: row.grade ?? null,
    chapter: row.chapter ?? null,
    status: row.status ?? null,
    createdAt: row.created_at,
  });

  const assetFields =
    "id,task_id,kind,mime,size_bytes,sha256,page_index,original_name,created_at";
  const mapAsset = (row) => ({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    mime: row.mime,
    sizeBytes: Number(row.size_bytes),
    sha256: row.sha256,
    pageIndex: row.page_index,
    originalName: row.original_name ?? null,
    createdAt: row.created_at,
    contentPath: `/api/assets/${row.id}/content`,
  });

  const confirmationFields =
    "task_id,version,number,stem,student_answer,grading_result,grading_note,source,confirmed_at,created_at";
  const mapConfirmation = (row) => ({
    taskId: row.task_id,
    version: row.version,
    number: row.number,
    stem: row.stem,
    studentAnswer: row.student_answer,
    gradingResult: row.grading_result,
    gradingNote: row.grading_note,
    source: row.source,
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
  });

  // 可选文本字段校验（ trim 后长度上限）；返回 null 或合法字符串。
  function optText(value, max) {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string") fail("invalid_input", 400);
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > max) fail("invalid_input", 400);
    return trimmed;
  }

  async function taskAssetCounts(owner) {
    const list = rows(
      await db.from("assets").select("task_id,kind").eq("owner_token_hash", owner).limit(1000),
    );
    const counts = new Map();
    for (const a of list ?? []) {
      const c = counts.get(a.task_id) ?? { paper: 0, sheet: 0 };
      if (a.kind === "paper") c.paper += 1;
      else if (a.kind === "sheet") c.sheet += 1;
      counts.set(a.task_id, c);
    }
    return counts;
  }

  /* ---------- 第4天：识别任务 / 逐题确认 工具 ---------- */

  const jobFields =
    "id,task_id,stage,status,attempts,error_code,model_run_id,created_at,updated_at,started_at,finished_at";
  const jobFullFields = `${jobFields},owner_token_hash,idempotency_key,raw_object_path,draft,source_assets`;
  const mapJob = (row) => {
    const assets = Array.isArray(row.source_assets) ? row.source_assets : [];
    const materials = assets.map((asset) => ({
      assetId: asset.assetId, kind: asset.kind, pageIndex: asset.pageIndex,
      status: asset.status ?? "pending", errorCode: asset.error ?? null,
      recognized: Array.isArray(asset.completedNumbers) ? asset.completedNumbers.length : null,
      total: Array.isArray(asset.questionNumbers) ? asset.questionNumbers.length : null,
      empty: asset.empty === true,
    }));
    const pending = materials.filter((asset) => asset.status === "pending").length;
    return {
      id: row.id,
      taskId: row.task_id,
      stage: row.stage,
      status: row.status,
      attempts: row.attempts,
      errorCode: row.error_code ?? null,
      modelRunId: row.model_run_id ?? null,
      remainingBatches: pending,
      materials,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? null,
      finishedAt: row.finished_at ?? null,
    };
  };

  const questionFields =
    "id,task_id,job_id,seq,number,stem,student_answer,teacher_result,teacher_marks,source_asset_id,source_page_index,answer_asset_id,answer_page_index,location_hint,field_status,draft,human,note,confirmed_version,confirmed_at,status,created_at,updated_at";
  const mapQuestion = (row) => ({
    id: row.id,
    taskId: row.task_id,
    jobId: row.job_id ?? null,
    seq: row.seq,
    number: row.number ?? null,
    stem: row.stem ?? null,
    studentAnswer: row.student_answer ?? null,
    teacherResult: row.teacher_result ?? null,
    teacherMarks: row.teacher_marks ?? [],
    sourceAssetId: row.source_asset_id ?? null,
    sourcePageIndex: row.source_page_index ?? null,
    answerAssetId: row.answer_asset_id ?? null,
    answerPageIndex: row.answer_page_index ?? null,
    locationHint: row.location_hint ?? null,
    fieldStatus: row.field_status ?? {},
    draft: row.draft ?? null,
    human: row.human ?? null,
    note: row.note ?? null,
    confirmedVersion: row.confirmed_version,
    confirmedAt: row.confirmed_at ?? null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

  async function ownedJob(jobId, owner) {
    const found = rows(
      await db.from("jobs").select(jobFullFields).eq("id", jobId).eq("owner_token_hash", owner).limit(1),
    );
    if (!found?.length) fail("not_found", 404);
    return found[0];
  }

  async function ownedQuestion(questionId, owner) {
    const found = rows(
      await db.from("questions").select(`${questionFields},owner_token_hash`).eq("id", questionId).eq("owner_token_hash", owner).limit(1),
    );
    if (!found?.length) fail("not_found", 404);
    return found[0];
  }

  function toBase64(bytes) {
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // 按任务素材构建识别输入图片序列（原卷优先，其次答题卡；按 page_index）。
  // 返回 [{ assetId, kind, pageIndex, objectPath, mime }]，冻结在 job.source_assets。
  async function recognitionSourceAssets(taskId, owner) {
    const list = rows(
      await db
        .from("assets")
        .select("id,kind,page_index,object_path,mime,size_bytes")
        .eq("task_id", taskId)
        .eq("owner_token_hash", owner)
        .order("kind", { ascending: true })
        .order("page_index", { ascending: true })
        .limit(MAX_ASSETS_PER_TASK),
    );
    // kind 升序：paper 在 sheet 前（'paper' < 'sheet'）。原卷优先送模型。
    return (list ?? []).slice(0, MAX_RECOGNIZE_IMAGES).map((a) => ({
      assetId: a.id,
      kind: a.kind,
      pageIndex: a.page_index,
      objectPath: a.object_path,
      mime: a.mime,
      sizeBytes: Number(a.size_bytes),
      scanMode: "page",
      status: "pending",
      error: null,
    }));
  }

  // 下载 job 冻结的图片序列并 base64 编码；缺失材料/超限/存储失败如实报错。
  async function loadJobImages(job) {
    const src = Array.isArray(job.source_assets) ? job.source_assets : [];
    const images = [];
    let total = 0;
    for (const a of src.slice(0, MAX_RECOGNIZE_IMAGES)) {
      let file;
      try {
        file = await storage.download(a.objectPath);
      } catch (error) {
        if (error?.code === "storage_object_not_found") fail("missing_material", 409);
        fail("storage_unavailable", 503);
      }
      const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
      total += bytes.length;
      if (total > MAX_RECOGNIZE_TOTAL_BYTES) fail("payload_too_large", 413);
      images.push({ mime: a.mime, base64: toBase64(bytes) });
    }
    if (images.length === 0) fail("missing_material", 409);
    return images;
  }

  // 由校验通过的模型草稿派生逐题记录（草稿态，待人工确认）。
  // 明确勾叉可转录为待确认的批改结果，不用数学求解判分；定位映射为 asset_id+page_index，
  // 无法可靠定位置 null 并文字提示；bbox 不伪造。
  function deriveQuestions(parsed, sourceAssets, taskId, jobId, owner) {
    const out = [];
    const qs = Array.isArray(parsed?.questions) ? parsed.questions : [];
    const linkAsset = (idx) => {
      if (Number.isInteger(idx) && idx >= 0 && idx < sourceAssets.length) {
        const a = sourceAssets[idx];
        return { assetId: a.assetId, pageIndex: a.pageIndex };
      }
      return { assetId: null, pageIndex: null };
    };
    qs.forEach((q, i) => {
      const steps = Array.isArray(q.student_steps) ? q.student_steps : [];
      const studentAnswer =
        steps.map((s) => (typeof s?.content === "string" ? s.content : "")).filter((t) => t !== "").join("\n") || null;
      const marks = Array.isArray(q.teacher_marks) ? q.teacher_marks : [];
      const src = sourceAssets.length === 1 ? linkAsset(0) : linkAsset(q.source_image_index);
      const ans = sourceAssets.length === 1 && sourceAssets[0].kind === "sheet" ? linkAsset(0) : linkAsset(q.answer_image_index);
      const linkageUncertain = src.assetId === null && ans.assetId === null;
      const fieldStatus = {
        number: q.number_status ?? "missing",
        stem: q.stem_status ?? "missing",
        overall: q.overall_status ?? "unreadable",
        answer: q.answer_status ?? (studentAnswer ? "recognized" : "missing"),
        linkage: linkageUncertain ? "uncertain" : "recognized",
        teacher: marks.length === 0 ? "missing" : marks.some((m) => m?.status !== "recognized") ? "uncertain" : "recognized",
      };
      out.push({
        id: crypto.randomUUID(),
        task_id: taskId,
        job_id: jobId,
        owner_token_hash: owner,
        seq: i,
        number: typeof q.number === "string" ? q.number : null,
        stem: typeof q.stem === "string" ? q.stem : null,
        student_answer: studentAnswer,
        teacher_result: teacherResult(marks),
        teacher_marks: marks,
        source_asset_id: src.assetId,
        source_page_index: src.pageIndex,
        answer_asset_id: ans.assetId,
        answer_page_index: ans.pageIndex,
        location_hint: linkageUncertain ? "素材对应关系待人工确认" : null,
        field_status: fieldStatus,
        draft: q,
        human: null,
        note: null,
        confirmed_version: 0,
        confirmed_at: null,
        status: "awaiting_confirmation",
      });
    });
    return out;
  }

  // 分批合并：按题号归并 paper（stem）与 sheet（studentAnswer+teacherMarks），保留材料来源。
  // 不合并的题各保留一行的 source/answer 资产信息；无法确定映射时不伪造。
  function mergeBatchedQuestions(allQuestions, sourceAssets) {
    const questions=mergeQuestionRows(allQuestions,sourceAssets);
    return {questions,count:questions.length,summary:{schema_version:RECOGNITION_SCHEMA_VERSION,merged_from:allQuestions.length,merged_to:questions.length}};
  }
  async function questionView(taskId,owner,latestJob) {
    if(!latestJob) return [];
    const raw=rows(await db.from('questions').select('*').eq('task_id',taskId).eq('job_id',latestJob.id).eq('owner_token_hash',owner).order('seq',{ascending:true}).limit(1000));
    return mergeQuestionRows(raw??[],latestJob.source_assets??[]).map(mapQuestion);
  }

  async function previousQuestionEdits(taskId, owner, jobId) {
    const stored = rows(await db.from("questions").select("id,job_id,human,updated_at")
      .eq("task_id", taskId).eq("owner_token_hash", owner)
      .order("updated_at", { ascending: false }).limit(1000));
    return (stored ?? []).filter((q) => q.job_id !== jobId && q.human).map((q) => ({
      id: q.id,
      fields: q.human,
      updatedAt: q.updated_at,
    }));
  }

  async function mapEditedQuestion(question, owner) {
    if (!question.job_id) return mapQuestion(question);
    const job = await ownedJob(question.job_id, owner);
    const view = await questionView(question.task_id, owner, job);
    return view.find((item) => item.id === question.id) ?? mapQuestion(question);
  }

  // 逐题人工字段校验：题号/题干/学生作答允许留空（null）；批改结论必须合法枚举。
  function readQuestionFields(body) {
    const nullableText = (v, max) => {
      if (v === undefined || v === null) return null;
      if (typeof v !== "string") fail("invalid_input", 400);
      const t = v.trim();
      if (t.length > max) fail("invalid_input", 400);
      return t === "" ? null : t;
    };
    const number = nullableText(body?.number, 40);
    const stem = nullableText(body?.stem, 4000);
    const studentAnswer = nullableText(body?.studentAnswer, 4000);
    const gradingResult = body?.gradingResult;
    if (!GRADING_RESULTS.has(gradingResult)) fail("invalid_input", 400);
    const gradingNote = nullableText(body?.gradingNote, 500) ?? "";
    return { number, stem, studentAnswer, gradingResult, gradingNote };
  }

  async function currentQuestions(taskId, owner) {
    const latest = rows(await db.from("jobs").select(jobFullFields).eq("task_id",taskId)
      .eq("owner_token_hash",owner).order("created_at",{ascending:false}).limit(1));
    return questionView(taskId,owner,latest?.[0]);
  }

  const handleLearning = learningRoutes({ db, fail, rows, requireOwner, ownedTask, currentQuestions,
    input, uuid, budget, model, verifyMath, authorizeReviewer, noStore });
  const workspaceAccess = workspaceLogin({input,fail,noStore,resolveOwner,...login});

  return async (ctx) => {
    const request = ctx.request;
    // 网关保留后缀但会把 app 替换为部署的物理函数名；
    // 提供商也可能在调用前剥掉 /functions/v1。
    const pathname = new URL(request.url).pathname;
    const match = pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
    if (!match) fail("not_found", 404);
    const path = match[1] || "/";
    const url = new URL(request.url);

    // 健康检查（无数据库依赖）
    if (path === "/api/health" && request.method === "GET") {
      return Response.json(
        { ok: true, service: "edubridge", ts: new Date().toISOString() },
        { headers: noStore },
      );
    }

    // 签发 / 复用匿名会话凭据。服务端生成不可预测 token，仅以哈希作为归属键。
    if (path === "/api/session" && request.method === "POST") {
      const existing = guestToken(request);
      if (existing && TOKEN_RE.test(existing)) {
        return Response.json({ ok: true, reused: true }, { headers: noStore });
      }
      const token = hex(crypto.getRandomValues(new Uint8Array(32)));
      const headers = {
        ...noStore,
        "Set-Cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`,
      };
      return Response.json({ ok: true, reused: false, token }, { status: 201, headers });
    }
    if (path === "/api/session" && request.method === "GET") {
      const owner = await resolveOwner(request);
      return Response.json({ ok: true, authenticated: !!owner }, { headers: noStore });
    }

    const accessResponse = await workspaceAccess(path,request);
    if (accessResponse) return accessResponse;

    // 创建 / 幂等恢复学习任务（绑定当前会话归属）
    if (path === "/api/tasks" && request.method === "POST") {
      const owner = await requireOwner(request);
      const body = await input(request);
      const kind = body?.kind ?? "manual";
      if (!KINDS.has(kind)) fail("invalid_input", 400);
      const id = body?.id === undefined ? crypto.randomUUID() : body.id;
      if (!uuid(id)) fail("invalid_input", 400);
      const studentAlias = optText(body?.studentAlias, 40);
      const grade = optText(body?.grade, 20);
      const chapter = optText(body?.chapter, 40);
      const inserted = rows(
        await db
          .from("tasks")
          .insertIfAbsent(
            {
              id,
              kind,
              creation_kind: kind,
              owner_token_hash: owner,
              student_alias: studentAlias,
              grade,
              chapter,
              status: "draft",
            },
            { onConflict: "id" },
          )
          .select(taskFields),
      );
      if (inserted?.length) return Response.json(mapTask(inserted[0]), { status: 201, headers: noStore });
      const existing = rows(
        await db.from("tasks").select(`${taskFields},creation_kind,owner_token_hash`).eq("id", id).limit(1),
      );
      if (
        !existing?.length ||
        existing[0].creation_kind !== kind ||
        existing[0].owner_token_hash !== owner
      ) {
        fail("idempotency_conflict", 409);
      }
      return Response.json(mapTask(existing[0]), { headers: noStore });
    }

    // 列出本人任务（恢复入口），附各类材料计数
    if (path === "/api/tasks" && request.method === "GET") {
      const owner = await requireOwner(request);
      const list = rows(
        await db
          .from("tasks")
          .select(taskFields)
          .eq("owner_token_hash", owner)
          .order("created_at", { ascending: false })
          .limit(100),
      );
      const counts = await taskAssetCounts(owner);
      const items = (list ?? []).map((row) => {
        const c = counts.get(row.id) ?? { paper: 0, sheet: 0 };
        return { ...mapTask(row), paperCount: c.paper, sheetCount: c.sheet };
      });
      return Response.json({ items }, { headers: noStore });
    }

    const task = path.match(/^\/api\/tasks\/([0-9a-f-]{36})$/);
    if (task && uuid(task[1]) && request.method === "GET") {
      const owner = await requireOwner(request);
      const found = rows(
        await db.from("tasks").select(taskFields).eq("id", task[1]).eq("owner_token_hash", owner).limit(1),
      );
      if (!found?.length) fail("not_found", 404);
      return Response.json(mapTask(found[0]), { headers: noStore });
    }

    // 删除本人任务及附件（存储对象 + 结构化记录）；存储失败则整体中止并可重试。
    if (task && uuid(task[1]) && request.method === "DELETE") {
      const owner = await requireOwner(request);
      await ownedTask(task[1], owner);
      const assets = rows(
        await db.from("assets").select("id,object_path").eq("task_id", task[1]).eq("owner_token_hash", owner).limit(1000),
      );
      for (const a of assets ?? []) {
        try {
          await storage.remove([a.object_path]);
        } catch (error) {
          if (error?.code === "storage_object_not_found") continue; // 对象已不存在，视为已清理
          fail("storage_unavailable", 503);
        }
      }
      rows(await db.from("assets").delete().eq("task_id", task[1]).eq("owner_token_hash", owner).select("id"));
      rows(await db.from("confirmations").delete().eq("task_id", task[1]).select("id"));
      // 第4天：级联清理识别任务、调用追踪、逐题记录与模型原始输出对象。
      const jobs = rows(
        await db.from("jobs").select("raw_object_path,source_assets").eq("task_id", task[1]).eq("owner_token_hash", owner).limit(1000),
      );
      const rawPaths = new Set((jobs ?? []).flatMap((j) => [
        j.raw_object_path, ...(j.source_assets ?? []).flatMap((a) => a.rawObjectPaths ?? []),
      ]).filter(Boolean));
      for (const rawPath of rawPaths) {
        try {
          await storage.remove([rawPath]);
        } catch (error) {
          if (error?.code !== "storage_object_not_found") fail("storage_unavailable", 503);
        }
      }
      rows(await db.from("questions").delete().eq("task_id", task[1]).eq("owner_token_hash", owner).select("id"));
      rows(await db.from("model_runs").delete().eq("task_id", task[1]).eq("owner_token_hash", owner).select("id"));
      rows(await db.from("jobs").delete().eq("task_id", task[1]).eq("owner_token_hash", owner).select("id"));
      // 先删除学习会话，保留数据库外键对同时发生的插入和任务删除的保护。
      rows(await db.from("learning_sessions").delete().eq("task_id", task[1]).eq("owner_token_hash", owner).select("task_id"));
      const removed = rows(
        await db.from("tasks").delete().eq("id", task[1]).eq("owner_token_hash", owner).select("id"),
      );
      if (!removed?.length) fail("write_conflict", 409);
      return Response.json(
        { id: task[1], deleted: true, removedAssets: (assets ?? []).length },
        { headers: noStore },
      );
    }

    // 重命名本人任务（空字符串表示清除，界面显示“未命名任务”）。
    if (task && uuid(task[1]) && request.method === "PATCH") {
      const owner = await requireOwner(request);
      await ownedTask(task[1], owner);
      const body = await input(request);
      if (!body || typeof body !== "object" || !Object.prototype.hasOwnProperty.call(body, "studentAlias")) {
        fail("invalid_input", 400);
      }
      const studentAlias = optText(body.studentAlias, 40);
      const updated = rows(
        await db.from("tasks").update({ student_alias: studentAlias })
          .eq("id", task[1]).eq("owner_token_hash", owner).select(taskFields),
      );
      if (!updated?.length) fail("write_conflict", 409);
      return Response.json(mapTask(updated[0]), { headers: noStore });
    }

    // 上传素材（裸二进制体；kind/name 经查询参数传入）。先校验归属与配额，再校验真实类型/大小。
    const assetsUpload = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/assets$/);
    if (assetsUpload && uuid(assetsUpload[1]) && request.method === "POST") {
      const owner = await requireOwner(request);
      await ownedTask(assetsUpload[1], owner);
      const kind = url.searchParams.get("kind");
      if (!ASSET_KINDS.has(kind)) fail("invalid_input", 400);
      const originalName = optText(url.searchParams.get("name"), 200);

      const bytes = await readBody(request, MAX_FILE_BYTES); // 超限 413
      if (bytes.length === 0) fail("empty_file", 400);
      const type = detectImageType(bytes);
      if (!type) fail("unsupported_type", 415);

      const existing = rows(
        await db.from("assets").select("id").eq("task_id", assetsUpload[1]).eq("owner_token_hash", owner).limit(MAX_ASSETS_PER_TASK + 1),
      );
      if ((existing ?? []).length >= MAX_ASSETS_PER_TASK) fail("asset_limit", 409);

      const last = rows(
        await db
          .from("assets")
          .select("page_index")
          .eq("task_id", assetsUpload[1])
          .eq("owner_token_hash", owner)
          .eq("kind", kind)
          .order("page_index", { ascending: false })
          .limit(1),
      );
      const pageIndex = last?.length ? last[0].page_index + 1 : 0;

      const assetId = crypto.randomUUID();
      const objectPath = `tasks/${assetsUpload[1]}/assets/${assetId}.${type.ext}`;
      const sha256 = await sha256Hex(bytes);
      try {
        await storage.upload(objectPath, bytes, { contentType: type.mime, upsert: false });
      } catch {
        fail("storage_unavailable", 503); // 未写入记录，已有材料不受影响
      }
      const inserted = rows(
        await db
          .from("assets")
          .insert({
            id: assetId,
            task_id: assetsUpload[1],
            owner_token_hash: owner,
            kind,
            object_path: objectPath,
            mime: type.mime,
            size_bytes: bytes.length,
            sha256,
            page_index: pageIndex,
            original_name: originalName,
          })
          .select(assetFields),
      );
      if (!inserted?.length) fail("write_conflict", 409);
      rows(
        await db.from("tasks").update({ status: "uploaded" }).eq("id", assetsUpload[1]).eq("owner_token_hash", owner).select("id"),
      );
      return Response.json(mapAsset(inserted[0]), { status: 201, headers: noStore });
    }

    // 列出某任务素材（归属校验），按 kind + page_index 排序
    if (assetsUpload && uuid(assetsUpload[1]) && request.method === "GET") {
      const owner = await requireOwner(request);
      await ownedTask(assetsUpload[1], owner);
      const list = rows(
        await db
          .from("assets")
          .select(assetFields)
          .eq("task_id", assetsUpload[1])
          .eq("owner_token_hash", owner)
          .order("kind", { ascending: true })
          .order("page_index", { ascending: true })
          .limit(100),
      );
      return Response.json({ items: (list ?? []).map(mapAsset) }, { headers: noStore });
    }

    // 调整某类材料页序
    const reorder = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/assets\/order$/);
    if (reorder && uuid(reorder[1]) && request.method === "PATCH") {
      const owner = await requireOwner(request);
      await ownedTask(reorder[1], owner);
      const body = await input(request);
      const kind = body?.kind;
      const orderedIds = body?.orderedIds;
      if (!ASSET_KINDS.has(kind) || !Array.isArray(orderedIds) || orderedIds.length > MAX_ASSETS_PER_TASK || !orderedIds.every(uuid)) {
        fail("invalid_input", 400);
      }
      const current = rows(
        await db.from("assets").select("id").eq("task_id", reorder[1]).eq("owner_token_hash", owner).eq("kind", kind).limit(100),
      );
      const currentIds = new Set((current ?? []).map((r) => r.id));
      if (orderedIds.length !== currentIds.size || !orderedIds.every((id) => currentIds.has(id))) {
        fail("invalid_input", 400);
      }
      for (let i = 0; i < orderedIds.length; i++) {
        rows(
          await db
            .from("assets")
            .update({ page_index: i })
            .eq("id", orderedIds[i])
            .eq("task_id", reorder[1])
            .eq("owner_token_hash", owner)
            .select("id"),
        );
      }
      const list = rows(
        await db
          .from("assets")
          .select(assetFields)
          .eq("task_id", reorder[1])
          .eq("owner_token_hash", owner)
          .eq("kind", kind)
          .order("page_index", { ascending: true })
          .limit(100),
      );
      return Response.json({ items: (list ?? []).map(mapAsset) }, { headers: noStore });
    }

    // 预览 / 下载素材内容（归属校验后读取私有对象）
    const content = path.match(/^\/api\/assets\/([0-9a-f-]{36})\/content$/);
    if (content && uuid(content[1]) && request.method === "GET") {
      const owner = await requireOwner(request);
      const found = rows(
        await db.from("assets").select("id,object_path,mime").eq("id", content[1]).eq("owner_token_hash", owner).limit(1),
      );
      if (!found?.length) fail("not_found", 404);
      let file;
      try {
        file = await storage.download(found[0].object_path);
      } catch (error) {
        if (error?.code === "storage_object_not_found") fail("not_found", 404);
        fail("storage_unavailable", 503);
      }
      return new Response(file.body, {
        headers: {
          "content-type": found[0].mime,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }

    // 删除单个素材（先清存储对象，再删记录；存储失败保留记录并可重试）
    const assetItem = path.match(/^\/api\/assets\/([0-9a-f-]{36})$/);
    if (assetItem && uuid(assetItem[1]) && request.method === "DELETE") {
      const owner = await requireOwner(request);
      const found = rows(
        await db.from("assets").select("id,object_path").eq("id", assetItem[1]).eq("owner_token_hash", owner).limit(1),
      );
      if (!found?.length) fail("not_found", 404);
      try {
        await storage.remove([found[0].object_path]);
      } catch (error) {
        if (error?.code !== "storage_object_not_found") fail("storage_unavailable", 503);
      }
      const removed = rows(
        await db.from("assets").delete().eq("id", assetItem[1]).eq("owner_token_hash", owner).select("id"),
      );
      if (!removed?.length) fail("write_conflict", 409);
      return Response.json({ id: assetItem[1], deleted: true }, { headers: noStore });
    }

    // 保存 / 读取人工确认内容（带版本 + 归属校验）
    const confirmation = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/confirmations?$/);
    if (confirmation && uuid(confirmation[1]) && request.method === "POST") {
      const owner = await requireOwner(request);
      await ownedTask(confirmation[1], owner);
      const body = await input(request);
      if (
        !Number.isInteger(body?.baseVersion) ||
        body.baseVersion < 0 ||
        typeof body.number !== "string" ||
        !body.number.trim() ||
        body.number.length > 40 ||
        typeof body.stem !== "string" ||
        !body.stem.trim() ||
        body.stem.length > 2000 ||
        typeof body.studentAnswer !== "string" ||
        !body.studentAnswer.trim() ||
        body.studentAnswer.length > 2000 ||
        !GRADING_RESULTS.has(body.gradingResult) ||
        typeof body.gradingNote !== "string" ||
        body.gradingNote.length > 500 ||
        !SOURCES.has(body.source)
      ) {
        fail("invalid_input", 400);
      }
      const latest = rows(
        await db
          .from("confirmations")
          .select("version")
          .eq("task_id", confirmation[1])
          .order("version", { ascending: false })
          .limit(1),
      );
      const current = latest?.length ? latest[0].version : 0;
      if (body.baseVersion !== current) fail("write_conflict", 409);
      const inserted = rows(
        await db
          .from("confirmations")
          .insert({
            task_id: confirmation[1],
            version: current + 1,
            number: body.number.trim(),
            stem: body.stem.trim(),
            student_answer: body.studentAnswer.trim(),
            grading_result: body.gradingResult,
            grading_note: body.gradingNote.trim(),
            source: body.source,
            confirmed_at: new Date().toISOString(),
          })
          .select(confirmationFields),
      );
      if (!inserted?.length) fail("write_conflict", 409);
      return Response.json(mapConfirmation(inserted[0]), { status: 201, headers: noStore });
    }
    if (confirmation && uuid(confirmation[1]) && request.method === "GET") {
      const owner = await requireOwner(request);
      await ownedTask(confirmation[1], owner);
      const found = rows(
        await db
          .from("confirmations")
          .select(confirmationFields)
          .eq("task_id", confirmation[1])
          .order("version", { ascending: false })
          .limit(1),
      );
      if (!found?.length) return Response.json({ taskId: confirmation[1], version: 0 }, { headers: noStore });
      return Response.json(mapConfirmation(found[0]), { headers: noStore });
    }

    // 存储测试：上传服务端生成的 1x1 脱敏 PNG（路径由服务端生成，不接受客户端字节与路径）
    if (path === "/api/storage-test" && request.method === "POST") {
      const id = crypto.randomUUID();
      const objectPath = `test-assets/${id}.png`;
      const bytes = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
      await storage.upload(objectPath, bytes, { contentType: "image/png", upsert: false });
      return Response.json(
        { id, objectPath, size: bytes.length, contentType: "image/png", uploaded: true },
        { status: 201, headers: noStore },
      );
    }

    const storageItem = path.match(/^\/api\/storage-test\/([0-9a-f-]{36})$/);
    if (storageItem && uuid(storageItem[1]) && request.method === "GET") {
      const objectPath = `test-assets/${storageItem[1]}.png`;
      let file;
      try {
        file = await storage.download(objectPath);
      } catch (error) {
        if (error?.code === "storage_object_not_found") fail("not_found", 404);
        throw error;
      }
      return new Response(file.body, {
        headers: {
          "content-type": "image/png",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    }
    if (storageItem && uuid(storageItem[1]) && request.method === "DELETE") {
      const objectPath = `test-assets/${storageItem[1]}.png`;
      try {
        await storage.remove([objectPath]);
      } catch (error) {
        if (error?.code === "storage_object_not_found") fail("not_found", 404);
        throw error;
      }
      return Response.json({ id: storageItem[1], deleted: true }, { headers: noStore });
    }

    /* ---------- 第4天：真实图片识别与逐题人工确认 ---------- */

    const ts = () => new Date().toISOString();

    // 识别服务配置存在性（仅返回是否配置 + 缺失键名，绝不返回键值）。
    if (path === "/api/recognition-config" && request.method === "GET") {
      await requireOwner(request);
      const cfg = model
        ? model.isConfigured()
        : { configured: false, missing: ["MODEL_BASE_URL", "MODEL_API_KEY", "VISION_MODEL"] };
      return Response.json({ configured: cfg.configured, missing: cfg.missing, simulated: model?.simulated === true }, { headers: noStore });
    }

    // 诊断：最小文本模型调用（供应商可能计费，不记录识别 model_runs）。
    if (path === "/api/model-connectivity" && request.method === "POST") {
      await requireOwner(request);
      if (!model) return Response.json({ reachable: false, reason: "no_provider" }, { headers: noStore });
      const result = await model.connectivityCheck();
      return Response.json(result, { headers: noStore });
    }

    // 用户主动发起识别 → 排队任务（202），不调用模型。上传/刷新/预览不会走到这里。
    const recognize = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/recognize$/);
    if (recognize && uuid(recognize[1]) && request.method === "POST") {
      const owner = await requireOwner(request);
      const task = await ownedTask(recognize[1], owner);
      if (model?.demoOnly && task.kind !== "demo") fail("simulation_only", 409);
      if (!model || !model.isConfigured().configured) fail("not_configured", 503);
      const body = await input(request);
      const idem = optText(body?.idempotencyKey, 128);

      // 活跃任务去重：已有 queued/running（未陈旧）任务则直接返回，避免重复付费调用。
      const recent = rows(
        await db.from("jobs").select(jobFullFields).eq("task_id", recognize[1]).eq("owner_token_hash", owner).order("created_at", { ascending: false }).limit(5),
      );
      const now = Date.now();
      const live = (recent ?? []).find(
        (j) => (j.status === "queued" || j.status === "running") && now - Date.parse(j.updated_at) < STALE_RUNNING_MS,
      );
      if (live) return Response.json({ job: mapJob(live), deduped: true }, { headers: noStore });

      // 同幂等键去重（刷新/重试复用同一意图）。
      if (idem) {
        const existing = rows(
          await db.from("jobs").select(jobFullFields).eq("task_id", recognize[1]).eq("owner_token_hash", owner).eq("idempotency_key", idem).limit(1),
        );
        if (existing?.length) return Response.json({ job: mapJob(existing[0]), deduped: true }, { headers: noStore });
      }

      if (await budget.count(recognize[1], owner) >= budget.limit(recognize[1])) fail("budget_exceeded", 429);

      const sourceAssets = await recognitionSourceAssets(recognize[1], owner);
      if (sourceAssets.length === 0) fail("missing_material", 409);

      const latest = recent?.[0];
      const priorAssets = latest?.source_assets;
      const samePages = Array.isArray(priorAssets) && priorAssets.length > 0 &&
        priorAssets.every((asset, index) => {
          const current = sourceAssets[index];
          return current?.assetId === asset.assetId && current.kind === asset.kind && current.pageIndex === asset.pageIndex;
        });
      // 旧版本使用前 4 张图。只在原有页序保持一致时，将剩余页追加到原 job。
      const legacyTruncation = priorAssets?.length === 4 && sourceAssets.length > 4 &&
        priorAssets.every((asset) => !Array.isArray(asset.questionNumbers));
      if (["queued", "running", "failed"].includes(latest?.status) && samePages && (priorAssets.length === sourceAssets.length || legacyTruncation)) {
        const priorStatus = latest.status;
        const resumedAssets = [
          ...priorAssets.map((asset, index) => ({
            ...sourceAssets[index],
            ...asset,
            status: asset.status === "done" ? "done" : "pending",
            ...(asset.status === "done" ? {} : { skippedNumbers: [], empty: false, error: null }),
          })),
          ...sourceAssets.slice(priorAssets.length),
        ];
        const resumed = rows(await db.from("jobs")
          .update({ status: "queued", error_code: null, source_assets: resumedAssets, updated_at: ts() })
          .eq("id", latest.id).eq("owner_token_hash", owner).eq("status", priorStatus)
          .eq("updated_at", latest.updated_at).select(jobFullFields));
        if (resumed?.length) return Response.json({ job: mapJob(resumed[0]), deduped: true }, { headers: noStore });
      }
      const jobId = crypto.randomUUID();
      const inserted = rows(
        await db
          .from("jobs")
          .insert({
            id: jobId,
            task_id: recognize[1],
            owner_token_hash: owner,
            stage: "recognize",
            idempotency_key: idem ?? `auto-${jobId}`,
            status: "queued",
            attempts: 0,
            source_assets: sourceAssets,
          })
          .select(jobFullFields),
      );
      if (!inserted?.length) fail("write_conflict", 409);
      rows(
        await db.from("tasks").update({ status: "recognizing" }).eq("id", recognize[1]).eq("owner_token_hash", owner).select("id"),
      );
      return Response.json({ job: mapJob(inserted[0]), deduped: false }, { status: 202, headers: noStore });
    }

    // 每次只占用一个模型调用，失败页让出执行机会给其他材料。
    const jobRun = path.match(/^\/api\/jobs\/([0-9a-f-]{36})\/run$/);
    if (jobRun && uuid(jobRun[1]) && request.method === "POST") {
      const owner = await requireOwner(request);
      const job = await ownedJob(jobRun[1], owner);
      if (["succeeded", "failed"].includes(job.status)) {
        return Response.json({ job: mapJob(job) }, { headers: noStore });
      }
      const stale = job.status === "running" && Date.now() - Date.parse(job.updated_at) >= STALE_RUNNING_MS;
      if (job.status === "running" && !stale) {
        return Response.json({ job: mapJob(job), inProgress: true }, { headers: noStore });
      }
      const claimed = rows(await db.from("jobs")
        .update({ status: "running", started_at: ts(), updated_at: ts(), attempts: (job.attempts ?? 0) + 1, error_code: null })
        .eq("id", job.id).eq("owner_token_hash", owner).eq("status", job.status)
        .eq("updated_at", job.updated_at).select(jobFullFields));
      if (!claimed?.length) {
        const latest = await ownedJob(job.id, owner);
        return Response.json({ job: mapJob(latest), inProgress: latest.status === "running" }, { headers: noStore });
      }
      const running = claimed[0];
      const sourceAssets = (Array.isArray(running.source_assets) ? running.source_assets : []).map((asset) => ({
        ...asset, status: asset.status === "processing" && stale ? "pending" : asset.status,
      }));
      const writeJob = async (patch) => {
        const result = rows(await db.from("jobs").update({ ...patch, updated_at: ts() })
          .eq("id", running.id).eq("owner_token_hash", owner).eq("attempts", running.attempts).select(jobFullFields));
        if (!result?.length) fail("write_conflict", 409);
        return result[0];
      };
      const finish = async (extra = {}, stopCode = null) => {
        const remaining = sourceAssets.filter((asset) => asset.status === "pending").length;
        if (remaining > 0 && !stopCode) {
          const updated = await writeJob({ ...extra, status: "queued", error_code: null, source_assets: sourceAssets });
          return Response.json({ job: mapJob(updated), remainingBatches: remaining }, { headers: noStore });
        }
        const drafts = rows(await db.from("questions").select("*").eq("job_id", running.id)
          .eq("owner_token_hash", owner).order("seq", { ascending: true }).limit(1000));
        const result = mergeBatchedQuestions(drafts ?? [], sourceAssets);
        const failed = sourceAssets.find((asset) => asset.status === "failed");
        const completed = sourceAssets.length > 0 && sourceAssets.every((asset) => asset.status === "done");
        const updated = await writeJob({
          ...extra, status: completed && !stopCode ? "succeeded" : "failed",
          error_code: stopCode ?? failed?.error ?? (completed ? null : "batch_state_invalid"),
          source_assets: sourceAssets, draft: result.summary, finished_at: ts(),
        });
        if (completed || result.count > 0) {
          rows(await db.from("tasks").update({ status: "awaiting_confirmation" })
            .eq("id", running.task_id).eq("owner_token_hash", owner).select("id"));
        }
        return Response.json({ job: mapJob(updated), questionCount: result.count }, { headers: noStore });
      };

      const nextIdx = pickMaterial(sourceAssets);
      if (nextIdx === -1) return finish();
      const batch = sourceAssets[nextIdx];
      const plan = planForMaterial(batch);
      if (plan.mode === "transcribe" && !plan.requested.length) {
        sourceAssets[nextIdx] = applyMaterialResult(batch, plan, { recognizedKeys: [], error: null });
        return finish();
      }
      batch.status = "processing";
      await writeJob({ source_assets: sourceAssets });

      let image;
      try {
        const file = await storage.download(batch.objectPath);
        const bytes = new Uint8Array(await new Response(file.body).arrayBuffer());
        image = { mime: batch.mime, base64: toBase64(bytes) };
      } catch {
        sourceAssets[nextIdx] = { ...batch, status: "failed", error: "storage_unavailable" };
        return finish();
      }

      const runId = await budget.reserve(running.task_id, owner, running.id, "vision", PROMPT_VERSION);
      if (!runId) {
        sourceAssets[nextIdx] = { ...batch, status: "pending", error: "budget_exceeded" };
        return finish({}, "budget_exceeded");
      }
      const tokenLimits = batch.kind === "paper" ? { page: 4600, inventory: 900, transcribe: 3000 }
        : { page: 3600, inventory: 900, transcribe: 1800 };
      let result;
      try {
        result = await model.recognize({
          images: [image], prompt: promptForMaterial(batch, plan), maxTokens: tokenLimits[plan.mode],
        });
      } catch {
        result = { ok: false, errorCode: "model_failed" };
      }
      const decoded = result.ok ? decodeMaterial(result.content, batch, plan) : {
        recognizedKeys: [], error: result.errorCode ?? "model_failed",
      };
      await budget.finish(runId, owner, decoded.error ? { ...result, ok: false, errorCode: decoded.error } : result);

      let rawPath = null;
      if (result.ok) {
        try {
          rawPath = "tasks/" + running.task_id + "/recognize/" + running.id + "/batch-" + nextIdx + "/" + runId + ".json";
          await storage.upload(rawPath, new TextEncoder().encode(result.content ?? ""), {
            contentType: "application/json", upsert: false,
          });
          batch.rawObjectPaths = [...new Set([...(batch.rawObjectPaths ?? []), running.raw_object_path, rawPath].filter(Boolean))];
        } catch {
          rawPath = null;
        }
      }

      if (decoded.diagnosis) {
        const rowsForPage = deriveQuestions(decoded.diagnosis, [batch], running.task_id, running.id, owner);
        const order = decoded.directory ?? batch.questionNumbers ?? [];
        for (const [i, question] of rowsForPage.entries()) {
          const numberKey = questionKey(question.number);
          const identity = question.field_status.number === "recognized" ? numberKey : "uncertain:" + i + ":" + question.number;
          const h = await sha256Hex(running.id + ":" + batch.assetId + ":" + identity);
          question.id = h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);
          const position = order.findIndex((label) => questionKey(label) === numberKey);
          question.seq = nextIdx * 1000 + (position >= 0 ? position : 300 + i);
          rows(await db.from("questions").insertIfAbsent(question, { onConflict: "id" }).select("id"));
        }
      }
      sourceAssets[nextIdx] = applyMaterialResult(batch, plan, decoded);
      const extra = { model_run_id: runId, ...(rawPath ? { raw_object_path: rawPath } : {}) };
      const stopCode = ["not_configured", "model_auth_failed", "model_access_denied", "model_quota_exhausted", "model_rate_limited"]
        .includes(decoded.error) ? decoded.error : null;
      return finish(extra, stopCode);
    }

    // 轮询任务状态。
    const jobItem = path.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
    if (jobItem && uuid(jobItem[1]) && request.method === "GET") {
      const owner = await requireOwner(request);
      const job = await ownedJob(jobItem[1], owner);
      const qc = rows(
        await db.from("questions").select("id").eq("job_id", job.id).eq("owner_token_hash", owner).limit(1000),
      );
      return Response.json({ job: mapJob(job), questionCount: (qc ?? []).length }, { headers: noStore });
    }

    // 恢复入口：某任务最新识别任务 + 逐题记录 + 配置存在性。
    const recognition = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/recognition$/);
    if (recognition && uuid(recognition[1]) && request.method === "GET") {
      const owner = await requireOwner(request);
      await ownedTask(recognition[1], owner);
      const jobs = rows(
        await db.from("jobs").select(jobFullFields).eq("task_id", recognition[1]).eq("owner_token_hash", owner).order("created_at", { ascending: false }).limit(1),
      );
      const latest = jobs?.[0];
      const [qs, previousEdits] = await Promise.all([
        questionView(recognition[1], owner, latest),
        previousQuestionEdits(recognition[1], owner, latest?.id),
      ]);
      return Response.json(
        {
          job: jobs?.length ? mapJob(jobs[0]) : null,
          questions: qs,
          previousEdits,
          configured: model ? model.isConfigured().configured : false,
          simulated: model?.simulated === true,
        },
        { headers: noStore },
      );
    }

    // 列出某任务逐题记录。
    const questions = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/questions$/);
    if (questions && uuid(questions[1]) && request.method === "GET") {
      const owner = await requireOwner(request);
      await ownedTask(questions[1], owner);
      const latest=rows(await db.from('jobs').select(jobFullFields).eq('task_id',questions[1]).eq('owner_token_hash',owner).order('created_at',{ascending:false}).limit(1));
      return Response.json({items:await questionView(questions[1],owner,latest?.[0])},{headers:noStore});
    }

    // 保存逐题人工修订（不确认）：已确认题目被修改后置 stale，需重新确认。
    const qRevision = path.match(/^\/api\/questions\/([0-9a-f-]{36})\/revision$/);
    if (qRevision && uuid(qRevision[1]) && request.method === "POST") {
      const owner = await requireOwner(request);
      const q = await ownedQuestion(qRevision[1], owner);
      const body = await input(request);
      const fields = readQuestionFields(body);
      if (!Number.isInteger(body?.baseVersion) || body.baseVersion !== q.confirmed_version) fail("write_conflict", 409);
      const newStatus = q.status === "confirmed" ? "stale" : "awaiting_confirmation";
      const updated = rows(
        await db
          .from("questions")
          .update({
            human: fields,
            number: fields.number,
            stem: fields.stem,
            student_answer: fields.studentAnswer,
            teacher_result: fields.gradingResult,
            note: fields.gradingNote,
            status: newStatus,
            updated_at: ts(),
          })
          .eq("id", q.id)
          .eq("owner_token_hash", owner)
          .eq("confirmed_version", q.confirmed_version)
          .select(questionFields),
      );
      if (!updated?.length) fail("write_conflict", 409);
      return Response.json(await mapEditedQuestion(updated[0], owner), { headers: noStore });
    }

    // 确认逐题（版本 + 归属 + 乐观锁）：保存人工修订并递增确认版本，置 confirmed。
    const qConfirm = path.match(/^\/api\/questions\/([0-9a-f-]{36})\/confirm$/);
    if (qConfirm && uuid(qConfirm[1]) && request.method === "POST") {
      const owner = await requireOwner(request);
      const q = await ownedQuestion(qConfirm[1], owner);
      const body = await input(request);
      const fields = readQuestionFields(body);
      if (!Number.isInteger(body?.baseVersion) || body.baseVersion !== q.confirmed_version) fail("write_conflict", 409);
      const updated = rows(
        await db
          .from("questions")
          .update({
            human: fields,
            number: fields.number,
            stem: fields.stem,
            student_answer: fields.studentAnswer,
            teacher_result: fields.gradingResult,
            note: fields.gradingNote,
            confirmed_version: q.confirmed_version + 1,
            confirmed_at: ts(),
            status: "confirmed",
            updated_at: ts(),
          })
          .eq("id", q.id)
          .eq("owner_token_hash", owner)
          .eq("confirmed_version", q.confirmed_version)
          .select(questionFields),
      );
      if (!updated?.length) fail("write_conflict", 409);
      return Response.json(await mapEditedQuestion(updated[0], owner), { headers: noStore });
    }

    const learningResponse = await handleLearning(request, path);
    if (learningResponse) return learningResponse;
    fail("not_found", 404);
  };
}
