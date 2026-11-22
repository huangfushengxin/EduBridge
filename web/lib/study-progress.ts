import type { LearningView, ReportQuestion } from "./learning";

export const topicNames: Record<string, string> = {sets:"集合",functions:"函数",basic_inequalities:"基本不等式"};
export const pets = [{id:"cat",name:"橘猫"},{id:"dog",name:"柴犬"},{id:"rabbit",name:"灰兔"}] as const;
export type Pet = typeof pets[number]["id"];

const noDiagnosis = new Set(["teacher_review", "insufficient_evidence", "unsupported_topic"]);
const hasDiagnosis = (question: ReportQuestion) => Boolean(question.topic) && !noDiagnosis.has(question.stage);

function taskDiagnosis(view: LearningView) {
  const report = view.report;
  if (!report) return {status:"未诊断",questions:[]} as const;
  const current = report.questions.filter(hasDiagnosis);
  if (view.stale && current.length) return {status:"待重新诊断",questions:[]} as const;

  const eligible = new Map(view.eligibleQuestions.map(({id,version}) => [id,version]));
  const history = report.history.flatMap((entry) => entry.questions.filter(hasDiagnosis).map((question) => ({
    question, simulated:entry.simulated, fallbackTime:entry.retiredAt,
  })));
  const questions = [
    ...current.map((question) => ({question, simulated:view.simulated, fallbackTime:report.startedAt})),
    ...history.filter(({question}) => eligible.get(question.id) === question.version),
  ];
  if (questions.length) return {status:"已诊断",questions} as const;
  if (history.length) return {status:"待重新诊断",questions:[]} as const;
  return {status:view.busy ? "诊断中" : "未诊断",questions:[]} as const;
}

export const taskDiagnosisStatus = (view: LearningView) => taskDiagnosis(view).status;

export interface StudyResult {
  taskId: string;
  diagnoses: {questionId: string; time: number; topic: string}[];
  retakes: {time: number; right: boolean}[];
}

export function studyResults(taskId: string, view: LearningView): StudyResult {
  const diagnoses = new Map<string, StudyResult["diagnoses"][number]>();
  for (const {question,simulated,fallbackTime} of taskDiagnosis(view).questions) {
    if (simulated || !question.topic) continue;
    const time = Date.parse(question.diagnosedAt ?? fallbackTime);
    const previous = diagnoses.get(question.id);
    if (!previous || (Number.isFinite(time) && (!Number.isFinite(previous.time) || time < previous.time))) {
      diagnoses.set(question.id,{questionId:question.id,time,topic:question.topic});
    }
  }

  const retakes = new Map<string, StudyResult["retakes"][number]>();
  const recordRetakes = (questions: ReportQuestion[]) => {
    for (const {id,version,completedAt,status} of questions) {
      if (!completedAt || (status !== "passed" && status !== "practice_needed")) continue;
      const time = Date.parse(completedAt);
      if (!Number.isFinite(time)) continue;
      retakes.set(`${id}/${version}/${time}`,{time,right:status === "passed"});
    }
  };
  if (view.report) {
    if (!view.simulated) recordRetakes(view.report.questions);
    for (const entry of view.report.history) if (!entry.simulated) recordRetakes(entry.questions);
  }
  return {taskId,diagnoses:[...diagnoses.values()],retakes:[...retakes.values()]};
}

const chinaDay = new Intl.DateTimeFormat("sv-SE", {timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"});
export const studyDay = (time: number) => chinaDay.format(time);

export function summarizeStudy(results: StudyResult[], now: number) {
  const today = studyDay(now);
  const days = Array.from({length:7}, (_, index) => ({date:studyDay(now - (6 - index) * 86_400_000),count:0}));
  const byDay = new Map(days.map((day) => [day.date,day]));
  const topics = new Map<string, number>();
  let count = 0;
  let right = 0;
  let retakeCount = 0;
  let diagnosedTasks = 0;
  for (const {diagnoses,retakes} of new Map(results.map((result) => [result.taskId,result])).values()) {
    if (diagnoses.length) diagnosedTasks++;
    for (const {time,topic} of diagnoses) {
      if (!Number.isFinite(time)) continue;
      const date = studyDay(time);
      const day = byDay.get(date);
      if (day) day.count++;
      if (date !== today) continue;
      count++;
      const name = topicNames[topic] ?? "其他";
      topics.set(name,(topics.get(name) ?? 0) + 1);
    }
    for (const retake of retakes) {
      if (studyDay(retake.time) !== today) continue;
      retakeCount++;
      if (retake.right) right++;
    }
  }
  return {days,count,right,retakeCount,diagnosedTasks,topics:[...topics.entries()].sort((a,b) => b[1] - a[1])};
}

export interface LocalProfile {
  nickname: string;
  pet: Pet | null;
  credited: string[];
}
const profileKey = "eduBridge.workspaceProfile.v1";

export function readProfile(): LocalProfile {
  try {
    const data = JSON.parse(localStorage.getItem(profileKey) ?? "null");
    if (data && typeof data.nickname === "string" && Array.isArray(data.credited)) {
      // The previous profile stored one task/question/version/time key per retake.
      const keys = (data.credited as unknown[]).filter((key): key is string => typeof key==="string");
      const credited = [...new Set(keys.map((key) => key.split("/")[0]).filter(Boolean))];
      return {nickname:data.nickname.slice(0,24),pet:pets.some(({id})=>id===data.pet) ? data.pet : null,credited};
    }
  } catch { /* A fresh profile is safe when storage is unavailable. */ }
  return {nickname:"",pet:null,credited:[]};
}

export function saveProfile(profile: LocalProfile) {
  try {
    localStorage.setItem(profileKey,JSON.stringify(profile));
    return true;
  } catch {
    return false;
  }
}

export function rememberStudy(results: StudyResult[]) {
  const profile = readProfile();
  if (!profile.pet) return profile;
  const credited = new Set(profile.credited);
  for (const {taskId,diagnoses} of results) if (diagnoses.length) credited.add(taskId);
  if (credited.size === profile.credited.length) return profile;
  const updated = {...profile,credited:[...credited]};
  saveProfile(updated);
  return updated;
}

export function petGrowth(profile: LocalProfile) {
  const total = new Set(profile.credited).size * 10;
  const age = Math.floor(total / 100);
  return {age,life:total % 100,stage:Math.min(age,2)};
}
