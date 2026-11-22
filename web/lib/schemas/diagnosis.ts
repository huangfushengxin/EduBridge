// 错因诊断 Zod 结构（v1）。
// 硬性规则（AGENTS.md §2、Brief §2.2/§8）：错因是假设不是定论；每项假设引用具体学生步骤或题目条件；
// 允许"证据不足 / 仍需验证"，不强制生成确定错因；诊断必须引用 rule_id 并关联确认版本。
import { z } from "zod";
import {
  STRUCTURE_VERSION,
  UuidSchema,
  VersionSchema,
  StepIndexSchema,
  UtcDatetimeSchema,
  KnowledgePointSchema,
  ErrorCategorySchema,
  SupportStatusSchema,
  EvidenceSchema,
} from "./common";

export const HypothesisSchema = z
  .object({
    hypothesis_id: z.string().min(1),
    category: ErrorCategorySchema,
    statement: z.string().min(1),
    /** 适用条件：该错因解释成立的前提（如变量范围、题目条件）。 */
    applicability: z.string().min(1),
    support_status: SupportStatusSchema,
    evidence: z.array(EvidenceSchema),
    rule_ids: z.array(z.string().min(1)),
    /** category=insufficient_evidence 时必填：说明缺什么证据、下一步如何补。 */
    insufficient_reason: z.string().min(1).nullable().optional(),
  })
  .superRefine((h, ctx) => {
    if (h.category === "insufficient_evidence") {
      if (!h.insufficient_reason) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "hypothesis: 证据不足必须给出 insufficient_reason" });
      }
    } else if (h.evidence.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `hypothesis ${h.hypothesis_id}: 非证据不足类别必须至少一条证据（step_id 或题目条件）`,
      });
    }
    if (h.category !== "insufficient_evidence" && h.rule_ids.length === 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `hypothesis ${h.hypothesis_id}: 必须引用 rule_id` });
    }
  });
export type Hypothesis = z.infer<typeof HypothesisSchema>;

export const DiagnosisSchema = z
  .object({
    schema_version: z.literal(STRUCTURE_VERSION),
    diagnosis_id: UuidSchema,
    task_id: UuidSchema,
    question_id: UuidSchema,
    /** 输入确认版本：确认修改后旧诊断过期（Brief §2.1/§6）。 */
    input_confirmation_version: VersionSchema,
    artifact_version: VersionSchema,
    knowledge_point: KnowledgePointSchema,
    /** 首个可定位错误步骤；无法定位时为 null，且整体状态必须为证据不足。 */
    first_error_step_id: StepIndexSchema.nullable(),
    hypotheses: z.array(HypothesisSchema).min(1).max(3),
    diagnosis_status: z.enum(["needs_verification", "supported", "not_supported", "insufficient_evidence"]),
    created_at: UtcDatetimeSchema,
    updated_at: UtcDatetimeSchema,
  })
  .superRefine((d, ctx) => {
    if (d.first_error_step_id === null && d.diagnosis_status !== "insufficient_evidence") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "diagnosis: 无法定位错误步骤时 diagnosis_status 必须为 insufficient_evidence",
      });
    }
    if (d.diagnosis_status === "insufficient_evidence" && !d.hypotheses.some((h) => h.category === "insufficient_evidence")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "diagnosis: 整体证据不足必须包含至少一条 insufficient_evidence 假设",
      });
    }
    if (d.diagnosis_status === "supported" && !d.hypotheses.some((h) => h.support_status === "supported")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "diagnosis: supported 状态必须有得到支持的假设" });
    }
  });
export type Diagnosis = z.infer<typeof DiagnosisSchema>;