// 知识规则库 Zod 结构（v1）。依据 Brief §7.2：人工编写并核查；
// rule_id / 章节 / 规则陈述 / 适用条件 / 常见误用 / 人工参考来源 / 规则版本。
// 来源未经核实（verified=false）时必须给出 verification_note，不得编造页码或链接。
import { z } from "zod";
import { STRUCTURE_VERSION, KnowledgePointSchema } from "./common";

export const RuleSourceSchema = z
  .object({
    /** 来源描述：教材/课程标准/人工推导等；不填未核对的具体页码。 */
    description: z.string().min(1),
    /** 是否已人工核对原文。 */
    verified: z.boolean(),
    /** verified=false 时必填：说明核实计划或依据。 */
    verification_note: z.string().min(1).nullable().optional(),
    url: z.string().url().nullable().optional(),
  })
  .superRefine((s, ctx) => {
    if (!s.verified && !s.verification_note) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "rule.source: 未核实来源必须给出 verification_note" });
    }
  });

export const RuleSchema = z.object({
  schema_version: z.literal(STRUCTURE_VERSION),
  rule_id: z.string().regex(/^(SET|FUN|INE)-\d{2}$/),
  knowledge_point: KnowledgePointSchema,
  title: z.string().min(1),
  /** 数学陈述（忠实文字 + 可选 LaTeX，公式与业务字段分离）。 */
  statement: z.string().min(1),
  statement_latex: z.string().nullable().optional(),
  applicability_conditions: z.array(z.string().min(1)).min(1),
  common_misuses: z
    .array(
      z.object({
        misuse: z.string().min(1),
        example: z.string().min(1),
        related_error_category: z.string().min(1),
      }),
    )
    .min(1),
  source: RuleSourceSchema,
  rule_version: z.number().int().positive(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const RuleLibrarySchema = z.object({
  library_version: z.number().int().positive(),
  rules: z.array(RuleSchema).min(1),
});
export type RuleLibrary = z.infer<typeof RuleLibrarySchema>;