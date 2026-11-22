import { Link } from "@/lib/router";
/**
 * 第4天：自选图片模式的识别驱动确认面板。
 * 绑定上传 store 的 activeTaskId（图片所在任务），用 useRecognition 管理识别任务与逐题记录。
 * - 识别仅由用户点击"开始识别"触发；上传/刷新/预览不自动调用模型。
 * - 展示等待/识别中/成功/失败/未配置状态，中文错误 + 明确重试入口。
 * - 材料区展示原图，逐题支持编辑、保存修订、确认及重新确认。
 * - 模型原始草稿（draft）与人工修订（human）分别保存；老师批改不自动判对错。
 * - 保留"人工录入回退"（不依赖识别，走任务级确认接口）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CheckCircle2,
  Eraser,
  Images,
  Info,
  Loader2,
  PenLine,
  Play,
  RefreshCw,
  Save,
  ScanLine,
  TriangleAlert,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import {
  ApiError,
  describeError,
  ensureTask,
  readConfirmation,
  saveConfirmation,
  type GradingResult,
  type RecognitionQuestion,
  type QuestionFields,
} from "@/lib/api";
import { MathText } from "@/components/MathText";
import { GRADING_OPTIONS } from "@/lib/demo";
import { useRecognition } from "@/lib/recognition";
import { useUploads, type FileItem } from "@/lib/store";

const MARK_KIND_LABEL: Record<string, string> = {
  cross: "叉",
  check: "勾",
  circle: "圈注",
  score: "分数",
  comment: "批注",
  other: "其他标记",
};

function formatBeijing(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) + "（北京时间）";
}

function statusLabel(status: string): string {
  switch (status) {
    case "blank":
      return "空白";
    case "recognized":
      return "已识别";
    case "uncertain":
      return "待人工确认";
    case "missing":
      return "缺失";
    case "partial":
      return "部分识别";
    case "unreadable":
      return "无法识别";
    default:
      return status;
  }
}

/* ---------- 单题卡片 ---------- */

interface QuestionCardProps {
  question: RecognitionQuestion;
  onSaveRevision: (id: string, baseVersion: number, fields: QuestionFields) => Promise<RecognitionQuestion>;
  onConfirm: (id: string, baseVersion: number, fields: QuestionFields) => Promise<RecognitionQuestion>;
}

function fieldsFromQuestion(q: RecognitionQuestion): QuestionFields {
  if (q.human) return q.human;
  return {
    number: q.number ?? "",
    stem: q.stem ?? "",
    studentAnswer: q.studentAnswer ?? "",
    gradingResult: q.teacherResult ?? "unclear",
    gradingNote: q.note ?? "",
  };
}

export function QuestionCard({ question, onSaveRevision, onConfirm }: QuestionCardProps) {
  const [fields, setFields] = useState<QuestionFields>(() => fieldsFromQuestion(question));
  const [busy, setBusy] = useState<"idle" | "saving" | "confirming">("idle");
  const [cardError, setCardError] = useState<string | null>(null);
  const serverFields = JSON.stringify(fieldsFromQuestion(question));
  const syncedVersion = useRef(serverFields);

  // 服务端版本变化（确认/修订成功或刷新恢复）时同步本地编辑内容。
  useEffect(() => {
    if (syncedVersion.current !== serverFields) {
      syncedVersion.current = serverFields;
      setFields(fieldsFromQuestion(question));
      setCardError(null);
    }
  }, [question]);

  const setField = (key: keyof QuestionFields, value: string) =>
    setFields((prev) => ({ ...prev, [key]: value }));

  const savedFields = fieldsFromQuestion(question);
  const dirty =
    fields.number !== savedFields.number ||
    fields.stem !== savedFields.stem ||
    fields.studentAnswer !== savedFields.studentAnswer ||
    fields.gradingResult !== savedFields.gradingResult ||
    fields.gradingNote !== savedFields.gradingNote;

  const marks = Array.isArray(question.teacherMarks) ? question.teacherMarks : [];
  const fs = question.fieldStatus ?? {};
  const gradeLabel = question.teacherResult === "right" ? "整题勾"
    : question.teacherResult === "wrong" ? "整题叉" : "需要人工核对";
  const pageLabels = [
    question.sourcePageIndex == null ? null : `原卷第 ${question.sourcePageIndex + 1} 页`,
    question.answerPageIndex == null ? null : `答题卡第 ${question.answerPageIndex + 1} 页`,
  ].filter(Boolean);

  const doSave = async () => {
    setBusy("saving");
    setCardError(null);
    try {
      await onSaveRevision(question.id, question.confirmedVersion, fields);
    } catch (e) {
      setCardError(describeError(e));
    } finally {
      setBusy("idle");
    }
  };

  const doConfirm = async () => {
    setBusy("confirming");
    setCardError(null);
    try {
      await onConfirm(question.id, question.confirmedVersion, fields);
    } catch (e) {
      setCardError(describeError(e));
    } finally {
      setBusy("idle");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-base">
          <ScanLine className="size-4 text-muted-foreground" />
          第 {question.number || question.seq + 1} 题
          {question.status === "confirmed" && !dirty ? (
            <Badge className="gap-1.5">
              <CheckCircle2 className="size-3.5" />
              已确认 · v{question.confirmedVersion}
            </Badge>
          ) : question.status === "stale" || (question.status === "confirmed" && dirty) ? (
            <Badge variant="destructive">内容已修改，需重新确认</Badge>
          ) : (
            <Badge variant="outline">待人工确认</Badge>
          )}
        </CardTitle>
        <CardDescription>
          {pageLabels.length > 0 ? pageLabels.join(" · ") + "。可在上方材料区核对原图。" : "可在上方材料区核对原图。"}
          {question.confirmedAt ? ` 最近确认：${formatBeijing(question.confirmedAt)}。` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {question.locationHint && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            {question.locationHint}
          </p>
        )}

        {/* 识别状态提示 */}
        <div className="flex flex-wrap gap-1.5">
          {(["number", "stem", "overall", "linkage", "teacher"] as const).map((k) =>
            fs[k] && fs[k] !== "recognized" ? (
              <Badge key={k} variant="outline" className="border-amber-500/50 text-amber-600">
                {k === "number" ? "题号" : k === "stem" ? "题干" : k === "overall" ? "整体" : k === "linkage" ? "素材对应" : "批改"}：{statusLabel(fs[k])}
              </Badge>
            ) : null,
          )}
        </div>

        {question.fieldStatus?.linkage === "recognized" && <p className="text-xs text-muted-foreground">原卷与答题卡已按题号匹配，请对照上方来源页核对。</p>}
        {question.fieldStatus?.answer === "blank" && <p className="text-xs text-muted-foreground">答题卡该题显示为空白，请人工核对。</p>}

        {/* 老师批改标记（判错依据，不自动覆盖） */}
        <div className="rounded-lg border border-border p-3">
          <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <PenLine className="size-3.5" />
            老师批改标记 · {gradeLabel}
          </p>
          {marks.length === 0 ? (
            <p className="text-sm text-muted-foreground">未识别到批改标记（可能缺失或待确认）。</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {marks.map((m, i) => {
                const mark = m as { kind?: string; content?: string | null; status?: string; location_hint?: string | null; scope?: string };
                return (
                  <li key={i} className="flex flex-wrap items-center gap-2">
                    <span>{MARK_KIND_LABEL[mark.kind ?? "other"] ?? mark.kind}</span>
                    {mark.scope === "partial" && <Badge variant="outline">局部标记</Badge>}
                    {mark.scope === "unknown" && <Badge variant="outline">归属待确认</Badge>}
                    {mark.content ? <span className="text-muted-foreground">「{mark.content}」</span> : null}
                    {mark.status && mark.status !== "recognized" ? (
                      <Badge variant="outline" className="border-amber-500/50 text-amber-600">{statusLabel(mark.status)}</Badge>
                    ) : null}
                    {mark.location_hint ? <span className="text-xs text-muted-foreground">{mark.location_hint}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <Separator />

        {/* 可编辑识别内容 */}
        <div className="grid gap-4">
          <div className="max-w-40">
            <Label htmlFor={`q-number-${question.id}`}>题号</Label>
            <Input
              id={`q-number-${question.id}`}
              value={fields.number ?? ""}
              placeholder="可留空"
              onChange={(e) => setField("number", e.target.value)}
              className="mt-1.5"
            />
          </div>
          <div>
            <p className="mb-2 font-medium">题干</p>
            <div className="rounded-md border p-3"><MathText text={fields.stem} /></div>
            <details className="mt-2"><summary className="cursor-pointer text-sm text-muted-foreground">编辑题干（支持 LaTeX 公式）</summary>
            <Label className="sr-only" htmlFor={`q-stem-${question.id}`}>编辑题干</Label>
            <Textarea id={`q-stem-${question.id}`} value={fields.stem ?? ""} onChange={(e) => setField("stem", e.target.value)} rows={3} className="mt-2" /></details>
          </div>
          <div>
            <p className="mb-2 font-medium">学生作答</p>
            <div className="rounded-md border p-3"><MathText text={fields.studentAnswer} studentWork /></div>
            <details className="mt-2"><summary className="cursor-pointer text-sm text-muted-foreground">编辑学生作答（支持 LaTeX 公式）</summary>
            <Label className="sr-only" htmlFor={`q-answer-${question.id}`}>编辑学生作答</Label>
            <Textarea id={`q-answer-${question.id}`} value={fields.studentAnswer ?? ""} onChange={(e) => setField("studentAnswer", e.target.value)} rows={4} className="mt-2" /></details>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor={`q-grading-${question.id}`}>老师批改结果（依据可见批改，待人工确认）</Label>
              <NativeSelect
                id={`q-grading-${question.id}`}
                value={fields.gradingResult}
                onChange={(e) => setField("gradingResult", e.target.value)}
                className="mt-1.5 w-full"
              >
                {GRADING_OPTIONS.map((option) => (
                  <NativeSelectOption key={option.value} value={option.value}>
                    {option.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>
            <div>
              <Label htmlFor={`q-note-${question.id}`}>批改备注（可选）</Label>
              <Input
                id={`q-note-${question.id}`}
                value={fields.gradingNote}
                onChange={(e) => setField("gradingNote", e.target.value)}
                placeholder="如：等号条件不满足"
                className="mt-1.5"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {question.status === "confirmed" && !dirty
              ? "本题已确认并保存到服务端。"
              : dirty
                ? "有未保存修改；确认前请先保存或直接确认。"
                : "尚未确认；未确认内容不会进入后续诊断。"}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="gap-1.5" onClick={doSave} disabled={busy !== "idle"}>
              {busy === "saving" ? <RefreshCw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
              保存修改
            </Button>
            <Button size="sm" className="gap-1.5" onClick={doConfirm} disabled={busy !== "idle"}>
              {busy === "confirming" ? <RefreshCw className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}
              {question.status === "confirmed" && !dirty ? "已确认" : "确认本题"}
            </Button>
          </div>
        </div>

        {cardError && (
          <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            {cardError}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- 人工录入回退（不依赖识别，任务级确认） ---------- */

function ManualFallback({ taskId }: { taskId: string | null }) {
  const [number, setNumber] = useState("");
  const [stem, setStem] = useState("");
  const [studentAnswer, setStudentAnswer] = useState("");
  const [gradingResult, setGradingResult] = useState("");
  const [gradingNote, setGradingNote] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const [version, setVersion] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const handleSave = async () => {
    if (!taskId) {
      setError("请先在上传页选择或新建一个任务");
      setStatus("failed");
      return;
    }
    if (!number.trim() || !stem.trim() || !studentAnswer.trim() || !gradingResult) {
      setError("人工录入需填写题号、题干、学生作答并选择批改结果");
      setStatus("failed");
      return;
    }
    setStatus("saving");
    setError(null);
    try {
      await ensureTask(taskId, "manual");
      const record = await saveConfirmation(taskId, {
        baseVersion: version ?? 0,
        number: number.trim(),
        stem: stem.trim(),
        studentAnswer: studentAnswer.trim(),
        gradingResult: gradingResult as GradingResult,
        gradingNote: gradingNote.trim(),
        source: "manual",
      });
      setVersion(record.version);
      setStatus("saved");
    } catch (e) {
      if (e instanceof ApiError && /conflict/.test(e.message)) {
        try {
          const current = await readConfirmation(taskId);
          if ("version" in current && current.version > 0) setVersion(current.version);
        } catch {
          /* ignore */
        }
        setError("版本冲突：服务端已有更新内容，请刷新后重试");
      } else {
        setError(describeError(e));
      }
      setStatus("failed");
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Eraser className="size-4 text-muted-foreground" />
          人工录入回退（不依赖识别）
          <Badge variant="outline">保存来源：人工录入</Badge>
        </CardTitle>
        <CardDescription>
          未识别或识别不全时，可手动录入一题并确认。此路径走任务级确认接口，与逐题识别确认相互独立。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button variant="outline" size="sm" className="w-fit gap-1.5" onClick={() => setOpen((v) => !v)}>
          <PenLine className="size-3.5" />
          {open ? "收起人工录入" : "展开人工录入"}
        </Button>
        {open && (
          <div className="flex flex-col gap-4">
            <div className="max-w-40">
              <Label htmlFor="m-number">题号</Label>
              <Input id="m-number" value={number} onChange={(e) => setNumber(e.target.value)} placeholder="如：第 3 题" className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="m-stem">题干</Label>
              <Textarea id="m-stem" value={stem} onChange={(e) => setStem(e.target.value)} rows={3} className="mt-1.5" />
            </div>
            <div>
              <Label htmlFor="m-answer">学生作答步骤</Label>
              <Textarea id="m-answer" value={studentAnswer} onChange={(e) => setStudentAnswer(e.target.value)} rows={4} className="mt-1.5" />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="m-grading">老师批改结果</Label>
                <NativeSelect id="m-grading" value={gradingResult} onChange={(e) => setGradingResult(e.target.value)} className="mt-1.5 w-full">
                  <NativeSelectOption value="">请选择批改结果</NativeSelectOption>
                  {GRADING_OPTIONS.map((o) => (
                    <NativeSelectOption key={o.value} value={o.value}>{o.label}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </div>
              <div>
                <Label htmlFor="m-note">批改备注（可选）</Label>
                <Input id="m-note" value={gradingNote} onChange={(e) => setGradingNote(e.target.value)} className="mt-1.5" />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" className="gap-1.5" onClick={handleSave} disabled={status === "saving"}>
                {status === "saving" ? <RefreshCw className="size-3.5 animate-spin" /> : <Save className="size-3.5" />}
                确认并保存（人工录入）
              </Button>
              {status === "saved" && (
                <Badge className="gap-1.5">
                  <CheckCircle2 className="size-3.5" />
                  服务端已保存 · v{version}
                </Badge>
              )}
            </div>
            {error && (
              <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {error}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/* ---------- 识别驱动确认面板 ---------- */

export default function RecognitionPanel() {
  const { activeTaskId, activeTask, paper, sheet } = useUploads();
  const recognition = useRecognition(activeTaskId);
  const assets = useMemo(() => [...paper, ...sheet], [paper, sheet]);
  const hasMaterials = paper.length > 0 || sheet.length > 0;

  const { loading, recognizing, configured, simulated, previousEdits, error } = recognition;
  const localPreview = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const legacyPreview = localPreview && simulated === undefined;
  const simulationBlocked = legacyPreview || (simulated === true && activeTask?.kind !== "demo");
  const job = simulationBlocked ? null : recognition.job;
  const questions = simulationBlocked ? [] : recognition.questions;
  const confirmedCount = questions.filter((q) => q.status === "confirmed").length;
  const hasConfirmedWrong = questions.some((q) => q.status === "confirmed" && q.human?.gradingResult === "wrong" && q.human.stem?.trim());

  const jobStatusText = (): string => {
    if (simulationBlocked) return "当前预览无法真实识别";
    if (!configured) return "尚未配置识别服务";
    if (recognizing || job?.status === "running") return "识别中…";
    if (job?.status === "queued") return "等待识别";
    if (job?.status === "succeeded") return "识别成功";
    if (job?.status === "failed") return questions.length ? "部分材料待补识别" : "识别未完成";
    return hasMaterials ? "尚未识别" : "缺少材料";
  };

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            <ScanLine className="size-4 text-muted-foreground" />
            图片识别
            {simulated && !simulationBlocked && <Badge variant="outline">模拟识别 · 自制样例</Badge>}
            {activeTask?.kind === "demo" && <Badge variant="outline">自制样例</Badge>}
            <Badge variant="outline">{jobStatusText()}</Badge>
            {questions.length > 0 && (
              <Badge variant="outline">
                {confirmedCount}/{questions.length} 题已确认
              </Badge>
            )}
          </CardTitle>
          {!simulationBlocked && <CardDescription>
            点击"开始识别"后由服务端调用视觉模型忠实转录（不解题、不诊断、不覆盖老师批改）。
            上传、刷新、预览都不会自动调用模型。识别结果经服务端结构校验后作为草稿，需逐题人工确认。
          </CardDescription>}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {simulationBlocked && activeTaskId && !loading ? (
            <Alert>
              <TriangleAlert />
              <AlertTitle>当前预览无法识别你上传的试卷</AlertTitle>
              <AlertDescription>
                此预览使用固定样例或缺少真实识别配置。{hasMaterials && "已上传的图片仍保存在当前任务。"}
                可在已配置视觉模型的私有联调站识别，或在下方对照原图人工录入。
              </AlertDescription>
            </Alert>
          ) : !configured && activeTaskId && !loading && (
            <Alert>
              <TriangleAlert />
              <AlertTitle>尚未配置识别服务</AlertTitle>
              <AlertDescription>
                服务端尚未配置可用的视觉模型（MODEL_BASE_URL / MODEL_API_KEY / VISION_MODEL）。
                请联系负责人在平台密钥配置中填写后再识别。当前不会用演示数据冒充真实识别结果；你仍可使用下方"人工录入回退"。
              </AlertDescription>
            </Alert>
          )}

          {!activeTaskId && (
            <Alert>
              <Info />
              <AlertTitle>尚未选择任务</AlertTitle>
              <AlertDescription>请先在上传页上传材料或选择一个任务，再开始识别。</AlertDescription>
            </Alert>
          )}

          {activeTaskId && !hasMaterials && (
            <Alert>
              <Info />
              <AlertTitle>缺少可识别材料</AlertTitle>
              <AlertDescription>请先上传原卷或答题卡（至少一张图片），再开始识别。</AlertDescription>
            </Alert>
          )}

          {error && (
            <Alert variant="destructive">
              <TriangleAlert />
              <AlertTitle>识别未完成</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {job?.materials && job.materials.length > 0 && (
            <ul className="grid gap-2 rounded-lg border border-border p-3 text-sm" aria-label="逐页识别进度">
              {job.materials.map((page) => (
                <li key={page.assetId} className="flex flex-wrap items-center justify-between gap-2">
                  <span>{page.kind === "paper" ? "原卷" : "答题卡"}第 {page.pageIndex + 1} 页</span>
                  <span className={page.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                    {page.status === "done" ? page.empty ? "本页无题" : "已处理"
                      : page.status === "failed" ? "待重试"
                        : page.status === "processing" ? "识别中" : "排队中"}
                    {page.total !== null && page.total > 0 ? " · " + (page.recognized ?? 0) + "/" + page.total + " 题" : ""}
                    {page.status === "failed" && page.errorCode
                      ? " · " + describeError(new ApiError(page.errorCode, 0)) : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => void (job?.status === "failed" || job?.status === "running" ? recognition.retry() : recognition.start())}
              disabled={simulationBlocked || !configured || recognizing || !activeTaskId || !hasMaterials || loading}
            >
              {recognizing ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
              {recognizing ? "识别中…" : job?.status === "failed" ? "继续识别" : job?.status === "succeeded" ? "重新识别" : "开始识别"}
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void recognition.refresh()} disabled={recognizing || loading}>
              <RefreshCw className="size-3.5" />
              刷新状态
            </Button>
            {recognizing && (
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                正在逐页识别，已完成的内容会先保存…
              </span>
            )}
          </div>

          {job?.status === "failed" && job.errorCode && (
            <p className="text-xs text-muted-foreground">
              失败原因码：{job.errorCode} · 已上传材料与既有人工修订均已保留，可重试。
            </p>
          )}
        </CardContent>
      </Card>

      {/* 材料区（可回看原图） */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Images className="size-4 text-muted-foreground" />
            你上传的材料
            <Badge variant="outline">仅本人会话可见</Badge>
          </CardTitle>
          <CardDescription>已私有保存到服务端 · 识别不会自动触发</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {!hasMaterials ? (
            <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
              尚未上传原卷与答题卡。仍可手动录入题目内容，但材料区没有可核对的原图。
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {([["原卷", paper], ["答题卡", sheet]] as const).map(([title, items]) =>
                items.length > 0 ? (
                  <div key={title}>
                    <p className="mb-2 text-sm font-medium">{title}（{items.length} 张）</p>
                    <div className="grid grid-cols-3 gap-2">
                      {items.map((file, index) =>
                        file.url ? (
                          <img key={file.id} src={file.url} alt={`${title}第 ${index + 1} 页`} className="aspect-[3/4] w-full rounded-md border border-border object-cover" />
                        ) : (
                          <div key={file.id} className="flex aspect-[3/4] w-full items-center justify-center rounded-md border border-border text-xs text-muted-foreground">
                            预览加载中…
                          </div>
                        ),
                      )}
                    </div>
                  </div>
                ) : null,
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* 逐题识别确认 */}
      {questions.length > 0 ? (
        <div className="flex flex-col gap-4">
          <h2 className="text-lg font-semibold tracking-tight">逐题核对与确认</h2>
          {questions.map((q) => (
            <QuestionCard
              key={q.id}
              question={q}
              onSaveRevision={recognition.saveRevision}
              onConfirm={recognition.confirm}
            />
          ))}
        </div>
      ) : (
        !loading && configured && job?.status === "succeeded" && (
          <Alert>
            <Info />
            <AlertTitle>未识别到题目</AlertTitle>
            <AlertDescription>
              模型未转录到可识别的题目（可能图片模糊、空白或无有效内容）。请核对原图，或使用下方人工录入回退。
            </AlertDescription>
          </Alert>
        )
      )}

      {previousEdits.length > 0 && (
        <details className="rounded-lg border border-border p-4">
          <summary className="cursor-pointer font-medium">此前批次的人工修改（{previousEdits.length} 条）</summary>
          <div className="mt-4 grid gap-3">
            {previousEdits.map(({ id, fields, updatedAt }) => (
              <article key={id} className="grid gap-2 rounded-md border border-border p-3 text-sm">
                <p className="font-medium">{fields.number ? `第 ${fields.number} 题` : "题号未填写"}</p>
                <p className="text-xs text-muted-foreground">{formatBeijing(updatedAt)}</p>
                <p className="font-medium">题干</p>
                <MathText text={fields.stem} empty="未填写" />
                <p className="font-medium">学生作答</p>
                <MathText text={fields.studentAnswer} empty="未填写" studentWork />
                <p>老师批改结果：{GRADING_OPTIONS.find((option) => option.value === fields.gradingResult)?.label}</p>
                {fields.gradingNote && <p>批改备注：{fields.gradingNote}</p>}
              </article>
            ))}
          </div>
        </details>
      )}

      <ManualFallback taskId={activeTaskId} />

      <Card>
        <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {hasConfirmedWrong
              ? "已确认的错题可以进入错因诊断。"
              : "请核对原卷、作答和老师批改，并确认至少一道老师判错的题目。"}
          </p>
          {activeTaskId && hasConfirmedWrong ? (
            <Button size="sm" asChild>
              <Link to={"/learning?task=" + activeTaskId}>下一步：错因诊断</Link>
            </Button>
          ) : (
            <Button size="sm" disabled>下一步：错因诊断</Button>
          )}
        </CardContent>
      </Card>

    </div>
  );
}
