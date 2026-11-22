// 本地内存适配器（仅开发/测试用，不部署）：内存版 db/storage + BackendError + 模拟模型。
// 被 function-local.mjs（HTTP 服务）与进程内测试共用，跑 functions/routes.mjs 的真实业务路由。
// 真实部署使用平台注入的 _qoder SDK（见 functions/index.ts）。模拟模型绝不产生付费调用。

/* ---------- 内存版 db ---------- */
export function makeDb() {
  const tables = { tasks: [], confirmations: [], assets: [], jobs: [], model_runs: [], questions: [], diagnoses: [], generated_items: [], attempts: [], checks: [], teaching_contents: [], learning_sessions: [] };

  class Query {
    constructor(table, op, payload, conflict) {
      this.table = table;
      this.op = op;
      this.payload = payload;
      this.conflict = conflict;
      this.filters = [];
      this.orders = [];
      this.limitN = Infinity;
      this.fields = "*";
    }
    eq(col, val) {
      this.filters.push({ col, val });
      return this;
    }
    order(col, opts) {
      this.orders.push({ col, asc: !opts || opts.ascending !== false });
      return this;
    }
    limit(n) {
      this.limitN = n;
      return this;
    }
    select(fields) {
      this.fields = fields;
      return this;
    }
    update(payload) {
      this.op = "update";
      this.payload = payload;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    then(resolve, reject) {
      return this.execute().then(resolve, reject);
    }
    async execute() {
      const store = tables[this.table];
      if (this.op === "insert" || this.op === "insertIfAbsent") {
        if (this.op === "insertIfAbsent") {
          const conflictColumns = Array.isArray(this.conflict?.onConflict)
            ? this.conflict.onConflict
            : String(this.conflict?.onConflict).split(",");
          const exists = store.some((r) => conflictColumns.every((col) => r[col] === this.payload[col]));
          if (exists) return { data: [] };
        }
        const row = { ...this.payload };
        if (row.id === undefined) row.id = crypto.randomUUID();
        if (row.created_at === undefined) row.created_at = new Date().toISOString();
        if (row.updated_at === undefined) row.updated_at = row.created_at; // 镜像 DB DEFAULT now()
        store.push(row);
        return { data: [pick(row, this.fields)] };
      }
      let matched = store.filter((r) => this.filters.every((f) => r[f.col] === f.val));
      if (this.op === "update") {
        for (const r of matched) Object.assign(r, this.payload);
      } else if (this.op === "delete") {
        const remove = new Set(matched);
        tables[this.table] = store.filter((r) => !remove.has(r));
      }
      // 多列稳定排序（后声明的列优先级更高，与 PostgREST order 链一致）
      for (const { col, asc } of [...this.orders].reverse()) {
        matched = [...matched].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
          return asc ? cmp : -cmp;
        });
      }
      matched = matched.slice(0, this.limitN);
      return { data: matched.map((r) => pick(r, this.fields)) };
    }
  }

  const pick = (row, fields) => {
    if (fields === "*") return { ...row };
    const out = {};
    for (const f of fields.split(",")) out[f.trim()] = row[f.trim()];
    return out;
  };

  return {
    from: (table) => ({
      select: (f) => new Query(table, "select", null, null).select(f),
      insert: (payload) => new Query(table, "insert", payload, null),
      insertIfAbsent: (payload, conflict) => new Query(table, "insertIfAbsent", payload, conflict),
      update: (payload) => new Query(table, "update", payload, null),
      delete: () => new Query(table, "delete", null, null),
    }),
    _raw: tables,
  };
}

/* ---------- 内存版 storage ---------- */
export function makeStorage() {
  const objects = new Map();
  return {
    async upload(objectPath, bytes, opts) {
      objects.set(objectPath, { bytes: new Uint8Array(bytes), contentType: opts?.contentType ?? "application/octet-stream" });
      return { path: objectPath };
    },
    async download(objectPath) {
      const obj = objects.get(objectPath);
      if (!obj) {
        const e = new Error("storage_object_not_found");
        e.code = "storage_object_not_found";
        throw e;
      }
      return new Response(obj.bytes, { headers: { "content-type": obj.contentType } });
    },
    async remove(paths) {
      for (const p of paths) {
        if (!objects.delete(p)) {
          const e = new Error("storage_object_not_found");
          e.code = "storage_object_not_found";
          throw e;
        }
      }
      return { removed: paths };
    },
    _objects: objects,
  };
}

/* ---------- 平台入口的本地等价物 ---------- */
export class BackendError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function errorResponse(error, requestId) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  return Response.json(
    { error: error?.code ?? "internal_error", status, requestId: requestId ?? null },
    { status },
  );
}

/* ---------- 本地模拟模型（绝不产生付费调用，结果带显眼"模拟"标识） ---------- */
// behavior: ok（默认）/ timeout / fail / badjson / unconfigured。
export function makeMockModel(behavior = "ok") {
  const configured = behavior !== "unconfigured";
  return {
    isConfigured: () => ({ configured, missing: configured ? [] : ["MODEL_API_KEY"] }),
    async recognize({ prompt = "" } = {}) {
      if (!configured) return { ok: false, errorCode: "not_configured", latencyMs: 0 };
      if (behavior === "timeout") return { ok: false, errorCode: "model_timeout", latencyMs: 48000 };
      if (behavior === "fail") return { ok: false, errorCode: "model_failed", latencyMs: 80 };
      if (behavior === "badjson") {
        return { ok: true, content: "这不是 JSON", actualModelId: "mock-vision", providerRequestId: "mock-req", usage: { input: 10, output: 5, total: 15 }, latencyMs: 30 };
      }
      if (prompt.includes("只建立本图片的题号目录")) {
        return { ok: true, content: JSON.stringify({ numbers: ["1"], unreadable_regions: [] }), actualModelId: "mock-vision" };
      }
      const isPaper = prompt.includes("材料类别由服务端确定为 原卷：") || prompt.includes("真实素材为原卷");
      const draft = {
        schema_version: 1,
        page_status: "read",
        numbers: ["1"],
        source: { asset_kind: isPaper ? "original" : "answer_sheet", page_index: 0, note: "本地模拟" },
        questions: [
          {
            number: "1",
            number_status: "recognized",
            stem: isPaper ? "（模拟）已知 0 < x ≤ 1，求 f(x) = x + 4/x 的最小值。" : null,
            stem_status: isPaper ? "recognized" : "missing",
            student_steps: isPaper ? [] : [
              { step_index: 0, content: "（模拟）由基本不等式 x + 4/x ≥ 4，当 x = 2 取等号，故最小值为 4。", status: "recognized" },
            ],
            teacher_marks: isPaper ? [] : [{ kind: "cross", content: "×", status: "recognized", scope: "question", location_hint: "答案右侧" }],
            uncertain_fields: [],
            overall_status: "recognized",
            source_image_index: 0,
            answer_image_index: isPaper ? null : 0,
          },
        ],
        unreadable_regions: [],
        transcription_notes: "本地模拟识别结果，非真实模型输出。",
      };
      return {
        ok: true,
        content: JSON.stringify(draft),
        actualModelId: "mock-vision",
        providerRequestId: `mock-req-${Date.now()}`,
        usage: { input: 100, output: 200, total: 300 },
        latencyMs: 40,
      };
    },
    simulated: true,
    roleConfigured: () => ({ configured, missing: configured ? [] : ["REVIEW_MODEL"] }),
    modelIds: () => ({ diagnosis: "qwen-mock", tutor: "qwen-mock", review: "deepseek-mock" }),
    async generate(role, prompt = "") {
      if (!configured) return { ok: false, errorCode: "not_configured", latencyMs: 0 };
      if (behavior === "timeout") return { ok: false, errorCode: "model_timeout", latencyMs: 48000 };
      if (behavior === "fail") return { ok: false, errorCode: "model_failed", latencyMs: 30 };
      const ok = (value) => ({ok:true,content:behavior === "badjson" ? "invalid json" : JSON.stringify(value),
        actualModelId:role==="review" ? "deepseek-mock" : "qwen-mock", providerRequestId:"mock-" + crypto.randomUUID(),latencyMs:25});
      const embedded = (prefix) => JSON.parse(prompt.split("\n").find((line)=>line.startsWith(prefix)).slice(prefix.length));
      if (prompt.includes("独立审核员")) {
        const {artifacts} = embedded("输入资料：");
        return ok({reviews:artifacts.map((a) => ({artifact_id:a.id,artifact_version:a.artifact_version,review_status:"pass",math_coverage:"covered",issues:[]}))});
      }
      if (prompt.includes("按每题给定评分规则")) {
        return ok({grades:embedded("数据：").map((a) => ({item_id:a.id,result:"right",note:"（模拟）指出了取等点。",effect:"weakens"}))});
      }
      if (prompt.includes("针对性讲解")) {
        const info = embedded("数据：");
        return ok({steps:[{step_id:info.question.steps[0].step_id,title:"检查取等条件",text:"（模拟）原步骤里的 $x=2$ 超出题设范围。"},
          {step_id:null,title:"比较定义域内的值",text:"在 $0<x\\le 1$ 时，$x+4/x-5=(x-1)(x-4)/x\\ge 0$，最小值 5 在 $x=1$ 取得。"}],
          rule_ids:["INE-02"],math_claims:[{kind:"inequality",left:{op:"add",args:["x",{op:"div",args:[4,"x"]}]},right:5,relation:"ge",
          domain:{lower:0,upper:1,lower_closed:false,upper_closed:true},expected:{lower:0,upper:1,lower_closed:false,upper_closed:true}}]});
      }
      const q = embedded("原文：");
      const step = q.steps[0];
      return ok({ knowledge_point:"basic_inequalities", first_error_step_id:step?.step_id ?? null, hypotheses:[step ? {
        category:"condition_omission", statement:"（模拟）可能遗漏等号可取得性检查", applicability:"用基本不等式求最小值",
        evidence:[{step_id:step.step_id,snippet:step.content.slice(0,60)}],rule_ids:["INE-02"],
      } : {category:"insufficient_evidence",statement:"（模拟）暂不能定位错误步骤",applicability:"作答缺少过程",
        insufficient_reason:"请补充基本不等式的推导过程。",evidence:[],rule_ids:[]}] });
    },
  };
}
