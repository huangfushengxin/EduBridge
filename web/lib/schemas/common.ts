// EduBridge 统一数据结构 — 公共字段与枚举（Zod）。
// 依据 docs/PROJECT_BRIEF.md §6.2、§8 与 AGENTS.md 硬性规则。
// 本轮只定义结构与示例，不实现业务调用。
import { z } from "zod";

/** 各业务结构的结构版本常量；内容不兼容变更时递增并保留旧版校验。 */
export const STRUCTURE_VERSION = 1 as const;

export const UuidSchema = z.string().uuid();
export const VersionSchema = z.number().int().positive();
export const StepIndexSchema = z.number().int().min(0);
/** UTC 存储（ISO8601，Z 或显式偏移）；界面按北京时间展示。 */
export const UtcDatetimeSchema = z.string().datetime({ offset: true });

export const KnowledgePointSchema = z.enum(["sets", "functions", "basic_inequalities"]);

/** 错因类别（Brief §2.2）。insufficient_evidence 表示证据不足，不作确定判断。 */
export const ErrorCategorySchema = z.enum([
  "concept_confusion", // 概念混淆
  "condition_omission", // 条件遗漏
  "domain_omission", // 定义域遗漏
  "incomplete_case_split", // 分类不全
  "arithmetic_error", // 运算失误
  "reasoning_gap", // 推理缺失
  "insufficient_evidence", // 证据不足
]);

/** 假设支持状态（Brief §2.2）：得到支持 / 未得到支持 / 仍需验证。 */
export const SupportStatusSchema = z.enum(["supported", "not_supported", "needs_verification"]);

/** 审核结论（Brief §6.2）。null 表示尚未审核（草稿），发布门槛另见 PublishableItemSchema。 */
export const ReviewStatusSchema = z.enum(["pass", "revise", "needs_human_review"]);

/** 数学/规则工具验证四态（Brief §6.2）：unsupported 与 timeout 不等于通过。 */
export const VerificationStatusSchema = z.enum(["passed", "failed", "unsupported", "timeout"]);

export const GradingResultSchema = z.enum(["wrong", "right", "ungraded", "unclear"]);

/**
 * 证据（Brief §8）：source_type、asset_id 或 question_id、step_id、snippet、bbox 或位置说明。
 * bbox 仅为定位建议，允许人工调整；模型不得虚构精确像素证据。
 */
export const EvidenceSchema = z
  .object({
    source_type: z.enum(["student_step", "question_condition", "teacher_mark", "asset_region"]),
    question_id: UuidSchema.nullable().optional(),
    asset_id: z.string().min(1).nullable().optional(),
    step_id: StepIndexSchema.nullable().optional(),
    snippet: z.string().min(1),
    location_hint: z.string().min(1).nullable().optional(),
    bbox: z
      .object({ x: z.number(), y: z.number(), w: z.number().positive(), h: z.number().positive() })
      .nullable()
      .optional(),
  })
  .superRefine((e, ctx) => {
    if (!e.question_id && !e.asset_id) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidence: question_id 与 asset_id 至少其一" });
    }
    if (e.source_type === "student_step" && (e.step_id === null || e.step_id === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidence: student_step 必须给出 step_id" });
    }
    if (e.source_type === "asset_region" && !e.location_hint && !e.bbox) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidence: asset_region 必须给出位置说明或 bbox" });
    }
  });
export type Evidence = z.infer<typeof EvidenceSchema>;

/** 审核问题项（Brief §6.2）：问题类型、严重程度、对应字段或步骤、证据、修改建议。 */
export const ReviewIssueSchema = z.object({
  type: z.enum([
    "math_error",
    "missing_condition",
    "domain_omission",
    "equality_unreachable",
    "evidence_missing",
    "answer_leak",
    "format",
    "other",
  ]),
  severity: z.enum(["blocker", "major", "minor"]),
  field_or_step: z.string().min(1),
  evidence: z.string().min(1),
  suggestion: z.string().min(1),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;