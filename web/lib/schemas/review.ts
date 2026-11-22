// 独立审核与验证记录 Zod 结构（v1）。
// 依据 Brief §6.2 与 AGENTS.md §2：review_status ∈ pass/revise/needs_human_review；
// verification_status ∈ passed/failed/unsupported/timeout，后两者不等于通过；
// 人工复核通过只能标"人工审核通过"，不得显示"SymPy验证通过"。
import { z } from "zod";
import {
  STRUCTURE_VERSION,
  UuidSchema,
  VersionSchema,
  UtcDatetimeSchema,
  ReviewStatusSchema,
  VerificationStatusSchema,
  ReviewIssueSchema,
} from "./common";

export const CheckSchema = z
  .object({
    schema_version: z.literal(STRUCTURE_VERSION),
    check_id: UuidSchema,
    task_id: UuidSchema,
    artifact_id: UuidSchema,
    /** 审核绑定内容版本：内容修改后旧审核不继承（Brief §6）。 */
    artifact_version: VersionSchema,
    check_type: z.enum(["model_review", "rule_check", "math_verify", "human_review"]),
    /** 模型/人工审核结论；工具类检查（rule_check/math_verify）为 null，用 verification_status。 */
    review_status: ReviewStatusSchema.nullable(),
    verification_status: VerificationStatusSchema.nullable(),
    /** 该题型是否必需数学验证（由规则库/题型决定）。 */
    requires_math_verification: z.boolean(),
    issues: z.array(ReviewIssueSchema),
    reviewed_by: z.enum(["model", "human", "tool"]).nullable(),
    /** 人工复核通过时必填说明；不得冒充工具验证。 */
    human_note: z.string().min(1).nullable().optional(),
    model_run_id: UuidSchema.nullable().optional(),
    created_at: UtcDatetimeSchema,
  })
  .superRefine((c, ctx) => {
    const isTool = c.check_type === "rule_check" || c.check_type === "math_verify";
    if (isTool && c.review_status !== null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "check: 工具类检查不填写 review_status" });
    }
    if (isTool && c.verification_status === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "check: 工具类检查必须有 verification_status" });
    }
    if (!isTool && c.review_status === null) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "check: 模型/人工审核必须有 review_status" });
    }
    if (c.review_status === "pass" && c.issues.some((i) => i.severity === "blocker")) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "check: pass 不得携带 blocker 级问题" });
    }
    if (c.review_status === "pass" && c.verification_status === "failed") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "check: 验证 failed 时审核不得 pass" });
    }
    if (
      c.review_status === "pass" &&
      c.requires_math_verification &&
      (c.verification_status === "unsupported" || c.verification_status === "timeout")
    ) {
      if (c.reviewed_by !== "human" || !c.human_note) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "check: 必需数学验证但 unsupported/timeout 时，只有人工复核（reviewed_by=human + human_note）才可 pass",
        });
      }
    }
    if (c.check_type === "human_review" && c.reviewed_by !== "human") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "check: human_review 的 reviewed_by 必须为 human" });
    }
  });
export type Check = z.infer<typeof CheckSchema>;

/** 教学/讲解内容记录（结构定义，业务未实现）。讲解审核复用 CheckSchema。 */
export const TeachingContentSchema = z.object({
  schema_version: z.literal(STRUCTURE_VERSION),
  teaching_id: UuidSchema,
  diagnosis_id: UuidSchema,
  task_id: UuidSchema,
  /** 讲解正文：指出学生原步骤 → 遗漏条件/错误规则 → 正确做法 → 检查方法。 */
  text: z.string().min(1),
  artifact_version: VersionSchema,
  review_status: ReviewStatusSchema.nullable(),
  verification_status: VerificationStatusSchema.nullable().optional(),
  created_at: UtcDatetimeSchema,
  updated_at: UtcDatetimeSchema,
});
export type TeachingContent = z.infer<typeof TeachingContentSchema>;