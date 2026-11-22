import { useRef, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronUp,
  FileImage,
  FolderOpen,
  ImagePlus,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { describeError, renameTask } from "@/lib/api";
import { useRouter } from "@/lib/router";
import { useTaskDiagnoses } from "@/lib/use-task-diagnoses";
import {
  ACCEPTED_EXTENSIONS,
  MAX_ASSETS_PER_TASK,
  MAX_FILE_SIZE,
  formatSize,
  useUploads,
  type FileItem,
  type Rejection,
  type UploadKind,
} from "@/lib/store";

const KIND_LABEL: Record<UploadKind, string> = {
  paper: "原卷",
  sheet: "答题卡",
};

function rejectionText(rejection: Rejection): string {
  switch (rejection.reason) {
    case "type":
      return `${rejection.name}：仅支持 JPEG / PNG / WebP 图片`;
    case "size":
      return `${rejection.name}：超过单张 ${formatSize(MAX_FILE_SIZE)}（10,000,000 字节）上限`;
    case "empty":
      return `${rejection.name}：文件为空`;
    case "limit":
      return `${rejection.name}：每个任务最多 ${MAX_ASSETS_PER_TASK} 张（原卷与答题卡合计）`;
    case "server":
      return `${rejection.name}：${rejection.detail ?? "上传失败，请重试"}`;
    default:
      return `${rejection.name}：未通过检查`;
  }
}

function UploadZone({
  kind,
  title,
  description,
}: {
  kind: UploadKind;
  title: string;
  description: string;
}) {
  const { paper, sheet, addFiles, removeFile, moveFile, uploading, sessionStatus } = useUploads();
  const inputRef = useRef<HTMLInputElement>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const items: FileItem[] = kind === "paper" ? paper : sheet;
  const disabled = sessionStatus !== "ready" || uploading || busy;

  const handleSelect = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setErrors([]);
    try {
      const rejections = await addFiles(kind, list);
      setErrors(rejections.map(rejectionText));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleRemove = async (id: string) => {
    setBusy(true);
    try {
      await removeFile(kind, id);
    } finally {
      setBusy(false);
    }
  };

  const handleMove = async (id: string, direction: -1 | 1) => {
    setBusy(true);
    try {
      await moveFile(kind, id, direction);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            {title}
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              已保存 {items.length} 张
            </span>
          </CardTitle>
          <Badge variant="outline">{KIND_LABEL[kind]}</Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          multiple
          className="sr-only"
          data-testid={`file-input-${kind}`}
          onChange={(e) => void handleSelect(e.target.files)}
        />
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="flex flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-8 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        >
          {busy || uploading ? <Loader2 className="size-6 animate-spin" /> : <ImagePlus className="size-6" />}
          <span className="text-sm">
            {uploading ? "正在上传并保存到服务端…" : "点击选择图片（可多选、分页上传）"}
          </span>
          <span className="text-xs">JPEG / PNG / WebP · 单张不超过 10,000,000 字节</span>
        </button>

        {errors.length > 0 && (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>以下文件未上传成功</AlertTitle>
            <AlertDescription>
              <ul className="list-disc space-y-1 pl-4 text-sm">
                {errors.map((msg) => (
                  <li key={msg}>{msg}</li>
                ))}
              </ul>
              <p className="mt-2 text-xs">已保存的材料不受影响；修正后可重新选择上传。</p>
            </AlertDescription>
          </Alert>
        )}

        {items.length > 0 && (
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {items.map((file, index) => (
              <li
                key={file.id}
                className="group relative overflow-hidden rounded-lg border border-border bg-muted"
              >
                {file.url ? (
                  <img
                    src={file.url}
                    alt={`${KIND_LABEL[kind]}第 ${index + 1} 页预览`}
                    className="aspect-[3/4] w-full object-cover"
                  />
                ) : (
                  <div className="flex aspect-[3/4] w-full items-center justify-center text-xs text-muted-foreground">
                    预览加载中…
                  </div>
                )}
                <div className="absolute left-1 top-1 flex flex-col gap-1">
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    disabled={disabled || index === 0}
                    aria-label={`上移 ${file.name}`}
                    onClick={() => void handleMove(file.id, -1)}
                  >
                    <ChevronUp className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    disabled={disabled || index === items.length - 1}
                    aria-label={`下移 ${file.name}`}
                    onClick={() => void handleMove(file.id, 1)}
                  >
                    <ChevronDown className="size-4" />
                  </Button>
                </div>
                <div className="absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-background/85 px-2 py-1.5 backdrop-blur-sm">
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium" title={file.name}>
                      第 {index + 1} 页 · {file.name}
                    </p>
                    <p className="text-[11px] text-muted-foreground">{formatSize(file.size)}</p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    disabled={disabled}
                    aria-label={`删除 ${file.name}`}
                    onClick={() => void handleRemove(file.id)}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function TaskBar({library}: {library:boolean}) {
  const {
    tasks,
    activeTaskId,
    activeTask,
    newTask,
    selectTask,
    removeTask,
    refresh,
    sessionStatus,
    uploading,
  } = useUploads();
  const [running, setRunning] = useState(false);
  const diagnoses = useTaskDiagnoses(library);
  const busy = running || uploading;
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState("");

  const run = async (fn: () => Promise<void>) => {
    setRunning(true);
    try {
      await fn();
    } finally {
      setRunning(false);
    }
  };

  const startRename = (id: string, current: string | null) => {
    setEditingId(id);
    setNameDraft(current ?? "");
  };

  const cancelRename = () => {
    setEditingId(null);
    setNameDraft("");
  };

  const saveRename = async (id: string) => {
    const value = nameDraft.trim().slice(0, 40);
    await run(async () => {
      await renameTask(id, value);
      await refresh();
    });
    setEditingId(null);
    setNameDraft("");
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <FolderOpen className="size-4 text-muted-foreground" />
            我的学习任务
          </CardTitle>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="gap-1.5" disabled={busy || sessionStatus !== "ready"} onClick={() => void run(refresh)}>
              <RefreshCw className="size-3.5" />
              刷新
            </Button>
            <Button size="sm" className="gap-1.5" disabled={busy || sessionStatus !== "ready"} onClick={() => void run(async () => {
              const id = await newTask();
              if (id) startRename(id, "");
            })}>
              <Plus className="size-3.5" />
              新建任务
            </Button>
          </div>
        </div>
        <CardDescription>
          可以从这个浏览器继续之前的任务。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {tasks.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-3 text-sm text-muted-foreground">
            {library ? "还没有任务，先点击「新建任务」保存图片。" : "还没有任务。点击“新建任务”，或直接选择图片上传（会自动创建一个任务）。"}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {tasks.map((task) => {
              const active = task.id === activeTaskId;
              const hasPaper = (task.paperCount ?? 0) > 0;
              const hasSheet = (task.sheetCount ?? 0) > 0;
              const materialStatus = hasPaper && hasSheet ? "材料齐全" : hasPaper || hasSheet ? "待补材料" : "待上传";
              const diagnosis = diagnoses[task.id] ?? "查询中";
              return (
                <li
                  key={task.id}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2.5 ${
                    active ? "border-primary/50 bg-accent" : "border-border"
                  }`}
                >
                  {editingId === task.id ? (
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <input
                        autoFocus
                        value={nameDraft}
                        maxLength={40}
                        disabled={busy}
                        aria-label="任务名称"
                        placeholder="任务名称（可留空）"
                        className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm"
                        onChange={(e) => setNameDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void saveRename(task.id);
                          } else if (e.key === "Escape") {
                            e.preventDefault();
                            cancelRename();
                          }
                        }}
                      />
                      <Button type="button" size="icon-sm" variant="ghost" disabled={busy} aria-label="保存任务名称" onClick={() => void saveRename(task.id)}>
                        <Check className="size-4" />
                      </Button>
                      <Button type="button" size="icon-sm" variant="ghost" disabled={busy} aria-label="取消重命名" onClick={cancelRename}>
                        <X className="size-4" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="min-w-0 flex-1 text-left"
                      disabled={busy}
                      onClick={() => void run(() => selectTask(task.id))}
                    >
                      <p className="truncate text-sm font-medium">
                        {task.studentAlias || "未命名任务"}
                        {active && <span className="ml-2 text-xs font-normal text-muted-foreground">当前</span>}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        原卷 {task.paperCount ?? 0} 张 · 答题卡 {task.sheetCount ?? 0} 张 ·{" "}
                        {library ? materialStatus : task.status === "uploaded" ? "已上传材料" : "草稿"}
                      </p>
                    </button>
                  )}
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    disabled={busy || editingId === task.id}
                    aria-label="重命名任务"
                    onClick={() => startRename(task.id, task.studentAlias)}
                  >
                    <Pencil className="size-4" />
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-destructive hover:text-destructive"
                    disabled={busy}
                    aria-label="删除该任务及其全部材料"
                    onClick={() => {
                      if (window.confirm("删除此任务及全部图片和确认记录？此操作无法恢复。")) {
                        void run(() => removeTask(task.id));
                      }
                    }}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                  {library && <div className="basis-full text-xs">
                    <Badge variant="outline" className={diagnosis === "已诊断" ? "border-primary/30 bg-primary/10 text-primary" : "text-muted-foreground"}>
                      {diagnosis === "已诊断" && <Check className="size-3" aria-hidden="true" />}{diagnosis}
                    </Badge>
                  </div>}
                </li>
              );
            })}
          </ul>
        )}
        {activeTask && (
          <p className="text-xs text-muted-foreground">
            当前任务 {activeTask.id.slice(0, 8)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function BatchUpload() {
  const { addBatch, activeTask, loadingAssets, sessionStatus, totalCount, uploading } = useUploads();
  const picker = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<{ id: string; file: File; kind: UploadKind | "" }[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [sending, setSending] = useState(false);
  const disabled = !activeTask || sessionStatus !== "ready" || loadingAssets || uploading || sending;
  const remaining = MAX_ASSETS_PER_TASK - totalCount;

  async function submit() {
    if (disabled || files.length === 0 || files.some(({ kind }) => !kind)) return;
    setSending(true);
    setMessages([]);
    try {
      const rejected = await addBatch(files.flatMap(({kind, file}) => kind ? [{kind, file}] : []));
      setFiles([]);
      setMessages([`已保存 ${files.length - rejected.length} 张图片。`, ...rejected.map(rejectionText)]);
    } catch (error) {
      setFiles([]);
      setMessages([describeError(error)]);
    } finally {
      setSending(false);
    }
  }

  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><ImagePlus className="size-5 text-primary" />批量添加原卷和答题卡</CardTitle>
      <CardDescription>{activeTask ? `当前任务：${activeTask.studentAlias || "未命名任务"} · 还可添加 ${remaining} 张` : "先新建或选择一个学习任务。"}</CardDescription>
    </CardHeader>
    <CardContent className="grid gap-3">
      <input ref={picker} type="file" aria-label="批量选择图片" className="hidden" accept={ACCEPTED_EXTENSIONS} multiple
        disabled={disabled || remaining === 0} onChange={(event) => {
          const picked = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (!picked.length) return;
          setMessages(picked.length > remaining ? [`本任务只剩 ${remaining} 个位置，请选择要上传的图片。`] : []);
          setFiles(picked.map((file) => ({id:crypto.randomUUID(),file,kind:""})));
        }} />
      <Button variant="outline" className="w-fit" type="button" disabled={disabled || remaining === 0} onClick={() => picker.current?.click()}>
        <ImagePlus className="size-4" />选择多张图片
      </Button>
      {files.length > 0 && <>
        <ul className="grid max-h-72 gap-2 overflow-y-auto" aria-label="本批图片">
          {files.map(({id,file,kind}) => <li key={id} className="flex min-w-0 items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
            <select className="rounded-md border bg-card px-2 py-1" aria-label={`${file.name} 的材料类型`} value={kind} disabled={disabled}
              onChange={(event) => {
                const chosen = event.currentTarget.value as UploadKind | "";
                setFiles((old) => old.map((entry) => entry.id === id ? {...entry,kind:chosen} : entry));
              }}>
              <option value="">选择类型</option><option value="paper">原卷</option><option value="sheet">答题卡</option>
            </select>
            <Button variant="ghost" size="icon-sm" type="button" aria-label={`移除 ${file.name}`} disabled={disabled}
              onClick={() => setFiles((old) => old.filter((entry) => entry.id !== id))}><X className="size-4" /></Button>
          </li>)}
        </ul>
        <Button className="w-fit" type="button" onClick={() => void submit()}
          disabled={disabled || files.length > remaining || files.some(({kind}) => !kind)}>上传 {files.length} 张</Button>
      </>}
      {messages.length > 0 && <ul className="text-sm text-muted-foreground" role="status">{messages.map((message,index) => <li key={index}>{message}</li>)}</ul>}
    </CardContent>
  </Card>;
}

export default function UploadPage({ library = false }: { library?: boolean }) {
  const { activeTaskId, paper, sheet, totalCount, sessionStatus, sessionError, error, uploading, refresh, clearError } =
    useUploads();
  const { navigate } = useRouter();
  const ready = paper.length >= 1 && sheet.length >= 1;
  const hasImages = paper.length >= 1 || sheet.length >= 1;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 sm:py-10">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">{library ? "学习任务" : "上传试卷与答题卡"}</h1>
        <p className="mt-2 text-base text-muted-foreground">
          {library ? "按任务保存原卷和老师已批改的答题卡。" : "分别上传清晰的原卷和老师已批改的答题卡。"}
        </p>
      </div>

      {sessionStatus === "error" ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>无法建立会话</AlertTitle>
          <AlertDescription>
            {sessionError ?? "服务端不可用"}。上传与恢复暂不可用。
            <Button size="sm" variant="outline" className="ml-2 gap-1.5" onClick={() => void refresh()}>
              <RefreshCw className="size-3.5" />
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <Lock />
          <AlertTitle>仅当前会话可查看上传的图片</AlertTitle>
          {!library && <AlertDescription>
            在下一页点击「开始识别」时才会调用模型。
          </AlertDescription>}
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>操作未完成</AlertTitle>
          <AlertDescription>
            {error}
            <Button size="sm" variant="outline" className="ml-2" onClick={clearError}>
              知道了
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[19rem_minmax(0,1fr)]">
        <aside aria-label="学习任务"><TaskBar library={library} /></aside>
        {library ? <BatchUpload key={activeTaskId} /> : <div className="grid min-w-0 gap-4">
          <div className="grid items-start gap-4 xl:grid-cols-2">
            <UploadZone
              kind="paper"
              title="原卷"
              description="上传试卷题目。上传多页时可以调整顺序。"
            />
            <UploadZone
              kind="sheet"
              title="答题卡"
              description="上传含学生作答和老师批改标记的图片。"
            />
          </div>
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-2 text-sm text-muted-foreground">
              <FileImage className="mt-0.5 size-4 shrink-0" />
              <p>
                已保存 {totalCount} / {MAX_ASSETS_PER_TASK} 张。
                {uploading
                  ? " 正在上传…"
                  : ready
                    ? " 原卷和答题卡已齐全。"
                    : hasImages
                      ? " 建议补齐原卷与答题卡。"
                      : " 至少上传 1 张图片才能继续。"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => navigate("/demo")}>改用演示样例</Button>
              <Button size="sm" disabled={!hasImages || uploading} onClick={() => navigate("/confirm?mode=custom")}>
                下一步：识别与确认
              </Button>
            </div>
          </div>
        </div>}
      </div>
    </div>
  );
}
