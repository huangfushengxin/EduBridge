import { requestJson } from "@/lib/api";
import type { Diagnosis } from "@/lib/schemas";

export interface Selection {
  id: string;
  number: string | null;
  version: number;
}

export interface LearningItem {
  id: string;
  stem: string;
  conditions: string[];
  target_hypothesis_id: string;
  artifact_version: number;
  options?: { key: string; text: string }[];
  attempt: { response: string; result: "right" | "wrong" | "partial" | null; note: string | null; answer?: string } | null;
}

export interface ReportQuestion extends Selection {
  topic: string | null;
  stage: string;
  status: "pending" | "passed" | "practice_needed" | "needs_review";
  diagnosedAt?: string | null;
  completedAt: string | null;
  diagnosticResults?: ("right" | "wrong" | "partial")[];
}

export interface LearningView {
  eligibleQuestions: Selection[];
  revision: number | null;
  modelCalls: number;
  modelLimit: number;
  stale: boolean;
  busy: boolean;
  configured: boolean;
  simulated: boolean;
  report?: {
    startedAt: string;
    stale: boolean;
    questions: ReportQuestion[];
    history: { retiredAt: string; simulated: boolean; questions: ReportQuestion[] }[];
  } | null;
  work: {
    question: Selection;
    stage: string;
    error: string | null;
    repairPending: boolean;
    formatIssue?: string | null;
    formatRetryAvailable?: boolean;
    ruleExerciseRecoveryAvailable?: boolean;
    mathRetryAvailable?: boolean;
    mathRegenAvailable?: boolean;
    templateRecoveryAvailable?: boolean;
    diagnosis: Diagnosis | null;
    teacher_review_reason: string | null;
    items: LearningItem[];
    retake?: LearningItem | null;
    teaching: { id: string; artifact_version: number; steps: { title: string; text: string; original_step: string | null }[] } | null;
    checks: {
      artifact_id: string;
      artifact_version: number;
      review_status: string | null;
      verification_status: string | null;
      reviewed_by: string | null;
      math_code: string | null;
      checks: { artifact_version: number; check_type: string; status: string; issues: { type: string; severity: string }[]; created_at: string }[];
    }[];
  }[];
}

const post = (path: string, body: unknown) => requestJson<LearningView>(path, {
  method: "POST", body: JSON.stringify(body),
});

export const readLearning = (taskId: string, signal?: AbortSignal) =>
  requestJson<LearningView>("/api/tasks/" + taskId + "/learning", { signal });
export const startLearning = (taskId: string, questions: Selection[]) =>
  post("/api/tasks/" + taskId + "/diagnose", { questions: questions.map(({id,version}) => ({id,version})) });
export const advanceLearning = (taskId: string, questionId: string, expectedStage: string, expectedRevision: number | null) =>
  post("/api/tasks/" + taskId + "/learning/advance", { questionId, expectedStage, expectedRevision });
export const submitAttempt = (taskId: string, item: LearningItem, response: string) =>
  post("/api/items/" + item.id + "/attempts", { taskId, response, artifactVersion: item.artifact_version });
export const startRetake = (taskId: string, questionId: string) =>
  post("/api/tasks/" + taskId + "/learning/retake", { questionId });
export const startTeaching = (taskId: string, diagnosisId: string) =>
  post("/api/diagnoses/" + diagnosisId + "/teach", { taskId });
