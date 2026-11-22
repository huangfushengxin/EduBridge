/**
 * 同源业务接口客户端 —— 调用 Qoder Sites Function。
 * 仅返回结构化结果；所有错误都被归一为 ApiError。
 *
 * 阶段二第3天：匿名会话凭据由服务端签发（256-bit 随机 token），前端保存在
 * localStorage（eb_session_token），每次请求以 x-eb-session 头出示；服务端只保存其
 * SHA-256 哈希作为归属键。task_id 与客户端自报 owner_id 都不作为授权依据。
 * 预览图片通过带凭据的 fetch 取回私有对象再转 objectURL（<img src> 无法携带自定义头）。
 * 本地开发无 Function 服务时请求会失败，调用方必须如实显示错误状态。
 */

export class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const TOKEN_KEY = "eb_session_token";
const SESSION_HEADER = "x-eb-session";

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function setSessionToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // 隐私模式等无法写入时仍可在内存中使用本次会话
  }
}

function authHeaders(): Record<string, string> {
  const token = getSessionToken();
  return token ? { [SESSION_HEADER]: token } : {};
}

async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`/functions/v1/app${path}`, {
      credentials: "same-origin",
      ...init,
      headers: {
        ...authHeaders(),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError("无法连接到服务端（网络或服务不可用）", 0);
  }
}

async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 非 JSON 响应（如网关错误页）
  }
  const code =
    body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `HTTP ${res.status}`;
  return new ApiError(code, res.status);
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw await toApiError(res);
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 空响应体
  }
  return body as T;
}

/** 把服务端错误码翻译为面向用户的中文提示。 */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) return "操作失败，请重试";
  switch (error.message) {
    case "session_required":
      return "会话凭据缺失或失效，请刷新页面重新建立会话";
    case "payload_too_large":
      return "文件超过单张 10,000,000 字节（约 9.5MB）上限";
    case "unsupported_type":
      return "仅支持 JPEG / PNG / WebP 图片（按文件真实内容校验）";
    case "empty_file":
      return "文件为空，无法上传";
    case "asset_limit":
      return "每个任务最多 10 张图片（原卷与答题卡合计）";
    case "not_found":
      return "材料不存在或不属于当前会话";
    case "storage_unavailable":
      return "私有存储暂不可用，已有材料未受影响，请重试";
    case "write_conflict":
      return "写入冲突，请刷新后重试";
    case "idempotency_conflict":
      return "任务标识冲突，请新建任务";
    case "invalid_input":
      return "提交内容不符合要求";
    case "not_configured":
      return "尚未配置识别服务，请联系负责人在服务端配置模型密钥";
    case "simulation_only":
      return "模拟识别只支持内置的自制样例。请使用真实识别服务处理自己的材料。";
    case "missing_material":
      return "缺少可识别的图片材料，请先上传原卷或答题卡";
    case "budget_exceeded":
      return "本任务识别调用次数已达上限，已识别题目和人工修改已保留，剩余题目可手工录入";
    case "page_unreadable":
      return "本页题号无法辨认，请核对图片清晰度。";
    case "schema_invalid":
      return "模型输出格式不完整，已保存此前可用结果，请继续处理。";
    case "model_timeout":
      return "模型调用超时，材料和此前结果已保留，请继续处理。";
    case "model_failed":
      return "模型未返回有效识别内容，已有材料与结果已保留";
    case "model_incomplete":
      return "本批次有题号遗漏或重复，已保留完成部分，请重试当前批次";
    case "model_output_truncated":
      return "模型输出被截断，请重试本批次，已完成部分已保留";
    case "model_quota_exhausted":
      return "当前模型额度不足，请检查该模型的百炼免费额度或账户状态";
    case "model_access_denied":
      return "模型访问被拒绝，请核对地域、业务空间和模型权限";
    case "dns_failed":
      return "无法解析模型服务域名，请检查服务端 MODEL_BASE_URL 配置是否正确";
    case "connect_refused":
      return "模型服务连接被拒，请检查 MODEL_BASE_URL 地址与端口是否可达";
    case "tls_failed":
      return "模型服务 TLS 证书验证失败，请检查 MODEL_BASE_URL 是否使用有效的 HTTPS 证书";
    case "connect_timeout":
      return "连接模型服务超时，请检查网络或 MODEL_BASE_URL 是否可达";
    case "fetch_failed":
      return "模型服务请求失败（网络异常），请检查 MODEL_BASE_URL 配置与服务状态";
    case "model_auth_failed":
      return "模型服务认证失败（API Key 无效或过期），请检查 MODEL_API_KEY 是否正确";
    case "model_rate_limited":
      return "模型服务限流，请稍后重试或检查账户额度";
    case "model_http_error":
      return "模型服务返回 HTTP 错误，请检查 MODEL_BASE_URL 与模型型号配置";
    default:
      if (error.status === 0)
        return "无法连接到服务端（网络或服务不可用）";
      // 502/503/504：网关或后端不可达（常见于本地预览未启动函数服务）。
      if (error.status === 502 || error.status === 503 || error.status === 504) {
        return "服务暂不可达（网关或本地函数服务未就绪），已有材料不受影响，请稍后重试；若使用本地预览，请确认已启动函数适配器并匹配代理端口";
      }
      return `服务端返回错误（${error.message}）`;
  }
}

/* ---------- 会话 ---------- */

let sessionPromise: Promise<string> | null = null;

/** 建立或复用匿名会话；返回服务端签发的 token。失败时抛出 ApiError。 */
export function ensureSession(): Promise<string> {
  if (sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    const existing = getSessionToken();
    const res = await apiFetch("/api/session", { method: "POST" });
    if (!res.ok) throw await toApiError(res);
    const body = (await res.json()) as { reused?: boolean; token?: string };
    if (body.reused && existing) return existing;
    if (body.token) {
      setSessionToken(body.token);
      return body.token;
    }
    throw new ApiError("会话签发失败", res.status);
  })().catch((error) => {
    sessionPromise = null;
    throw error;
  });
  return sessionPromise;
}

/* ---------- 类型（与 functions/routes.mjs 约定一致） ---------- */

export type GradingResult = "wrong" | "right" | "ungraded" | "unclear";
export type TaskKind = "demo" | "manual";
export type ConfirmSource = "demo" | "manual";
export type AssetKind = "paper" | "sheet";

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  studentAlias: string | null;
  grade: string | null;
  chapter: string | null;
  status: string | null;
  createdAt: string;
  paperCount?: number;
  sheetCount?: number;
}

export interface AssetRecord {
  id: string;
  taskId: string;
  kind: AssetKind;
  mime: string;
  sizeBytes: number;
  sha256: string;
  pageIndex: number;
  originalName: string | null;
  createdAt: string;
  contentPath: string;
}

export interface ConfirmationRecord {
  taskId: string;
  version: number;
  number: string;
  stem: string;
  studentAnswer: string;
  gradingResult: GradingResult;
  gradingNote: string;
  source: ConfirmSource;
  confirmedAt: string;
  createdAt: string;
}

export interface ConfirmationPayload {
  baseVersion: number;
  number: string;
  stem: string;
  studentAnswer: string;
  gradingResult: GradingResult;
  gradingNote: string;
  source: ConfirmSource;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  ts: string;
}

/* ---------- 任务 ---------- */

export function ensureTask(id: string, kind: TaskKind): Promise<TaskRecord> {
  return requestJson<TaskRecord>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ id, kind }),
  });
}

export function createTask(opts?: {
  kind?: TaskKind;
  studentAlias?: string;
  grade?: string;
  chapter?: string;
}): Promise<TaskRecord> {
  return requestJson<TaskRecord>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ kind: "manual", ...opts }),
  });
}

export function listTasks(): Promise<{ items: TaskRecord[] }> {
  return requestJson<{ items: TaskRecord[] }>("/api/tasks");
}

export function getTask(id: string): Promise<TaskRecord> {
  return requestJson<TaskRecord>(`/api/tasks/${id}`);
}

export function deleteTask(id: string): Promise<{ id: string; deleted: boolean; removedAssets: number }> {
  return requestJson(`/api/tasks/${id}`, { method: "DELETE" });
}

export function renameTask(id: string, studentAlias: string): Promise<TaskRecord> {
  return requestJson<TaskRecord>(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ studentAlias }),
  });
}

/* ---------- 素材 ---------- */

export function listAssets(taskId: string): Promise<{ items: AssetRecord[] }> {
  return requestJson<{ items: AssetRecord[] }>(`/api/tasks/${taskId}/assets`);
}

/** 以裸二进制体上传单张图片（无 multipart 开销）；kind/name 经查询参数传入。 */
export async function uploadAsset(
  taskId: string,
  kind: AssetKind,
  file: File,
): Promise<AssetRecord> {
  const params = new URLSearchParams({ kind });
  if (file.name) params.set("name", file.name.slice(0, 200));
  const res = await apiFetch(`/api/tasks/${taskId}/assets?${params.toString()}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as AssetRecord;
}

export function reorderAssets(
  taskId: string,
  kind: AssetKind,
  orderedIds: string[],
): Promise<{ items: AssetRecord[] }> {
  return requestJson<{ items: AssetRecord[] }>(`/api/tasks/${taskId}/assets/order`, {
    method: "PATCH",
    body: JSON.stringify({ kind, orderedIds }),
  });
}

export function deleteAsset(id: string): Promise<{ id: string; deleted: boolean }> {
  return requestJson(`/api/assets/${id}`, { method: "DELETE" });
}

/** 带凭据取回私有图片内容，转为可在 <img> 使用的 objectURL（调用方负责 revoke）。 */
export async function fetchAssetObjectUrl(asset: AssetRecord): Promise<string> {
  const res = await apiFetch(asset.contentPath);
  if (!res.ok) throw await toApiError(res);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/* ---------- 人工确认 ---------- */

export function saveConfirmation(
  taskId: string,
  payload: ConfirmationPayload,
): Promise<ConfirmationRecord> {
  return requestJson<ConfirmationRecord>(`/api/tasks/${taskId}/confirmations`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function readConfirmation(
  taskId: string,
): Promise<ConfirmationRecord | { taskId: string; version: 0 }> {
  return requestJson<ConfirmationRecord | { taskId: string; version: 0 }>(
    `/api/tasks/${taskId}/confirmation`,
  );
}

/* ---------- 第4天：真实图片识别与逐题人工确认 ---------- */

export type JobStatus = "queued" | "running" | "succeeded" | "failed";
export type QuestionStatus = "awaiting_confirmation" | "confirmed" | "stale";

export interface RecognitionConfig {
  configured: boolean;
  missing: string[];
}

export interface RecognitionJob {
  id: string;
  taskId: string;
  stage: string;
  status: JobStatus;
  attempts: number;
  errorCode: string | null;
  modelRunId: string | null;
  remainingBatches?: number;
  materials?: { assetId: string; kind: "paper" | "sheet"; pageIndex: number; status: "pending" | "processing" | "done" | "failed"; errorCode: string | null; recognized: number | null; total: number | null; empty: boolean }[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** 逐题记录：draft=模型原始草稿，human=人工修订，confirmedVersion/status=确认追溯。 */
export interface RecognitionQuestion {
  id: string;
  taskId: string;
  jobId: string | null;
  seq: number;
  number: string | null;
  stem: string | null;
  studentAnswer: string | null;
  teacherResult: GradingResult | null;
  teacherMarks: unknown[];
  sourceAssetId: string | null;
  sourcePageIndex: number | null;
  answerAssetId: string | null;
  answerPageIndex: number | null;
  locationHint: string | null;
  fieldStatus: Record<string, string>;
  draft: unknown;
  human: QuestionFields | null;
  note: string | null;
  confirmedVersion: number;
  confirmedAt: string | null;
  status: QuestionStatus;
  createdAt: string;
  updatedAt: string;
}

export interface QuestionFields {
  number: string | null;
  stem: string | null;
  studentAnswer: string | null;
  gradingResult: GradingResult;
  gradingNote: string;
}

export interface RecognitionState {
  job: RecognitionJob | null;
  questions: RecognitionQuestion[];
  previousEdits?: PreviousQuestionEdit[];
  configured: boolean;
  simulated?: boolean;
}

export interface PreviousQuestionEdit {
  id: string;
  fields: QuestionFields;
  updatedAt: string;
}

export function getRecognitionConfig(): Promise<RecognitionConfig> {
  return requestJson<RecognitionConfig>("/api/recognition-config");
}

/** 用户主动发起识别 → 202 排队任务（不调用模型）。idempotencyKey 用于重复点击/刷新去重。 */
export function startRecognize(
  taskId: string,
  idempotencyKey: string,
): Promise<{ job: RecognitionJob; deduped: boolean }> {
  return requestJson<{ job: RecognitionJob; deduped: boolean }>(`/api/tasks/${taskId}/recognize`, {
    method: "POST",
    body: JSON.stringify({ idempotencyKey }),
  });
}

/** 执行识别任务（单次受限模型调用）；前端发起后轮询 getJob 直至终态。 */
export function runJob(
  jobId: string,
): Promise<{ job: RecognitionJob; questionCount?: number; inProgress?: boolean; remainingBatches?: number }> {
  return requestJson<{ job: RecognitionJob; questionCount?: number; inProgress?: boolean; remainingBatches?: number }>(
    `/api/jobs/${jobId}/run`,
    { method: "POST" },
  );
}

export function getJob(jobId: string): Promise<{ job: RecognitionJob; questionCount: number }> {
  return requestJson<{ job: RecognitionJob; questionCount: number }>(`/api/jobs/${jobId}`);
}

/** 恢复入口：某任务最新识别任务 + 逐题记录 + 配置存在性。 */
export function getTaskRecognition(taskId: string): Promise<RecognitionState> {
  return requestJson<RecognitionState>(`/api/tasks/${taskId}/recognition`);
}

export function listQuestions(taskId: string): Promise<{ items: RecognitionQuestion[] }> {
  return requestJson<{ items: RecognitionQuestion[] }>(`/api/tasks/${taskId}/questions`);
}

/** 保存逐题人工修订（不确认）；已确认题目被修改后置 stale，需重新确认。 */
export function saveQuestionRevision(
  questionId: string,
  baseVersion: number,
  fields: QuestionFields,
): Promise<RecognitionQuestion> {
  return requestJson<RecognitionQuestion>(`/api/questions/${questionId}/revision`, {
    method: "POST",
    body: JSON.stringify({ baseVersion, ...fields }),
  });
}

/** 确认逐题（版本 + 归属 + 乐观锁）：保存人工修订并递增确认版本。 */
export function confirmQuestion(
  questionId: string,
  baseVersion: number,
  fields: QuestionFields,
): Promise<RecognitionQuestion> {
  return requestJson<RecognitionQuestion>(`/api/questions/${questionId}/confirm`, {
    method: "POST",
    body: JSON.stringify({ baseVersion, ...fields }),
  });
}
