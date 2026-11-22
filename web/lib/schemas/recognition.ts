// 识别结果 Zod 结构（v1，忠实转录）。
// 与 docs/schemas/recognition-v1.schema.json 及 functions/recognition.mjs 的 validateRecognition 保持同构；
// 三者任一变更须同步其余两者。字段允许明确未知（null / uncertain / missing），不强制补全。
import { z } from "zod";
import { StepIndexSchema } from "./common";

const FieldStatusSchema = z.enum(["recognized", "uncertain", "missing"]);

export const RecognitionStepSchema = z.object({
  step_index: StepIndexSchema,
  content: z.string().nullable(),
  status: z.enum(["recognized", "uncertain", "missing", "blank"]),
});

export const RecognitionMarkSchema = z.object({
  kind: z.enum(["cross", "check", "circle", "score", "comment", "other"]),
  content: z.string().nullable(),
  status: FieldStatusSchema,
  location_hint: z.string().nullable().optional(),
});

export const RecognitionQuestionSchema = z.object({
  number: z.string().nullable(),
  number_status: FieldStatusSchema,
  stem: z.string().nullable(),
  stem_status: FieldStatusSchema,
  student_steps: z.array(RecognitionStepSchema),
  teacher_marks: z.array(RecognitionMarkSchema),
  uncertain_fields: z.array(z.string()),
  overall_status: z.enum(["recognized", "partial", "unreadable"]),
  /**
   * 第4天新增：逐题素材定位（指向本次识别输入图片序列的下标，0 起）。
   * - source_image_index：该题题干/学生作答所在图片下标（通常为原卷）。
   * - answer_image_index：该题批改标记所在图片下标（通常为答题卡）。
   * 允许 null / 缺省 = 对应关系不确定（服务端据此标记"待人工确认"，不伪造坐标）。
   * 服务端把下标映射为 asset_id + page_index；模型不给像素 bbox，区域用文字提示。
   */
  source_image_index: z.number().int().min(0).nullable().optional(),
  answer_image_index: z.number().int().min(0).nullable().optional(),
});

export const RecognitionV1Schema = z.object({
  schema_version: z.literal(1),
  source: z.object({
    asset_kind: z.enum(["original", "answer_sheet"]),
    page_index: z.number().int().min(0),
    object_key: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  }),
  questions: z.array(RecognitionQuestionSchema),
  unreadable_regions: z.array(
    z.object({ location_hint: z.string().min(1), reason: z.string().min(1) }),
  ),
  transcription_notes: z.string().nullable().optional(),
});
export type RecognitionV1 = z.infer<typeof RecognitionV1Schema>;