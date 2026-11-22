/**
 * 第4天：真实图片识别与逐题人工确认的状态 hook。
 *
 * 设计要点（与 functions/routes.mjs 两阶段任务状态机一致）：
 * - 识别只能由用户主动触发（start）。上传/刷新/预览绝不自动调用模型。
 * - start → startRecognize(202 queued) → runJob（单次受限模型调用）→ 轮询 getJob 至终态。
 *   runJob 请求若被网关截断/网络失败，回退为只读轮询服务端真实状态，不假设后台继续执行。
 * - 刷新恢复（load）只读取服务端记录；running 任务做只读轮询，queued 任务等待用户点击继续，
 *   不在刷新时自动发起模型调用。
 * - 防重复点击：recognizingRef 守卫；服务端另有活跃任务/幂等键去重与预算上限。
 * - 失败/超时保留材料与既有人工修订；提供明确重试入口（retry）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  describeError,
  getJob,
  getTaskRecognition,
  runJob,
  startRecognize,
  saveQuestionRevision,
  confirmQuestion,
  type RecognitionJob,
  type RecognitionQuestion,
  type PreviousQuestionEdit,
  type QuestionFields,
} from "./api";

const POLL_INTERVAL_MS = 2000;
const POLL_MAX_MS = 130_000;

export interface UseRecognition {
  loading: boolean;
  recognizing: boolean;
  configured: boolean;
  simulated?: boolean;
  job: RecognitionJob | null;
  questions: RecognitionQuestion[];
  previousEdits: PreviousQuestionEdit[];
  error: string | null;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  refresh: () => Promise<void>;
  saveRevision: (questionId: string, baseVersion: number, fields: QuestionFields) => Promise<RecognitionQuestion>;
  confirm: (questionId: string, baseVersion: number, fields: QuestionFields) => Promise<RecognitionQuestion>;
  clearError: () => void;
}

export function useRecognition(taskId: string | null): UseRecognition {
  const [loading, setLoading] = useState(false);
  const [recognizing, setRecognizing] = useState(false);
  const [provider, setProvider] = useState<{configured:boolean; simulated?:boolean}>({configured:false});
  const [job, setJob] = useState<RecognitionJob | null>(null);
  const [questions, setQuestions] = useState<RecognitionQuestion[]>([]);
  const [previousEdits, setPreviousEdits] = useState<PreviousQuestionEdit[]>([]);
  const [error, setError] = useState<string | null>(null);

  const recognizingRef = useRef(false);
  const aliveRef = useRef(true);
  const pollTokenRef = useRef(0);
  const taskRef = useRef(taskId);
  taskRef.current = taskId;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      pollTokenRef.current += 1; // 取消进行中的轮询
    };
  }, [taskId]);

  const reloadQuestions = useCallback(async () => {
    if (!taskId) return;
    try {
      const state = await getTaskRecognition(taskId);
      if (!aliveRef.current || taskRef.current !== taskId) return;
      setQuestions(state.questions);
      setPreviousEdits(state.previousEdits ?? []);
      setProvider({configured:state.configured,simulated:state.simulated});
    } catch {
      // 读取失败不覆盖既有状态
    }
  }, [taskId]);

  // 只读轮询直至终态（不发起模型调用）。
  const pollUntilTerminal = useCallback(async (jobId: string): Promise<RecognitionJob | null> => {
    const token = ++pollTokenRef.current;
    const deadline = Date.now() + POLL_MAX_MS;
    while (aliveRef.current && token === pollTokenRef.current && Date.now() < deadline) {
      try {
        const { job: j } = await getJob(jobId);
        if (!aliveRef.current || token !== pollTokenRef.current) return null;
        setJob(j);
        if (j.status !== "running") return j;
      } catch {
        // 单次轮询失败继续重试
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    return null;
  }, []);

  const settle = useCallback(async (finalJob: RecognitionJob | null) => {
    if (!aliveRef.current || taskRef.current !== taskId) return;
    if (!finalJob) {
      setError("识别仍在进行或已中断，请点击重试查看最新状态");
      return;
    }
    setJob(finalJob);
    if (finalJob.status === "succeeded") {
      await reloadQuestions();
    } else if (finalJob.status === "failed") {
      setError(describeError(new ApiError(finalJob.errorCode ?? "model_failed", 500)));
      await reloadQuestions(); // 保留既有材料与人工修订
    }
  }, [reloadQuestions, taskId]);

  // 执行任务（分批）：每一批 run 完成后若 status=queued 且 remainingBatches>0，继续 run。
  // 截断/失败退化为只读轮询。
  const execute = useCallback(async (jobId: string) => {
    let finalJob: RecognitionJob | null = null;
    let safety = 0;
    const maxBatches = 40;
    while (safety < maxBatches) {
      if (!aliveRef.current || taskRef.current !== taskId) return;
      try {
        const res = await runJob(jobId);
        if (!aliveRef.current || taskRef.current !== taskId) return;
        finalJob = res.job;
        setJob(finalJob);
        if (res.inProgress || finalJob.status === "running") {
          finalJob = await pollUntilTerminal(jobId);
          if (finalJob?.status === "queued") { safety++; continue; }
          break;
        }
        if (finalJob.status === "queued" && (finalJob.remainingBatches ?? 0) > 0) {
          safety++;
          continue;
        }
        break; // succeeded / failed / queued with 0 remaining
      } catch {
        finalJob = await pollUntilTerminal(jobId);
        if (finalJob?.status === "queued") { safety++; continue; }
        break;
      }
    }
    await settle(finalJob);
  }, [pollUntilTerminal, settle, taskId]);

  // 刷新恢复：只读取记录；running 只读轮询，queued 等待用户继续（不自动调模型）。
  const load = useCallback(async () => {
    if (!taskId) return;
    setLoading(true);
    setError(null);
    try {
      const state = await getTaskRecognition(taskId);
      if (!aliveRef.current || taskRef.current !== taskId) return;
      setJob(state.job);
      setQuestions(state.questions);
      setPreviousEdits(state.previousEdits ?? []);
      setProvider({configured:state.configured,simulated:state.simulated});
      if (state.job?.status === "running") {
        setRecognizing(true);
        recognizingRef.current = true;
        const finalJob = await pollUntilTerminal(state.job.id);
        await settle(finalJob);
        recognizingRef.current = false;
        setRecognizing(false);
      }
    } catch (e) {
      if (aliveRef.current) setError(describeError(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [taskId, pollUntilTerminal, settle]);

  useEffect(() => {
    recognizingRef.current = false;
    setRecognizing(false);
    setJob(null);
    setQuestions([]);
    setPreviousEdits([]);
    setProvider({configured:false});
    setError(null);
    void load();
  }, [load]);

  // 用户主动发起识别（防重复点击）。
  const start = useCallback(async () => {
    if (!taskId || recognizingRef.current) return;
    recognizingRef.current = true;
    setRecognizing(true);
    setError(null);
    try {
      const key = `ui-${taskId}-${Date.now()}`;
      const { job: j } = await startRecognize(taskId, key);
      if (!aliveRef.current || taskRef.current !== taskId) return;
      setJob(j);
      if (j.status === "queued" || j.status === "running") {
        await execute(j.id);
      } else {
        await settle(j);
      }
    } catch (e) {
      if (aliveRef.current) setError(describeError(e));
    } finally {
      if (aliveRef.current && taskRef.current === taskId) {
        recognizingRef.current = false;
        setRecognizing(false);
      }
    }
  }, [taskId, execute, settle]);

  const retry = useCallback(async () => {
    // 只有主动重试可重新认领陈旧任务，正常运行中的任务由服务端拒绝重复调用。
    if (job && job.status === "running") {
      if (recognizingRef.current) return;
      recognizingRef.current = true;
      setRecognizing(true);
      setError(null);
      try {
        await execute(job.id);
      } finally {
        if (aliveRef.current && taskRef.current === taskId) {
          recognizingRef.current = false;
          setRecognizing(false);
        }
      }
      return;
    }
    await start();
  }, [job, start, execute, taskId]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  const updateQuestion = useCallback((updated: RecognitionQuestion) => {
    setQuestions((prev) => prev.map((q) => (q.id === updated.id ? updated : q)));
  }, []);

  const saveRevision = useCallback(async (questionId: string, baseVersion: number, fields: QuestionFields) => {
    const updated = await saveQuestionRevision(questionId, baseVersion, fields);
    updateQuestion(updated);
    await reloadQuestions();
    return updated;
  }, [updateQuestion, reloadQuestions]);

  const confirm = useCallback(async (questionId: string, baseVersion: number, fields: QuestionFields) => {
    const updated = await confirmQuestion(questionId, baseVersion, fields);
    updateQuestion(updated);
    await reloadQuestions();
    return updated;
  }, [updateQuestion, reloadQuestions]);

  const clearError = useCallback(() => setError(null), []);

  return {
    loading,
    recognizing,
    ...provider,
    job,
    questions,
    previousEdits,
    error,
    start,
    retry,
    refresh,
    saveRevision,
    confirm,
    clearError,
  };
}
