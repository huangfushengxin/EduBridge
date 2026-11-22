// 单任务模型调用预算：默认 12 个槽位；联调可用站点环境变量 EB_TASK_BUDGET_OVERRIDES 按任务提额。
// 覆盖值只接受 JSON 对象 { "<task-uuid>": 正整数 }，上限 100；缺失或非法一律回退默认 12。
// 先落库占位，再请求供应商；并发占位、归属与调用流水结构不变。
export const MODEL_LIMIT = 12;
export const MAX_TASK_BUDGET = 100;
const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 解析站点环境变量中的单任务预算覆盖；非法输入静默回退为空（即全部用默认 12）。
export function parseBudgetOverrides(raw) {
  if (!raw) return {};
  let value;
  try {
    value = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const overrides = {};
  for (const [taskId, limit] of Object.entries(value)) {
    if (TASK_ID.test(taskId) && Number.isInteger(limit) && limit >= 1 && limit <= MAX_TASK_BUDGET) {
      overrides[taskId.toLowerCase()] = limit;
    }
  }
  return overrides;
}

export function modelBudget(db, rows, { overrides = {} } = {}) {
  const limit = (taskId) => overrides[String(taskId ?? "").toLowerCase()] ?? MODEL_LIMIT;
  const list = (taskId, owner) =>
    db.from("model_runs").select("id").eq("task_id", taskId).eq("owner_token_hash", owner).limit(limit(taskId));
  const count = async (taskId, owner) => (rows(await list(taskId, owner)) ?? []).length;

  async function reserve(taskId, owner, jobId, role, promptVersion) {
    const cap = limit(taskId);
    // 按当前数量竞争同一槽位；旧版随机 UUID 记录也计入数量。
    for (let retry = 0; retry < cap; retry++) {
      const used = await count(taskId, owner);
      if (used >= cap) return null;
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(taskId + "/model-slot/" + used));
      const h = Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, "0")).join("");
      const id = h.slice(0, 8) + "-" + h.slice(8, 12) + "-4" + h.slice(13, 16) + "-a" + h.slice(17, 20) + "-" + h.slice(20, 32);
      const inserted = rows(
        await db.from("model_runs").insertIfAbsent({
          id, task_id: taskId, owner_token_hash: owner, job_id: jobId, role, status: "failed",
          schema_version: 1, prompt_version: promptVersion, error_code: "model_interrupted",
        }, { onConflict: "id" }).select("id"),
      );
      if (inserted?.length) return id;
    }
    return null;
  }

  async function finish(id, owner, result) {
    rows(await db.from("model_runs").update({
      actual_model_id: result.actualModelId ?? null, provider_request_id: result.providerRequestId ?? null,
      usage_input: result.usage?.input ?? null, usage_output: result.usage?.output ?? null,
      usage_total: result.usage?.total ?? null, latency_ms: result.latencyMs ?? null,
      status: result.ok ? "succeeded" : result.errorCode === "model_timeout" ? "timeout" : "failed",
      error_code: result.ok ? null : (result.errorCode ?? "model_failed"),
    }).eq("id", id).eq("owner_token_hash", owner).select("id"));
  }

  return { count, reserve, finish, limit };
}
