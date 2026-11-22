// 统一数据结构校验运行器（仅开发用，不部署、不调用模型）。
// 运行：node dev/run-schema-check.mjs（rolldown 打包后执行）。
// 内容：1) 各结构有效示例通过；2) 缺证据/非法状态/答案泄露等错误示例被拒绝；
//       3) 规则库 JSON 与固定样例 JSON 实际读取并校验。
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RecognitionV1Schema,
  DiagnosisSchema,
  HypothesisSchema,
  GeneratedItemSchema,
  PublicItemSchema,
  PublishableItemSchema,
  AttemptSchema,
  CheckSchema,
  TeachingContentSchema,
  RuleSchema,
  RuleLibrarySchema,
  EvidenceSchema,
} from "../lib/schemas/index";

const here = path.dirname(fileURLToPath(import.meta.url));
const docsDir = path.resolve(here, "../../docs");

let passed = 0;
let failed = 0;
function ok(name: string, fn: () => unknown) {
  try {
    fn();
    passed++;
    console.log(`PASS  ${name}`);
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}: ${(e as Error).message?.slice(0, 300)}`);
  }
}
function bad(name: string, fn: () => unknown) {
  try {
    fn();
    failed++;
    console.log(`FAIL  ${name}: 错误示例未被拒绝`);
  } catch {
    passed++;
    console.log(`PASS  ${name}（已拒绝）`);
  }
}

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-11-17T08:00:00Z";
const QID = uuid(101);
const TID = uuid(102);
const DID = uuid(103);

/* ---------- 识别 ---------- */
const recognitionValid = {
  schema_version: 1,
  source: { asset_kind: "answer_sheet", page_index: 0, object_key: "recognize-sample/input.img", note: null },
  questions: [
    {
      number: "16",
      number_status: "recognized",
      stem: null,
      stem_status: "missing",
      student_steps: [
        { step_index: 0, content: "设 t=xy", status: "recognized" },
        { step_index: 1, content: null, status: "uncertain" },
      ],
      teacher_marks: [{ kind: "cross", content: null, status: "uncertain", location_hint: "第5行左侧" }],
      uncertain_fields: ["questions[0].student_steps[1].content"],
      overall_status: "partial",
    },
  ],
  unreadable_regions: [{ location_hint: "右下角", reason: "笔迹过淡" }],
  transcription_notes: null,
};
ok("识别：有效示例（含 uncertain/missing）", () => RecognitionV1Schema.parse(recognitionValid));
bad("识别：schema_version=2 拒绝", () => RecognitionV1Schema.parse({ ...recognitionValid, schema_version: 2 }));
bad("识别：非法 overall_status 拒绝", () =>
  RecognitionV1Schema.parse({
    ...recognitionValid,
    questions: [{ ...recognitionValid.questions[0], overall_status: "guessed" }],
  }),
);
// 第4天：逐题素材定位下标（可选 nullable，向后兼容）
ok("识别：逐题定位下标有效", () =>
  RecognitionV1Schema.parse({
    ...recognitionValid,
    questions: [{ ...recognitionValid.questions[0], source_image_index: 0, answer_image_index: 1 }],
  }),
);
ok("识别：定位下标可为 null（对应关系不确定）", () =>
  RecognitionV1Schema.parse({
    ...recognitionValid,
    questions: [{ ...recognitionValid.questions[0], source_image_index: null, answer_image_index: null }],
  }),
);
ok("识别：定位下标可缺省（向后兼容）", () => RecognitionV1Schema.parse(recognitionValid));
bad("识别：负数定位下标拒绝", () =>
  RecognitionV1Schema.parse({
    ...recognitionValid,
    questions: [{ ...recognitionValid.questions[0], source_image_index: -1 }],
  }),
);
bad("识别：非整数定位下标拒绝", () =>
  RecognitionV1Schema.parse({
    ...recognitionValid,
    questions: [{ ...recognitionValid.questions[0], answer_image_index: 1.5 }],
  }),
);

/* ---------- 证据 ---------- */
const stepEvidence = { source_type: "student_step", question_id: QID, step_id: 0, snippet: "x+4/x ≥ 2√4 = 4" };
const condEvidence = { source_type: "question_condition", question_id: QID, snippet: "x≥3" };
ok("证据：学生步骤证据有效", () => EvidenceSchema.parse(stepEvidence));
bad("证据：student_step 缺 step_id 拒绝", () => EvidenceSchema.parse({ ...stepEvidence, step_id: null }));
bad("证据：无 question_id 且无 asset_id 拒绝", () => EvidenceSchema.parse({ source_type: "question_condition", snippet: "x≥3" }));

/* ---------- 诊断 ---------- */
const hypH1 = {
  hypothesis_id: "H1",
  category: "condition_omission",
  statement: "未检查等号点是否在范围内",
  applicability: "题目限定 x≥3，等号点 x=2 在范围外",
  support_status: "needs_verification",
  evidence: [stepEvidence, condEvidence],
  rule_ids: ["INE-02"],
};
const hypH2 = {
  hypothesis_id: "H2",
  category: "reasoning_gap",
  statement: "不会解等号条件方程",
  applicability: "仅凭作答无法与 H1 区分",
  support_status: "needs_verification",
  evidence: [stepEvidence],
  rule_ids: ["INE-03"],
};
const diagnosisValid = {
  schema_version: 1,
  diagnosis_id: DID,
  task_id: TID,
  question_id: QID,
  input_confirmation_version: 1,
  artifact_version: 1,
  knowledge_point: "basic_inequalities",
  first_error_step_id: 1,
  hypotheses: [hypH1, hypH2],
  diagnosis_status: "needs_verification",
  created_at: NOW,
  updated_at: NOW,
};
ok("诊断：双假设待验证有效", () => DiagnosisSchema.parse(diagnosisValid));
const hypInsufficient = {
  hypothesis_id: "H0",
  category: "insufficient_evidence",
  statement: "证据不足，无法定位错误步骤",
  applicability: "作答模糊，无法确认学生意图",
  support_status: "needs_verification",
  evidence: [],
  rule_ids: [],
  insufficient_reason: "缺少可辨认的学生步骤；需人工补录或诊断题进一步验证",
};
ok("诊断：证据不足假设有效（允许不确定）", () =>
  DiagnosisSchema.parse({
    ...diagnosisValid,
    first_error_step_id: null,
    hypotheses: [hypInsufficient],
    diagnosis_status: "insufficient_evidence",
  }),
);
bad("诊断：非证据不足假设缺证据拒绝", () => HypothesisSchema.parse({ ...hypH1, evidence: [] }));
bad("诊断：证据不足缺 insufficient_reason 拒绝", () => HypothesisSchema.parse({ ...hypInsufficient, insufficient_reason: null }));
bad("诊断：非证据不足假设缺 rule_id 拒绝", () => HypothesisSchema.parse({ ...hypH1, rule_ids: [] }));
bad("诊断：无法定位步骤却标 supported 拒绝", () =>
  DiagnosisSchema.parse({ ...diagnosisValid, first_error_step_id: null, diagnosis_status: "supported" }),
);
bad("诊断：超过3个假设拒绝", () =>
  DiagnosisSchema.parse({ ...diagnosisValid, hypotheses: [hypH1, hypH2, hypH1, hypH1] }),
);
bad("诊断：缺 input_confirmation_version 拒绝", () => {
  const { input_confirmation_version: _v, ...rest } = diagnosisValid;
  DiagnosisSchema.parse(rest);
});

/* ---------- 练习题目与答案分离 ---------- */
const itemValid = {
  schema_version: 1,
  item_id: uuid(201),
  task_id: TID,
  diagnosis_id: DID,
  question_id: QID,
  purpose: "diagnostic",
  target_hypothesis_id: "H2",
  stem: "x>0，写出 x+4/x≥4 等号成立时 x 的值及过程。",
  conditions: ["x>0"],
  answer_private: "x=4/x ⇒ x²=4 ⇒ x=2（取正根）",
  rubric_private: "写出方程并解得 x=2 记通过",
  artifact_version: 1,
  rule_ids: ["INE-03"],
  review_status: null,
  verification_status: null,
  created_at: NOW,
  updated_at: NOW,
};
ok("题目：完整服务端结构有效", () => GeneratedItemSchema.parse(itemValid));
const { answer_private: _a, rubric_private: _r, ...publicItem } = itemValid;
ok("题目：对外视图（无答案）有效", () => PublicItemSchema.parse(publicItem));
bad("题目：对外视图夹带 answer_private 拒绝", () => PublicItemSchema.parse(itemValid));
bad("题目：诊断题缺 target_hypothesis_id 拒绝", () => GeneratedItemSchema.parse({ ...itemValid, target_hypothesis_id: null }));
bad("发布：未审核（null）不得发布", () => PublishableItemSchema.parse(publicItem));
bad("发布：revise 不得发布", () => PublishableItemSchema.parse({ ...publicItem, review_status: "revise" }));
bad("发布：验证 failed 不得发布", () =>
  PublishableItemSchema.parse({ ...publicItem, review_status: "pass", verification_status: "failed" }),
);
ok("发布：当前版本 pass+passed 可发布", () =>
  PublishableItemSchema.parse({ ...publicItem, review_status: "pass", verification_status: "passed" }),
);
ok("作答：有效attempt", () =>
  AttemptSchema.parse({
    schema_version: 1,
    attempt_id: uuid(301),
    item_id: uuid(201),
    task_id: TID,
    student_response: "x=2",
    grading_result: "right",
    evidence: [],
    created_at: NOW,
  }),
);

/* ---------- 审核与验证 ---------- */
const checkBase = {
  schema_version: 1,
  check_id: uuid(401),
  task_id: TID,
  artifact_id: uuid(201),
  artifact_version: 1,
  issues: [],
  created_at: NOW,
};
ok("审核：模型 pass 有效", () =>
  CheckSchema.parse({ ...checkBase, check_type: "model_review", review_status: "pass", verification_status: "passed", requires_math_verification: true, reviewed_by: "model", human_note: null, model_run_id: uuid(501) }),
);
ok("审核：math_verify 工具四态之 unsupported 有效", () =>
  CheckSchema.parse({ ...checkBase, check_type: "math_verify", review_status: null, verification_status: "unsupported", requires_math_verification: true, reviewed_by: "tool", human_note: null }),
);
ok("审核：必需验证 unsupported 时人工复核 pass 有效", () =>
  CheckSchema.parse({ ...checkBase, check_type: "human_review", review_status: "pass", verification_status: "unsupported", requires_math_verification: true, reviewed_by: "human", human_note: "人工核对解题过程，SymPy 不支持该题型" }),
);
bad("审核：pass 携带 blocker 问题拒绝", () =>
  CheckSchema.parse({
    ...checkBase, check_type: "model_review", review_status: "pass", verification_status: "passed", requires_math_verification: false, reviewed_by: "model",
    issues: [{ type: "domain_omission", severity: "blocker", field_or_step: "stem", evidence: "缺 x≠2", suggestion: "补充条件" }],
  }),
);
bad("审核：验证 failed 仍 pass 拒绝", () =>
  CheckSchema.parse({ ...checkBase, check_type: "model_review", review_status: "pass", verification_status: "failed", requires_math_verification: true, reviewed_by: "model" }),
);
bad("审核：必需验证 unsupported 未经人工却 pass 拒绝", () =>
  CheckSchema.parse({ ...checkBase, check_type: "model_review", review_status: "pass", verification_status: "unsupported", requires_math_verification: true, reviewed_by: "model" }),
);
bad("审核：工具检查填写 review_status 拒绝", () =>
  CheckSchema.parse({ ...checkBase, check_type: "math_verify", review_status: "pass", verification_status: "passed", requires_math_verification: true, reviewed_by: "tool" }),
);
bad("审核：非法 review_status 拒绝", () =>
  CheckSchema.parse({ ...checkBase, check_type: "model_review", review_status: "approved", verification_status: null, requires_math_verification: false, reviewed_by: "model" }),
);
ok("教学：结构有效", () =>
  TeachingContentSchema.parse({ schema_version: 1, teaching_id: uuid(601), diagnosis_id: DID, task_id: TID, text: "指出原步骤→遗漏条件→正确做法→检查方法", artifact_version: 1, review_status: null, created_at: NOW, updated_at: NOW }),
);

/* ---------- 规则库 JSON 实际校验 ---------- */
const rulesJson = JSON.parse(readFileSync(path.join(docsDir, "rules/knowledge-rules-v1.json"), "utf8"));
ok("规则库：knowledge-rules-v1.json 通过 RuleLibrarySchema", () => RuleLibrarySchema.parse(rulesJson));
ok("规则库：9条且每章节3条、rule_id 唯一", () => {
  const rules = rulesJson.rules as Array<{ rule_id: string; knowledge_point: string }>;
  if (rules.length !== 9) throw new Error(`规则数 ${rules.length} ≠ 9`);
  const ids = new Set(rules.map((r) => r.rule_id));
  if (ids.size !== 9) throw new Error("rule_id 重复");
  for (const kp of ["sets", "functions", "basic_inequalities"]) {
    const n = rules.filter((r) => r.knowledge_point === kp).length;
    if (n !== 3) throw new Error(`${kp} 规则数 ${n} ≠ 3`);
  }
});
bad("规则：未核实来源缺 verification_note 拒绝", () =>
  RuleSchema.parse({ ...rulesJson.rules[0], source: { description: "某教材", verified: false, verification_note: null, url: null } }),
);
bad("规则：编造式非法 rule_id 拒绝", () => RuleSchema.parse({ ...rulesJson.rules[0], rule_id: "RULE-99" }));

/* ---------- 固定样例 JSON 实际校验（映射为统一结构） ---------- */
const samplesJson = JSON.parse(readFileSync(path.join(docsDir, "samples/fixed-01.json"), "utf8"));
const firstErrorStep: Record<string, number> = {
  "FIX-SET-01": 0, "FIX-SET-02": 0, "FIX-FUN-01": 0, "FIX-FUN-02": 1, "FIX-INE-01": 0, "FIX-INE-02": 1,
};
ok("样例集：6例、待人工复核标识、非真实学生数据来源标注", () => {
  if (samplesJson.samples.length !== 6) throw new Error("样例数 ≠ 6");
  if (samplesJson.review_status !== "pending_human_review") throw new Error("缺待人工复核标识");
  if (!String(samplesJson.source_label).includes("非真实学生数据")) throw new Error("缺测试来源标注");
});
for (const s of samplesJson.samples) {
  ok(`样例 ${s.sample_id}：错因假设映射为 Diagnosis 通过`, () => {
    DiagnosisSchema.parse({
      schema_version: 1,
      diagnosis_id: uuid(700),
      task_id: TID,
      question_id: QID,
      input_confirmation_version: 1,
      artifact_version: 1,
      knowledge_point: s.knowledge_point,
      first_error_step_id: firstErrorStep[s.sample_id],
      hypotheses: s.error_cause_hypotheses.map((h: Record<string, unknown>, i: number) => ({
        hypothesis_id: `h${i}`,
        ...h,
        evidence: (h.evidence as Array<Record<string, unknown>>).map((e) => ({ ...e, question_id: QID })),
      })),
      diagnosis_status: s.diagnosis_status,
      created_at: NOW,
      updated_at: NOW,
    });
  });
  for (const [i, it] of (s.diagnostic_items ?? []).entries()) {
    ok(`样例 ${s.sample_id}：诊断题${i + 1} 映射为 GeneratedItem 通过且答案可分离`, () => {
      const full = {
        schema_version: 1,
        item_id: uuid(800 + i),
        task_id: TID,
        diagnosis_id: uuid(700),
        question_id: QID,
        purpose: it.purpose,
        target_hypothesis_id: it.targets_hypothesis,
        stem: it.stem,
        conditions: it.conditions,
        answer_private: it.answer_private,
        rubric_private: it.rubric_private,
        artifact_version: 1,
        rule_ids: it.rule_ids,
        review_status: null,
        verification_status: null,
        created_at: NOW,
        updated_at: NOW,
      };
      GeneratedItemSchema.parse(full);
      const { answer_private: _a2, rubric_private: _r2, ...pub } = full;
      PublicItemSchema.parse(pub);
    });
  }
}
ok("样例集：至少一例'仅凭作答不能确定错因，需诊断题验证'且含双假设双诊断题", () => {
  const amb = samplesJson.samples.filter(
    (s: { expected_handling: string; error_cause_hypotheses: unknown[]; diagnostic_items?: unknown[] }) =>
      s.expected_handling.includes("仅凭作答不能确定错因") &&
      s.error_cause_hypotheses.length >= 2 &&
      (s.diagnostic_items?.length ?? 0) >= 2,
  );
  if (amb.length < 1) throw new Error("缺少需诊断题区分的样例");
});
ok("样例集：所有关联 rule_id 均存在于规则库", () => {
  const ids = new Set((rulesJson.rules as Array<{ rule_id: string }>).map((r) => r.rule_id));
  for (const s of samplesJson.samples) {
    for (const rid of s.linked_rule_ids) if (!ids.has(rid)) throw new Error(`${s.sample_id} 引用不存在的规则 ${rid}`);
    for (const it of s.diagnostic_items ?? []) for (const rid of it.rule_ids) if (!ids.has(rid)) throw new Error(`诊断题引用不存在的规则 ${rid}`);
  }
});

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);