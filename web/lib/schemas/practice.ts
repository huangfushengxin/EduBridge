// 针对性练习（诊断题/复测题）与作答 Zod 结构（v1）。
// 答案与解析分离（AGENTS.md §2.4、Brief §8）：answer_private / rubric_private 只存在于服务端完整结构；
// 对外视图 PublicItemSchema 以 strict() 拒绝携带私有字段；发布门槛 PublishableItemSchema 要求当前版本审核通过。
import { z } from "zod";
import {
  STRUCTURE_VERSION,
  UuidSchema,
  VersionSchema,
  UtcDatetimeSchema,
  GradingResultSchema,
  ReviewStatusSchema,
  VerificationStatusSchema,
  EvidenceSchema,
} from "./common";

const GeneratedItemBaseSchema = z.object({
    schema_version: z.literal(STRUCTURE_VERSION),
    item_id: UuidSchema,
    task_id: UuidSchema,
    diagnosis_id: UuidSchema,
    question_id: UuidSchema,
    purpose: z.enum(["diagnostic", "retest"]),
    /** 诊断题必须指向一个待验证假设；复测题可为 null（同知识点新题）。 */
    target_hypothesis_id: z.string().min(1).nullable(),
    stem: z.string().min(1),
    conditions: z.array(z.string().min(1)),
    answer_private: z.string().min(1),
    rubric_private: z.string().min(1),
    artifact_version: VersionSchema,
    rule_ids: z.array(z.string().min(1)).min(1),
    /** null = 尚未审核（草稿）；发布必须 pass（见 PublishableItemSchema）。 */
    review_status: ReviewStatusSchema.nullable(),
    verification_status: VerificationStatusSchema.nullable(),
    created_at: UtcDatetimeSchema,
    updated_at: UtcDatetimeSchema,
  });

export const GeneratedItemSchema = GeneratedItemBaseSchema.superRefine((it, ctx) => {
  if (it.purpose === "diagnostic" && !it.target_hypothesis_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "item: 诊断题必须指定 target_hypothesis_id" });
  }
});
export type GeneratedItem = z.infer<typeof GeneratedItemSchema>;

/** 学生未作答阶段对外返回的题目视图：不含答案与评分规则；strict 拒绝夹带私有字段。 */
export const PublicItemSchema = GeneratedItemBaseSchema.omit({
  answer_private: true,
  rubric_private: true,
}).strict();
export type PublicItem = z.infer<typeof PublicItemSchema>;

/** 发布门槛：仅当前 artifact_version 审核 pass 且验证非 failed 才可发布；人工通过须 reviewed_by=human（见 review.ts）。 */
export const PublishableItemSchema = PublicItemSchema.superRefine((it, ctx) => {
  if (it.review_status !== "pass") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "publish: 审核未通过（含未审核）不得发布" });
  }
  if (it.verification_status === "failed") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "publish: 数学验证 failed 不得发布" });
  }
});

export const AttemptSchema = z.object({
  schema_version: z.literal(STRUCTURE_VERSION),
  attempt_id: UuidSchema,
  item_id: UuidSchema,
  task_id: UuidSchema,
  student_response: z.string().min(1),
  grading_result: GradingResultSchema,
  evidence: z.array(EvidenceSchema),
  created_at: UtcDatetimeSchema,
});
export type Attempt = z.infer<typeof AttemptSchema>;