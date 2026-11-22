import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ApiError,
  createTask as apiCreateTask,
  deleteAsset as apiDeleteAsset,
  deleteTask as apiDeleteTask,
  describeError,
  ensureSession,
  fetchAssetObjectUrl,
  listAssets,
  listTasks,
  reorderAssets,
  uploadAsset,
  type AssetKind,
  type AssetRecord,
  type TaskRecord,
} from "@/lib/api";

export interface FileItem {
  id: string;
  name: string;
  size: number;
  type: string;
  url: string;
}

export type UploadKind = AssetKind;
export interface PendingImage { kind: UploadKind; file: File }

export type RejectReason = "type" | "size" | "limit" | "empty" | "server";

export interface Rejection {
  name: string;
  reason: RejectReason;
  detail?: string;
}

export const ACCEPTED_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const ACCEPTED_EXTENSIONS = ".jpg,.jpeg,.png,.webp";
// 与平台实测一致：单文件 ≤ 10,000,000 字节（相对网关请求体上限留余量），每任务合计 ≤ 10 张。
export const MAX_FILE_SIZE = 10_000_000;
export const MAX_ASSETS_PER_TASK = 10;

export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

export type SessionStatus = "loading" | "ready" | "error";

interface UploadState {
  paper: FileItem[];
  sheet: FileItem[];
  totalCount: number;
  sessionStatus: SessionStatus;
  sessionError: string | null;
  tasks: TaskRecord[];
  activeTaskId: string | null;
  activeTask: TaskRecord | null;
  loadingAssets: boolean;
  uploading: boolean;
  error: string | null;
  addFiles: (kind: UploadKind, files: FileList | File[]) => Promise<Rejection[]>;
  addBatch: (items: PendingImage[]) => Promise<Rejection[]>;
  removeFile: (kind: UploadKind, id: string) => Promise<void>;
  moveFile: (kind: UploadKind, id: string, direction: -1 | 1) => Promise<void>;
  selectTask: (id: string) => Promise<void>;
  newTask: () => Promise<string | null>;
  removeTask: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
  clearError: () => void;
}

const UploadContext = createContext<UploadState | null>(null);

function toItem(asset: AssetRecord, url: string): FileItem {
  return {
    id: asset.id,
    name: asset.originalName || `${asset.kind === "paper" ? "原卷" : "答题卡"} 第 ${asset.pageIndex + 1} 页`,
    size: asset.sizeBytes,
    type: asset.mime,
    url,
  };
}

export function UploadProvider({ children }: { children: ReactNode }) {
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>("loading");
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 记录已创建的 objectURL，便于卸载/替换时释放，避免内存泄漏。
  const previewsRef = useRef<Record<string, string>>({});
  const activeRef = useRef<string | null>(null);
  activeRef.current = activeTaskId;

  const revokeAll = useCallback(() => {
    for (const url of Object.values(previewsRef.current)) URL.revokeObjectURL(url);
    previewsRef.current = {};
  }, []);

  // 为给定素材列表同步预览：新增的取回私有内容，移除的释放 URL。
  const syncPreviews = useCallback(async (list: AssetRecord[]) => {
    const keep = new Set(list.map((a) => a.id));
    const next: Record<string, string> = {};
    for (const [id, url] of Object.entries(previewsRef.current)) {
      if (keep.has(id)) next[id] = url;
      else URL.revokeObjectURL(url);
    }
    const missing = list.filter((a) => !next[a.id]);
    const fetched = await Promise.all(
      missing.map(async (a) => {
        try {
          return [a.id, await fetchAssetObjectUrl(a)] as const;
        } catch {
          return [a.id, ""] as const; // 取回失败时留空，UI 显示占位而非崩溃
        }
      }),
    );
    for (const [id, url] of fetched) if (url) next[id] = url;
    previewsRef.current = next;
    setPreviews(next);
  }, []);

  const loadAssets = useCallback(
    async (taskId: string) => {
      setLoadingAssets(true);
      try {
        const { items } = await listAssets(taskId);
        if (activeRef.current !== taskId) return; // 期间切换了任务，丢弃过期结果
        const sorted = [...items].sort((a, b) =>
          a.kind === b.kind ? a.pageIndex - b.pageIndex : a.kind.localeCompare(b.kind),
        );
        setAssets(sorted);
        await syncPreviews(sorted);
      } catch (e) {
        if (activeRef.current === taskId) setError(describeError(e));
      } finally {
        if (activeRef.current === taskId) setLoadingAssets(false);
      }
    },
    [syncPreviews],
  );

  const refreshTasks = useCallback(async () => {
    const { items } = await listTasks();
    setTasks(items);
    return items;
  }, []);

  // 初始化：建立会话 → 列出本人任务 → 恢复最近一个任务的材料（刷新/重开浏览器恢复）。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureSession();
        if (cancelled) return;
        setSessionStatus("ready");
        const items = await refreshTasks();
        if (cancelled) return;
        if (items.length > 0) {
          setActiveTaskId(items[0].id);
          activeRef.current = items[0].id;
          await loadAssets(items[0].id);
        }
      } catch (e) {
        if (!cancelled) {
          setSessionStatus("error");
          setSessionError(describeError(e));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 卸载时释放所有预览 URL。
  useEffect(() => revokeAll, [revokeAll]);

  const selectTask = useCallback(
    async (id: string) => {
      setError(null);
      setActiveTaskId(id);
      activeRef.current = id;
      setAssets([]);
      await loadAssets(id);
    },
    [loadAssets],
  );

  const newTask = useCallback(async () => {
    setError(null);
    try {
      const task = await apiCreateTask();
      setTasks((prev) => [task, ...prev]);
      setActiveTaskId(task.id);
      activeRef.current = task.id;
      setAssets([]);
      await syncPreviews([]);
      return task.id;
    } catch (e) {
      setError(describeError(e));
      return null;
    }
  }, [syncPreviews]);

  const removeTask = useCallback(
    async (id: string) => {
      setError(null);
      try {
        await apiDeleteTask(id);
        const items = await refreshTasks();
        if (activeRef.current === id) {
          const next = items[0]?.id ?? null;
          setActiveTaskId(next);
          activeRef.current = next;
          setAssets([]);
          if (next) await loadAssets(next);
          else await syncPreviews([]);
        }
      } catch (e) {
        setError(describeError(e)); // 删除失败：任务与材料保持原状，可重试
      }
    },
    [refreshTasks, loadAssets, syncPreviews],
  );

  const refresh = useCallback(async () => {
    setError(null);
    try {
      if (sessionStatus !== "ready") {
        await ensureSession();
        setSessionStatus("ready");
        setSessionError(null);
      }
      const items = await refreshTasks();
      const current = activeRef.current;
      if (current && items.some((t) => t.id === current)) {
        await loadAssets(current);
      } else if (items.length > 0) {
        setActiveTaskId(items[0].id);
        activeRef.current = items[0].id;
        await loadAssets(items[0].id);
      } else {
        setActiveTaskId(null);
        activeRef.current = null;
        setAssets([]);
        await syncPreviews([]);
      }
    } catch (e) {
      setError(describeError(e));
    }
  }, [sessionStatus, refreshTasks, loadAssets, syncPreviews]);

  const addBatch = useCallback(
    async (list: PendingImage[]): Promise<Rejection[]> => {
      const rejections: Rejection[] = [];
      if (list.length === 0) return rejections;

      // 确保有活动任务（无则新建一个本人任务）。
      let taskId = activeRef.current;
      if (!taskId) {
        try {
          const task = await apiCreateTask();
          setTasks((prev) => [task, ...prev]);
          taskId = task.id;
          setActiveTaskId(task.id);
          activeRef.current = task.id;
        } catch (e) {
          return list.map(({ file }) => ({ name: file.name, reason: "server", detail: describeError(e) }));
        }
      }

      const accepted: PendingImage[] = [];
      let room = Math.max(MAX_ASSETS_PER_TASK - assets.length, 0);
      for (const { file: f, kind } of list) {
        if (f.size === 0) {
          rejections.push({ name: f.name, reason: "empty" });
          continue;
        }
        if (f.type && !ACCEPTED_TYPES.includes(f.type)) {
          rejections.push({ name: f.name, reason: "type" });
          continue;
        }
        if (f.size > MAX_FILE_SIZE) {
          rejections.push({ name: f.name, reason: "size" });
          continue;
        }
        if (room <= 0) {
          rejections.push({ name: f.name, reason: "limit" });
          continue;
        }
        room -= 1;
        accepted.push({ kind, file: f });
      }

      if (accepted.length === 0) return rejections;

      setUploading(true);
      setError(null);
      try {
        // 顺序上传，服务端逐张校验真实类型/大小/配额；失败的那张不影响已保存材料。
        for (const { file: f, kind } of accepted) {
          try {
            await uploadAsset(taskId, kind, f);
          } catch (e) {
            rejections.push({
              name: f.name,
              reason: "server",
              detail: e instanceof ApiError ? describeError(e) : "上传失败，请重试",
            });
          }
        }
        // 以服务端记录为准刷新（恢复/一致性），而非仅凭本地乐观更新。
        await loadAssets(taskId);
        await refreshTasks();
      } finally {
        setUploading(false);
      }
      return rejections;
    },
    [assets.length, loadAssets, refreshTasks],
  );

  const addFiles = useCallback((kind: UploadKind, files: FileList | File[]) =>
    addBatch(Array.from(files, (file) => ({ kind, file }))), [addBatch]);

  const removeFile = useCallback(
    async (_kind: UploadKind, id: string) => {
      setError(null);
      try {
        await apiDeleteAsset(id);
        const taskId = activeRef.current;
        if (taskId) {
          await loadAssets(taskId); // 成功后才从 UI 移除，避免“显示已删但实际残留”
          await refreshTasks();
        }
      } catch (e) {
        setError(describeError(e)); // 失败保留记录与预览，可再次点击删除重试
      }
    },
    [loadAssets, refreshTasks],
  );

  const moveFile = useCallback(
    async (kind: UploadKind, id: string, direction: -1 | 1) => {
      const taskId = activeRef.current;
      if (!taskId) return;
      const group = assets.filter((a) => a.kind === kind).sort((a, b) => a.pageIndex - b.pageIndex);
      const index = group.findIndex((a) => a.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= group.length) return;
      const ordered = [...group];
      const [moved] = ordered.splice(index, 1);
      ordered.splice(target, 0, moved);
      setError(null);
      try {
        await reorderAssets(taskId, kind, ordered.map((a) => a.id));
        await loadAssets(taskId);
      } catch (e) {
        setError(describeError(e));
      }
    },
    [assets, loadAssets],
  );

  const paper = useMemo(
    () =>
      assets
        .filter((a) => a.kind === "paper")
        .sort((a, b) => a.pageIndex - b.pageIndex)
        .map((a) => toItem(a, previews[a.id] ?? "")),
    [assets, previews],
  );
  const sheet = useMemo(
    () =>
      assets
        .filter((a) => a.kind === "sheet")
        .sort((a, b) => a.pageIndex - b.pageIndex)
        .map((a) => toItem(a, previews[a.id] ?? "")),
    [assets, previews],
  );

  const activeTask = useMemo(
    () => tasks.find((t) => t.id === activeTaskId) ?? null,
    [tasks, activeTaskId],
  );

  const value: UploadState = {
    paper,
    sheet,
    totalCount: assets.length,
    sessionStatus,
    sessionError,
    tasks,
    activeTaskId,
    activeTask,
    loadingAssets,
    uploading,
    error,
    addFiles,
    addBatch,
    removeFile,
    moveFile,
    selectTask,
    newTask,
    removeTask,
    refresh,
    clearError: () => setError(null),
  };

  return <UploadContext.Provider value={value}>{children}</UploadContext.Provider>;
}

export function useUploads(): UploadState {
  const ctx = useContext(UploadContext);
  if (!ctx) throw new Error("useUploads 必须在 UploadProvider 内使用");
  return ctx;
}
