import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Eraser,
  FlaskConical,
  Info,
  PenLine,
  RefreshCw,
  RotateCcw,
  Save,
  TriangleAlert,
  Upload,
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
  ensureTask,
  readConfirmation,
  saveConfirmation,
  type ConfirmationRecord,
  type GradingResult,
  type TaskKind,
} from "@/lib/api";
import { DEMO_QUESTION, GRADING_OPTIONS } from "@/lib/demo";
import { Link, useRouter } from "@/lib/router";
import { useUploads } from "@/lib/store";
import RecognitionPanel from "@/pages/RecognitionPanel";

type Mode = "demo" | "custom";

interface FieldSnapshot {
  number: string;
  stem: string;
  studentAnswer: string;
  gradingResult: string;
  gradingNote: string;
}

interface ModeState {
  number: string;
  stem: string;
  studentAnswer: string;
  gradingResult: string;
  gradingNote: string;
  /** 最近一次“确认”时的内容快照；null 表示尚未确认。 */
  snapshot: FieldSnapshot | null;
  /** 本地确认时间（北京时间），仅表示用户已确认，不表示服务端已保存。 */
  confirmedAt: string | null;
  taskId: string | null;
  saveStatus: "idle" | "saving" | "saved" | "failed";
  savedVersion: number | null;
  savedAt: string | null;
  saveError: string | null;
}

const EMPTY_FIELDS: FieldSnapshot = {
  number: "",
  stem: "",
  studentAnswer: "",
  gradingResult: "",
  gradingNote: "",
};

function initialState(mode: Mode): ModeState {
  const fields: FieldSnapshot =
    mode === "demo"
      ? {
          number: DEMO_QUESTION.number,
          stem: DEMO_QUESTION.stem,
          studentAnswer: DEMO_QUESTION.studentAnswer,
          gradingResult: DEMO_QUESTION.gradingResult,
          gradingNote: DEMO_QUESTION.gradingNote,
        }
      : { ...EMPTY_FIELDS };
  return {
    ...fields,
    snapshot: null,
    confirmedAt: null,
    taskId: null,
    saveStatus: "idle",
    savedVersion: null,
    savedAt: null,
    saveError: null,
  };
}

function formatBeijing(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) + "（北京时间）";
}

function currentFields(state: ModeState): FieldSnapshot {
  return {
    number: state.number,
    stem: state.stem,
    studentAnswer: state.studentAnswer,
    gradingResult: state.gradingResult,
    gradingNote: state.gradingNote,
  };
}

function fieldsEqual(a: FieldSnapshot, b: FieldSnapshot): boolean {
  return (
    a.number === b.number &&
    a.stem === b.stem &&
    a.studentAnswer === b.studentAnswer &&
    a.gradingResult === b.gradingResult &&
    a.gradingNote === b.gradingNote
  );
}

/* ---------- 材料区 ---------- */

function DemoMaterials() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FlaskConical className="size-4 text-muted-foreground" />
          材料区 · 演示材料（文字版）
          <Badge variant="outline">固定演示题</Badge>
        </CardTitle>
        <CardDescription>本模式只展示与该演示题对应的材料，不混入你上传的图片。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        <div className="rounded-lg border border-border p-3">
          <p className="mb-1 text-xs font-medium text-muted-foreground">演示原卷</p>
          <p>
            {DEMO_QUESTION.number}：{DEMO_QUESTION.stem}
          </p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="mb-1 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <PenLine className="size-3.5" />
            演示答题卡（学生作答）
          </p>
          <p>{DEMO_QUESTION.studentAnswer}</p>
        </div>
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="mb-1 text-xs font-medium text-destructive">老师批改：判错</p>
          <p>{DEMO_QUESTION.gradingNote}</p>
        </div>
      </CardContent>
    </Card>
  );
}

/* ---------- 确认页 ---------- */

export default function ConfirmPage() {
  const router = useRouter();
  const { paper, sheet } = useUploads();
  const queryMode = router.query.get("mode");
  const [mode, setMode] = useState<Mode>(() =>
    queryMode === "custom"
      ? "custom"
      : queryMode === "demo"
        ? "demo"
        : paper.length > 0 || sheet.length > 0
          ? "custom"
          : "demo",
  );
  const [demo, setDemo] = useState<ModeState>(() => initialState("demo"));
  const [custom, setCustom] = useState<ModeState>(() => initialState("custom"));

  // 从带 mode 参数的入口进入时同步模式；两种模式的内容各自保留，互不混入。
  useEffect(() => {
    const m = router.query.get("mode");
    if (m === "demo" || m === "custom") setMode(m);
  }, [router.query]);

  const state = mode === "demo" ? demo : custom;
  const setState = mode === "demo" ? setDemo : setCustom;
  const fields = currentFields(state);
  const dirty = state.snapshot !== null && !fieldsEqual(fields, state.snapshot);
  const confirmedValid = state.snapshot !== null && !dirty;

  const setField = (key: keyof FieldSnapshot, value: string) => {
    setState((prev) => ({ ...prev, [key]: value }));
  };

  const validationError = (): string | null => {
    if (!fields.number.trim()) return "请填写题号";
    if (!fields.stem.trim()) return "请填写题干";
    if (!fields.studentAnswer.trim()) return "请填写学生作答步骤";
    if (!fields.gradingResult) return "请选择老师批改结果";
    return null;
  };

  const persistSnapshot = async (
    s: ModeState,
    setS: (updater: (prev: ModeState) => ModeState) => void,
    snapshot: FieldSnapshot,
  ) => {
    const kind: TaskKind = mode === "demo" ? "demo" : "manual";
    const source = mode === "demo" ? "demo" : "manual";
    const taskId = s.taskId ?? crypto.randomUUID();
    if (s.taskId === null) {
      setS((prev) => ({ ...prev, taskId, saveStatus: "saving", saveError: null }));
      try {
        await ensureTask(taskId, kind);
      } catch (error) {
        setS((prev) => ({
          ...prev,
          saveStatus: "failed",
          saveError: error instanceof ApiError ? error.message : "创建任务失败",
        }));
        return;
      }
    }
    setS((prev) => ({ ...prev, saveStatus: "saving", saveError: null }));
    try {
      const record = await saveConfirmation(taskId, {
        baseVersion: s.savedVersion ?? 0,
        number: snapshot.number.trim(),
        stem: snapshot.stem.trim(),
        studentAnswer: snapshot.studentAnswer.trim(),
        gradingResult: snapshot.gradingResult as GradingResult,
        gradingNote: snapshot.gradingNote.trim(),
        source,
      });
      setS((prev) => ({
        ...prev,
        saveStatus: "saved",
        savedVersion: record.version,
        savedAt: record.confirmedAt,
        saveError: null,
      }));
    } catch (error) {
      // 版本冲突：可能是上次请求实际已成功但响应丢失，向服务端读取核对。
      if (error instanceof ApiError && /conflict/.test(error.message)) {
        try {
          const current = await readConfirmation(taskId);
          if ("version" in current && current.version > 0) {
            const record = current as ConfirmationRecord;
            if (
              record.number === snapshot.number.trim() &&
              record.stem === snapshot.stem.trim() &&
              record.studentAnswer === snapshot.studentAnswer.trim() &&
              record.gradingResult === snapshot.gradingResult &&
              record.gradingNote === snapshot.gradingNote.trim()
            ) {
              setS((prev) => ({
                ...prev,
                saveStatus: "saved",
                savedVersion: record.version,
                savedAt: record.confirmedAt,
                saveError: null,
              }));
              return;
            }
          }
          setS((prev) => ({
            ...prev,
            saveStatus: "failed",
            saveError: "版本冲突：服务端已有更新的确认内容，请重新确认后再保存",
          }));
        } catch {
          setS((prev) => ({
            ...prev,
            saveStatus: "failed",
            saveError: "版本冲突且无法读取服务端内容",
          }));
        }
        return;
      }
      setS((prev) => ({
        ...prev,
        saveStatus: "failed",
        saveError: error instanceof ApiError ? error.message : "保存失败",
      }));
    }
  };

  const handleConfirm = () => {
    const error = validationError();
    if (error) {
      setState((prev) => ({ ...prev, saveError: error, saveStatus: "failed" }));
      return;
    }
    const snapshot = currentFields(state);
    const confirmedAt =
      new Date().toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" }) +
      "（北京时间）";
    setState((prev) => ({ ...prev, snapshot, confirmedAt, saveError: null }));
    // 快照已写入状态；异步保存使用同一快照，避免竞态。
    void persistSnapshot(state, setState, snapshot);
  };

  const handleRetrySave = () => {
    if (!state.snapshot) return;
    void persistSnapshot(state, setState, state.snapshot);
  };

  const handleReset = () => {
    if (mode === "demo") {
      setState((prev) => ({
        ...initialState("demo"),
        taskId: prev.taskId,
      }));
    } else {
      setState((prev) => ({
        ...initialState("custom"),
        taskId: prev.taskId,
      }));
    }
  };

  const sourceLabel = mode === "demo" ? "演示数据" : "人工录入";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-10 sm:px-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">核对识别结果</h1>
        <p className="mt-2 text-base text-muted-foreground">对照原图检查题干、作答和老师批改。确认错题后即可开始诊断。</p>
      </div>

      <div
        role="tablist"
        aria-label="确认模式"
        className="inline-flex w-fit max-w-full flex-wrap rounded-lg border border-border bg-muted p-1"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "demo"}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
            mode === "demo"
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setMode("demo")}
        >
          <FlaskConical className="size-3.5" />
          固定演示题
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "custom"}
          className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors ${
            mode === "custom"
              ? "bg-background font-medium text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => setMode("custom")}
        >
          <Upload className="size-3.5" />
          自选图片 · 识别确认
        </button>
      </div>

      {mode === "demo" ? (
        <Alert>
          <Info />
          <AlertTitle>固定演示题</AlertTitle>
          <AlertDescription>
            题目、作答与批改均为自制演示数据，用于体验人工核对。
          </AlertDescription>
        </Alert>
      ) : null}

      {mode === "demo" ? (
      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              固定演示题确认
              <Badge variant="outline">保存来源：{sourceLabel}</Badge>
            </CardTitle>
            <CardDescription>
              编辑内容后需重新确认；确认内容修改会使旧确认失效。保存到服务端后才会显示“服务端已保存”。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="max-w-40">
              <Label htmlFor="q-number">题号</Label>
              <Input
                id="q-number"
                value={fields.number}
                onChange={(e) => setField("number", e.target.value)}
                className="mt-1.5"
              />
            </div>

            <div>
              <Label htmlFor="q-stem">题干</Label>
              <Textarea
                id="q-stem"
                value={fields.stem}
                onChange={(e) => setField("stem", e.target.value)}
                rows={3}
                className="mt-1.5"
              />
            </div>

            <div>
              <Label htmlFor="q-answer">学生作答步骤</Label>
              <Textarea
                id="q-answer"
                value={fields.studentAnswer}
                onChange={(e) => setField("studentAnswer", e.target.value)}
                rows={4}
                className="mt-1.5"
              />
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="q-grading">老师批改结果</Label>
                <NativeSelect
                  id="q-grading"
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
                <Label htmlFor="q-note">批改备注（可选）</Label>
                <Input
                  id="q-note"
                  value={fields.gradingNote}
                  onChange={(e) => setField("gradingNote", e.target.value)}
                  placeholder="如：等号条件不满足、步骤缺失等"
                  className="mt-1.5"
                />
              </div>
            </div>

            <Separator />

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-2">
                {confirmedValid && state.saveStatus === "saved" ? (
                  <Badge className="gap-1.5">
                    <CheckCircle2 className="size-3.5" />
                    已确认 · 服务端已保存 · 版本 v{state.savedVersion}
                    {state.savedAt ? ` · ${formatBeijing(state.savedAt)}` : ""}
                  </Badge>
                ) : confirmedValid && state.saveStatus === "failed" ? (
                  <Badge variant="outline" className="gap-1.5 border-destructive/50 text-destructive">
                    <TriangleAlert className="size-3.5" />
                    已确认 · 仅本地状态（未保存到服务端）
                  </Badge>
                ) : dirty ? (
                  <Badge variant="destructive">内容已修改，需重新确认</Badge>
                ) : state.saveStatus === "saving" ? (
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <RefreshCw className="size-3.5 animate-spin" />
                    正在保存到服务端…
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">尚未确认</span>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {confirmedValid && state.saveStatus === "failed" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={handleRetrySave}
                  >
                    <RefreshCw className="size-3.5" />
                    重试保存
                  </Button>
                )}
                <Button variant="outline" size="sm" className="gap-1.5" onClick={handleReset}>
                  {mode === "demo" ? (
                    <RotateCcw className="size-3.5" />
                  ) : (
                    <Eraser className="size-3.5" />
                  )}
                  {mode === "demo" ? "重置为演示原文" : "清空表单"}
                </Button>
                <Button
                  size="sm"
                  className="gap-1.5"
                  onClick={handleConfirm}
                  disabled={state.saveStatus === "saving"}
                >
                  {state.saveStatus === "saving" ? (
                    <RefreshCw className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  {state.saveStatus === "saving" ? "保存中…" : "确认并保存本题"}
                </Button>
              </div>
            </div>

            {state.saveError && (
              <p className="flex items-start gap-1.5 text-sm text-destructive" role="alert">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" />
                {state.saveError}
              </p>
            )}

            <p className="text-xs text-muted-foreground">
              保存状态说明：确认后本页会先做本地确认，再尝试写入服务端数据库。只有服务端返回成功，
              才显示“服务端已保存”；失败时显示“仅本地状态”，内容不会丢失，可重试保存。
            </p>
          </CardContent>
        </Card>

        <DemoMaterials />
      </div>
      ) : (
        <RecognitionPanel />
      )}



      <p className="text-xs text-muted-foreground">
        <Link to="/demo" className="underline underline-offset-2">返回演示样例</Link>
        {" · "}
        <Link to="/upload" className="underline underline-offset-2">重新上传材料</Link>
        {" · "}
        <Link to="/" className="underline underline-offset-2">返回首页</Link>
      </p>
    </div>
  );
}
