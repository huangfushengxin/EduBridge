import {
  questionSnapshot, diagnosePrompt, reviewPrompt, gradePrompt, teachingPrompt,
  parseDiagnosis, parseReviews, parseGrades, parseTeaching, modelFamily,
} from "./pipeline.mjs";
import { retakeDraft, ruleExerciseDraft } from "./retake.mjs";
import { minimumLesson, ruleLesson, templateAuthor } from "./minimum-lesson.mjs";

const maxQuestions = 3;
const lockDurationMs = 120000;
const workStages = new Set(["diagnose","generate_items","verify_items","review_items","grade","generate_teaching","verify_teaching","review_teaching","verify_retake","review_retake"]);
const fieldList = "task_id,owner_token_hash,revision,state,created_at,updated_at";
const iso = () => new Date().toISOString();

function makeArtifact(draft, generatedBy, old) {
  return {
    ...draft, id:old?.id ?? crypto.randomUUID(), artifact_version:(old?.artifact_version ?? 0) + 1,
    created_at:old?.created_at ?? iso(), updated_at:iso(), generatedBy,
    verification_status:null, review_status:null, math_coverage:null,
    history:[...(old?.history ?? []),{artifact_version:(old?.artifact_version ?? 0)+1,check_type:"rule_check",status:"passed",created_at:iso()}],
  };
}

function publishable(artifact) {
  if (artifact.review_status !== "pass" || !artifact.verification_status || artifact.verification_status === "failed") return false;
  return artifact.manualReview === "pass" || (artifact.math_coverage === "covered" && artifact.verification_status === "passed");
}

function audit(artifact) {
  return {
    artifact_id:artifact.id, artifact_version:artifact.artifact_version,
    review_status:artifact.review_status, verification_status:artifact.verification_status,
    reviewed_by:artifact.manualReview === "pass" ? "human" : artifact.reviewedBy ?? null,
    math_code:artifact.mathCode ?? null,
    checks:artifact.history.map((h) => ({
      artifact_version:h.artifact_version, check_type:h.check_type, status:h.status,
      issues:h.issues?.map((i) => ({type:i.type, severity:i.severity})) ?? [],
      created_at:h.created_at,
    })),
  };
}

function publicItem(item) {
  return {
    id:item.id, stem:item.stem, conditions:item.conditions, artifact_version:item.artifact_version,
    target_hypothesis_id:item.target_hypothesis_id, review_status:item.review_status, verification_status:item.verification_status,
    ...(item.options ? {options:item.options} : {}),
    attempt:item.attempt ? {
      response:item.attempt.response, result:item.attempt.result ?? null, note:item.attempt.note ?? null,
      ...(item.attempt.result ? {answer:item.answer_private} : {}),
    } : null,
  };
}

function reportQuestion(work) {
  const attempt = work.retake?.attempt;
  const status = attempt?.result === "right" ? "passed"
    : attempt?.result ? "practice_needed"
    : ["needs_review", "teacher_review"].includes(work.stage) ? "needs_review" : "pending";
  return {
    id:work.question.id, number:work.question.number, version:work.question.version,
    topic:work.diagnosis?.knowledge_point ?? null, stage:work.stage, status,
    diagnosedAt:work.diagnosis?.created_at ?? null,
    completedAt:attempt?.created_at ?? null,
    diagnosticResults:work.items.filter(publishable).flatMap(({ attempt }) =>
      attempt?.result ? [attempt.result] : []),
  };
}

function ruleExerciseRecovery(work) {
  return (work.stage === "needs_review" || work.stage === "generate_items") && work.error === "schema_invalid" &&
    work.fixStage === "generate_items" && Boolean(work.diagnosis) && !work.items.some((item) => item.attempt);
}

function canRetryFormat(work) {
  return work.stage === "needs_review" && work.error === "schema_invalid" &&
    (ruleExerciseRecovery(work) || (!work.formatRecoveryUsed && workStages.has(work.fixStage)));
}

const retryableMathCodes = new Set(["math_service_unavailable", "math_timeout", "math_capacity", "math_worker_unavailable", "math_not_configured", "invalid_claim"]);

function canRetryMathArtifact(artifact) {
  return artifact.review_status === "pass" && artifact.math_coverage === "covered" &&
    ["unsupported", "timeout"].includes(artifact.verification_status) && retryableMathCodes.has(artifact.mathCode);
}

function mathRetryStage(work) {
  if (work.stage !== "needs_review" || work.error === "schema_invalid") return null;
  const pending = work.retake ? [work.retake] : work.teaching ? [work.teaching] : work.items;
  if (!pending.some(canRetryMathArtifact) || !pending.every((artifact) => publishable(artifact) || canRetryMathArtifact(artifact))) return null;
  return work.retake ? "retake_ready" : work.teaching ? "teaching_ready" : "diagnostic_ready";
}

// 数学验证真实失败（failed）时，按阶段各允许一次重生成（诊断练习 / 讲解 / 复测）；
// 旧版布尔记录视为“诊断练习已用”，其余阶段仍可各自重生成一次。
// 新版本仍须重新通过规则、数学验证与独立审核，禁止绕过任何门槛。
function canRegenMathArtifact(artifact) {
  // 旧记录可能在审核前就已经判定失败，尚未写入 math_coverage。
  return artifact.verification_status === "failed";
}

const regenKey = (work) => work.retake ? "retake" : work.teaching ? "teaching" : "items";

function regenUsed(work, key) {
  if (work.mathRegenUsed === true) return key === "items";
  return Boolean(work.mathRegenUsed?.[key]);
}

function markRegenUsed(work, key) {
  const used = work.mathRegenUsed === true
    ? { items:true, teaching:false, retake:false }
    : { items:false, teaching:false, retake:false, ...(work.mathRegenUsed ?? {}) };
  used[key] = true;
  work.mathRegenUsed = used;
}

function mathRegenStage(work) {
  if (work.stage !== "needs_review") return null;
  if (templateRecovery(work)) return "generate_teaching";
  if (regenUsed(work, regenKey(work))) return null;
  const pending = work.retake ? [work.retake] : work.teaching ? [work.teaching] : work.items;
  if (!pending.length || !pending.some(canRegenMathArtifact) ||
    !pending.every((artifact) => publishable(artifact) || canRegenMathArtifact(artifact))) return null;
  return work.retake ? "retake" : work.teaching ? "generate_teaching" : "generate_items";
}

function templateRecovery(work) {
  return work.stage === "needs_review" && !work.retake &&
    work.teaching?.verification_status === "failed" && work.teaching.generatedBy !== templateAuthor &&
    Boolean(minimumLesson(work));
}

function publicWork(work) {
  return {
    question:{ id:work.question.id, number:work.question.number, version:work.question.version },
    diagnosis:work.stage === "teacher_review" ? null : work.diagnosis ?? null,
    teacher_review_reason:work.stage === "teacher_review" ? work.diagnosis.grading_review_reason : null,
    stage:work.stage, error:work.error ?? null, formatIssue:work.formatIssue ?? null,
    repairPending:work.error === "schema_invalid" && work.fixStage === work.stage,
    formatRetryAvailable:canRetryFormat(work),
    ruleExerciseRecoveryAvailable:ruleExerciseRecovery(work),
    mathRetryAvailable:Boolean(mathRetryStage(work)),
    mathRegenAvailable:Boolean(mathRegenStage(work)),
    templateRecoveryAvailable:templateRecovery(work),
    items:(work.items.every(publishable) ? work.items : []).map(publicItem),
    retake:work.retake && publishable(work.retake) ? publicItem(work.retake) : null,
    teaching:work.teaching && publishable(work.teaching) ? {
      id:work.teaching.id, steps:work.teaching.steps, rule_ids:work.teaching.rule_ids,
      artifact_version:work.teaching.artifact_version, review_status:work.teaching.review_status,
      verification_status:work.teaching.verification_status,
    } : null,
    checks:[...work.items, ...[work.teaching,work.retake].filter(Boolean)].map(audit),
  };
}

export function learningRoutes({db, fail, rows, requireOwner, ownedTask, currentQuestions, input, uuid, budget, model, verifyMath, authorizeReviewer = async () => false, noStore}) {
  const find = async (task, owner) => (rows(await db.from("learning_sessions").select(fieldList)
    .eq("task_id",task).eq("owner_token_hash",owner).limit(1)) ?? [])[0];
  const persist = async (row, state) => (rows(await db.from("learning_sessions")
    .update({state,revision:row.revision+1,updated_at:iso()}).eq("task_id",row.task_id)
    .eq("owner_token_hash",row.owner_token_hash).eq("revision",row.revision).select(fieldList)) ?? [])[0];
  const active = (state) => Date.parse(state?.lock?.until ?? "") > Date.now();
  const versionSet = (selection) => new Map(selection.map((q) => [q.id,q.version]));
  const eligible = (questions) => questions.filter((q) => q.status === "confirmed" && q.human?.gradingResult === "wrong" && q.human.stem?.trim());
  const isCurrent = (state, qs) => {
    const versions = versionSet(eligible(qs).map((q) => ({id:q.id,version:q.confirmedVersion})));
    return state.works.every((w) => versions.get(w.question.id) === w.question.version);
  };
  const json = (data,status=200) => Response.json(data,{status,headers:noStore});

  async function view(task, owner, row, questions) {
    const state = row?.state;
    const stale = Boolean(state && !isCurrent(state, questions));
    return {
      eligibleQuestions:eligible(questions).map((q) => ({ id:q.id,number:q.human.number ?? q.number,version:q.confirmedVersion })),
      revision:row?.revision ?? null,
      stale, simulated:state?.simulated === true, modelCalls:await budget.count(task,owner), modelLimit:budget.limit(task),
      work:state && !stale ? state.works.map(publicWork) : [],
      report:state ? {
        startedAt:state.started_at ?? row.created_at, stale, questions:state.works.map(reportQuestion),
        history:(state.history ?? []).slice().reverse().map((entry) => ({
          retiredAt:entry.retired_at, simulated:entry.simulated ?? (state.simulated === true),
          questions:entry.works.map(reportQuestion),
        })),
      } : null,
      busy:Boolean(state && active(state)), configured:model?.roleConfigured?.("diagnosis")?.configured === true,
    };
  }

  async function save(row,state) {
    const result = await persist(row,state);
    if (!result) fail("write_conflict",409);
    return result;
  }

  const reviewArtifacts = (work, stage) => stage === "review_items" ? work.items
    : [stage === "review_retake" ? work.retake : work.teaching];

  async function verifyArtifacts(artifacts) {
    await Promise.all(artifacts.map(async (artifact) => {
      const result = verifyMath ? await verifyMath(artifact.math_claims, { conditions: artifact.conditions }) : {status:"unsupported",code:"math_not_configured"};
      artifact.verification_status = result.status;
      artifact.mathCode = result.code;
      // failed 必来自 SymPy 对受支持命题的实际评估；审核未运行时 coverage 由此确定，重生成门槛据此开放。
      if (result.status === "failed") artifact.math_coverage = "covered";
      artifact.history.push({artifact_version:artifact.artifact_version,check_type:"math_verify",status:result.status,created_at:iso()});
    }));
  }

  async function runModel(row, work, role, prompt, parse, stage) {
    if (!model?.roleConfigured?.(role)?.configured) {
      work.error = "learning_model_not_configured";
      return null;
    }
    if (role === "review") {
      const names = model.modelIds?.() ?? {};
      const reviewer = modelFamily(names.review);
      const drafts = reviewArtifacts(work,stage);
      const generator = drafts.every((a) => a.generatedBy === templateAuthor) ? names.diagnosis
        : stage === "review_items" ? names.diagnosis : names.tutor;
      if (!reviewer || !modelFamily(generator) || reviewer === modelFamily(generator) ||
        drafts.some((a) => reviewer === modelFamily(a.generatedBy)) ||
        (stage === "review_retake" && reviewer === modelFamily(work.teaching.generatedBy))) {
        work.error = "independent_model_required";
        return null;
      }
    }
    const runId = await budget.reserve(row.task_id,row.owner_token_hash,work.question.jobId,role,"learning-v1/" + stage);
    if (!runId) {
      work.error = "budget_exceeded";
      return null;
    }
    let result;
    try {
      const issueAdvice = {
        diagnosis_json:"只输出合法 JSON 对象。使用 Unicode 数学符号或在 JSON 字符串中正确转义反斜杠。",
        diagnosis_topic:"核对 knowledge_point 的取值范围。超出范围时按约定返回 unsupported_topic。",
        diagnosis_step:"first_error_step_id 使用原文步骤里的实际编号。无法定位时填 null 并说明证据不足。",
        diagnosis_hypotheses:"核对 hypotheses 的数量、分类和必填字段。证据不足时填写 insufficient_reason。",
        diagnosis_rules:"核对 rule_ids。只能填当前知识点下列出的规则编码。",
        diagnosis_evidence:"evidence 的 snippet 要逐字复制对应原文片段。检查 step_id 与片段的来源是否一致。",
      };
      const corrective = work.fixStage === stage
        ? "\n上次输出未通过校验。"+(issueAdvice[work.formatIssue] ?? "严格核对 JSON 字段名称、值域和结构。")
        : "";
      const maxTokens = role === "review" ? 1000 * reviewArtifacts(work,stage).length : undefined;
      result = await model.generate(role,prompt + corrective,maxTokens);
    } catch {
      result = {ok:false,errorCode:"model_failed"};
    }
    let formatIssue = null;
    let value = result.ok ? parse(result.content, (issue) => { formatIssue = issue; }) : null;
    if (role === "review" && result.ok) {
      const artifacts = reviewArtifacts(work,stage);
      const actual = modelFamily(result.actualModelId);
      const diagnosisFamily = modelFamily(model.modelIds?.()?.diagnosis);
      if (!actual || artifacts.some((a) => actual === modelFamily(a.generatedBy)) ||
        (artifacts.every((a) => a.generatedBy === templateAuthor) && actual === diagnosisFamily) ||
        (stage === "review_retake" && actual === modelFamily(work.teaching.generatedBy))) {
        result = {...result,ok:false,errorCode:"independent_model_required"};
        value = null;
      }
    }
    if (result.ok && !value) {
      result = {...result,ok:false,errorCode:"schema_invalid"};
      work.formatIssue = formatIssue;
      if (work.fixStage === stage) {
        work.stage = "needs_review";
      } else {
        work.fixStage = stage;
      }
    }
    await budget.finish(runId,row.owner_token_hash,result);
    if (!result.ok) {
      work.error = result.errorCode ?? "model_failed";
      if (role === "review") {
        const affected = reviewArtifacts(work,stage);
        for (const artifact of affected) {
          artifact.history.push({artifact_version:artifact.artifact_version,check_type:"model_review",
            status:work.error === "model_timeout" ? "timeout" : "failed",model_run_id:runId,created_at:iso()});
        }
      }
      return null;
    }
    work.fixStage = null;
    work.formatIssue = null;
    return { value, generatedBy:result.actualModelId, runId };
  }

  async function execute(row,work) {
    const stage = work.stage;
    const q = work.question;
    work.error = null;
    if (stage === "diagnose") {
      const result = await runModel(row,work,"diagnosis",diagnosePrompt(q),
        (content,onInvalid) => parseDiagnosis(content,q,onInvalid),stage);
      if (!result) return;
      if (result.value.diagnosis_status === "unsupported_topic") {
        work.stage = "unsupported_topic";
        return;
      }
      work.diagnosis = {
        ...result.value, schema_version:1, diagnosis_id:crypto.randomUUID(), task_id:row.task_id,
        question_id:q.id,input_confirmation_version:q.version,artifact_version:1,created_at:iso(),updated_at:iso(),
      };
      work.stage = result.value.grading_review_reason ? "teacher_review"
        : result.value.diagnosis_status === "insufficient_evidence" ? "insufficient_evidence" : "generate_items";
      return;
    }
    if (stage === "generate_items") {
      const prior = work.items.length ? work.items : [null];
      const lesson = !work.items.length ? minimumLesson(work) : null;
      const items = [];
      for (const old of prior) {
        const draft = ruleExerciseDraft({...work, items:[...work.items, ...items]}, {
          targetId:old?.target_hypothesis_id ?? lesson?.target.hypothesis_id,
          ruleIds:lesson?.teaching.rule_ids,
        });
        if (!draft || old?.attempt) {
          work.stage = "needs_review";
          work.error = "practice_rule_unavailable";
          return;
        }
        items.push(makeArtifact(draft,templateAuthor,old));
      }
      work.items = items;
      work.fixStage = null;
      work.formatIssue = null;
      work.mathFix = null;
      work.stage = "verify_items";
      return;
    }
    if (stage === "generate_teaching") {
      const draft = minimumLesson(work)?.teaching ?? ruleLesson(work);
      if (draft) {
        work.teaching = makeArtifact(draft,templateAuthor,work.teaching);
        work.fixStage = null;
        work.formatIssue = null;
        work.mathFix = null;
        work.stage = "verify_teaching";
        return;
      }
      const correction = work.mathFix?.stage === stage
        ? "上次数学验证失败（" + work.mathFix.code + "）：受限定义域下不得把 AM-GM 的不可达等号点当作最小值；请修正题干、答案与 math_claims，使其与定义域内可达的最值一致，并重新核对定义域与等号可取得性。"
        : "";
      const prompt = teachingPrompt(q,work.diagnosis,work.items,work.teaching ?? null,correction);
      const result = await runModel(row,work,"tutor",prompt,(content) => parseTeaching(content,q,work.diagnosis),stage);
      if (!result) return;
      work.teaching = makeArtifact(result.value,result.generatedBy,work.teaching);
      if (work.mathFix?.stage === stage) work.mathFix = null;
      work.stage = "verify_teaching";
      return;
    }
    if (stage === "verify_items" || stage === "verify_teaching" || stage === "verify_retake") {
      const reviewStage = stage.replace("verify_", "review_");
      const artifacts = reviewArtifacts(work,reviewStage);
      await verifyArtifacts(artifacts);
      if (work.mathFix?.stage === stage) work.mathFix = null;
      // 数学已判失败的内容过不了发布门槛：不浪费独立审核调用，直接转重生成/人工入口。
      if (artifacts.some((a) => a.verification_status === "failed")) {
        work.stage = "needs_review";
        return;
      }
      work.stage = reviewStage;
      return;
    }
    if (stage === "review_items" || stage === "review_teaching" || stage === "review_retake") {
      const items = stage === "review_items";
      const retake = stage === "review_retake";
      const artifacts = reviewArtifacts(work,stage);
      // 旧版卡死状态（数学 failed 仍停在 review_*）在此无模型调用转 needs_review。
      if (artifacts.some((a) => a.verification_status === "failed")) {
        work.stage = "needs_review";
        return;
      }
      const priorItems = retake ? work.items.map((a)=>a.stem) : undefined;
      const prompt = reviewPrompt(items ? "item" : retake ? "retake" : "teaching",q,work.diagnosis,artifacts,priorItems);
      const result = await runModel(row,work,"review",prompt,
        (content) => parseReviews(content,artifacts),stage);
      if (!result) return;
      for (const review of result.value) {
        const a = review.artifact;
        a.review_status = review.review_status;
        a.math_coverage = review.math_coverage;
        a.reviewedBy = "model";
        a.history = [...a.history, {artifact_version:a.artifact_version,check_type:"model_review", status:a.review_status,
          issues:review.issues,model_run_id:result.runId, created_at:iso()}];
      }
      if (artifacts.every(publishable)) {
        work.stage = items ? "diagnostic_ready" : retake ? "retake_ready" : "teaching_ready";
      } else if (retake && work.retake.review_status === "revise" && work.retake.artifact_version === 1) {
        const revised = retakeDraft(work);
        if (revised) {
          work.retake = makeArtifact(revised,templateAuthor,work.retake);
          work.stage = "verify_retake";
        } else work.stage = "needs_review";
      } else if (!retake && artifacts.some((a) => a.review_status === "revise") && !work.revisionUsed[items ? "items" : "teaching"]) {
        work.revisionUsed[items ? "items" : "teaching"] = true;
        work.stage = items ? "generate_items" : "generate_teaching";
      } else {
        work.stage = "needs_review";
      }
      return;
    }
    if (stage === "grade") {
      const result = await runModel(row,work,"diagnosis",gradePrompt(work.items),(content)=>parseGrades(content,work.items),stage);
      if (!result) return;
      for (const grade of result.value) {
        const item = work.items.find((a)=>a.id===grade.item_id);
        Object.assign(item.attempt,{result:grade.result,note:grade.note,effect:grade.effect});
      }
      for (const hypothesis of work.diagnosis.hypotheses) {
        const effects = new Set(work.items.filter((a)=>a.target_hypothesis_id===hypothesis.hypothesis_id)
          .map((a)=>a.attempt.effect).filter((e)=>e!=="inconclusive"));
        hypothesis.support_status = effects.size!==1 ? "needs_verification" : effects.has("supports") ? "supported" : "not_supported";
      }
      if (work.diagnosis.hypotheses.some((h)=>h.support_status==="supported")) work.diagnosis.diagnosis_status = "supported";
      else if (work.diagnosis.hypotheses.every((h)=>h.support_status==="not_supported")) work.diagnosis.diagnosis_status = "not_supported";
      work.diagnosis.updated_at = iso();
      work.stage = "diagnostic_submitted";
    }
  }

  return async function handleLearning(request, path) {
    const match = path.match(/^\/api\/tasks\/([0-9a-f-]{36})\/(diagnose|learning(?:\/(?:advance|manual-review|retake))?)$/);
    const attempt = path.match(/^\/api\/items\/([0-9a-f-]{36})\/attempts$/);
    const teach = path.match(/^\/api\/diagnoses\/([0-9a-f-]{36})\/teach$/);
    if (!match && !attempt && !teach) return null;
    const owner = await requireOwner(request);
    const action = match?.[2] ?? (attempt ? "attempt" : "teach");
    const method = request.method;
    if ((action === "learning" ? method !== "GET" : action === "learning/manual-review" ? !["GET","POST"].includes(method) : method !== "POST")) return null;
    if (action === "learning/manual-review" && !await authorizeReviewer(request)) fail("reviewer_required",403);
    const body = method === "POST" ? await input(request) : null;
    const task = match?.[1] ?? body?.taskId;
    if (!uuid(task)) fail("invalid_input",400);
    await ownedTask(task,owner);
    const [questions,row] = await Promise.all([currentQuestions(task,owner),find(task,owner)]);

    if (action === "learning") return json(await view(task,owner,row,questions));
    if (action === "diagnose") {
      const selection = body?.questions;
      if (!Array.isArray(selection) || selection.length < 1 || selection.length > maxQuestions ||
        new Set(selection.map((q)=>q?.id)).size !== selection.length ||
        !selection.every((q)=>uuid(q?.id) && Number.isInteger(q.version) && q.version > 0)) fail("invalid_input",400);
      const index = new Map(questions.map((q)=>[q.id,q]));
      const works = selection.map((requested)=>{
        const q = index.get(requested.id);
        const snapshot = q?.status === "confirmed" ? questionSnapshot(q) : null;
        if (!snapshot || !q.jobId) fail("confirmation_required",409);
        if (snapshot.version !== requested.version) fail("confirmation_changed",409);
        return {question:{...snapshot,jobId:q.jobId},stage:"diagnose",items:[],revisionUsed:{items:false,teaching:false}};
      });
      const newSet = versionSet(selection);
      if (row && row.state.works.length === works.length &&
        row.state.works.every((w)=>newSet.get(w.question.id)===w.question.version)) return json(await view(task,owner,row,questions));
      if (row && active(row.state)) fail("learning_busy",409);
      const previous = row?.state;
      const history = previous?.history ?? [];
      const state = {works, simulated:model?.simulated === true, started_at:iso(),
        history:previous?.works.some((w)=>w.diagnosis) ? [...history,{works:previous.works,retired_at:iso(),simulated:previous.simulated === true}] : history};
      const started = row ? await save(row,state) : (rows(await db.from("learning_sessions").insertIfAbsent({
        task_id:task,owner_token_hash:owner,revision:0,state,
      },{onConflict:"task_id"}).select(fieldList)) ?? [])[0];
      const result = started ?? await find(task,owner);
      if (!result) fail("write_conflict",409);
      return json(await view(task,owner,result,questions),202);
    }

    if (!row) fail("not_found",404);
    if (!isCurrent(row.state,questions)) fail("confirmation_changed",409);
    if (action === "learning/manual-review" && method === "GET") {
      return json({work:row.state.works.filter((w)=>w.stage==="needs_review" && w.error!=="schema_invalid")});
    }
    if (active(row.state)) fail("learning_busy",409);
    const state = structuredClone(row.state);
    state.lock = null;
    if (action === "attempt") {
      const work = state.works.find((w)=>w.retake?.id===attempt[1] || w.items.some((a)=>a.id===attempt[1]));
      const retake = work?.retake?.id===attempt[1];
      const item = retake ? work.retake : work?.items.find((a)=>a.id===attempt[1]);
      const response = typeof body?.response === "string" ? body.response.trim() : "";
      if (!response || response.length > 2400 || !Number.isInteger(body?.artifactVersion)) fail("invalid_input",400);
      if (!item || !publishable(item)) fail("item_not_ready",409);
      if (item.options && !item.options.some((option)=>option.key===response)) fail("invalid_input",400);
      if (body.artifactVersion !== item.artifact_version) fail("write_conflict",409);
      if (item.attempt) {
        if (item.attempt.response !== response) fail("attempt_exists",409);
        return json(await view(task,owner,row,questions));
      }
      if (retake ? work.stage !== "retake_ready" : work.stage !== "diagnostic_ready") fail("item_not_ready",409);
      item.attempt = {attempt_id:crypto.randomUUID(),response,created_at:iso()};
      if (retake) {
        const correct = response === item.correctOption;
        item.attempt.result = correct ? "right" : "wrong";
        item.attempt.note = correct ? "本次复测通过。" : "本次复测仍需练习。可以对照参考解答复盘。";
        work.stage = "retake_completed";
      } else if (item.correctOption && work.items.length === 1) {
        const correct = response === item.correctOption;
        Object.assign(item.attempt, {result:correct ? "right" : "wrong", effect:"inconclusive",
          note:correct ? "这道诊断题答对了，可以继续核对原题条件。" : "这道诊断题答错了，可以对照参考解答复盘。"});
        work.stage = "diagnostic_submitted";
      } else if (work.items.every((a)=>a.attempt)) work.stage = "grade";
    } else if (action === "learning/retake") {
      if (!uuid(body?.questionId)) fail("invalid_input",400);
      const work = state.works.find((w)=>w.question.id===body.questionId);
      if (!work) fail("not_found",404);
      if (work.retake) return json(await view(task,owner,row,questions));
      if (work.stage !== "teaching_ready" || !work.teaching || !publishable(work.teaching)) fail("retake_requires_teaching",409);
      const draft = retakeDraft(work);
      if (!draft) fail("retake_rule_unavailable",409);
      work.retake = makeArtifact(draft,templateAuthor);
      work.stage = "verify_retake";
      work.error = null;
    } else if (action === "teach") {
      const work = state.works.find((w)=>w.diagnosis?.diagnosis_id===teach[1]);
      if (!work) fail("not_found",404);
      if (work.retake || ["generate_teaching","verify_teaching","review_teaching","teaching_ready"].includes(work.stage)) return json(await view(task,owner,row,questions));
      if (work.stage!=="diagnostic_submitted") fail("attempts_required",409);
      work.stage = "generate_teaching";
    } else if (action === "learning/manual-review") {
      if (!uuid(body?.artifactId)) fail("invalid_input",400);
      const work = state.works.find((w)=>[...w.items,w.teaching,w.retake].some((a)=>a?.id===body.artifactId));
      const pending = work?.retake ? [work.retake] : work?.teaching ? [work.teaching] : work?.items;
      const artifact = pending?.find((a)=>a.id===body.artifactId);
      const note = typeof body?.note === "string" ? body.note.trim() : "";
      if (!artifact || work.stage !== "needs_review" || work.error === "schema_invalid") fail("review_not_pending",409);
      if (body.artifactVersion !== artifact.artifact_version || !note || note.length>1500 || !["pass","needs_human_review"].includes(body.decision)) fail("invalid_input",400);
      if (body.decision === "pass" && (artifact.review_status !== "pass" || !["unsupported","timeout","passed"].includes(artifact.verification_status))) fail("review_blocked",409);
      artifact.manualReview = body.decision;
      artifact.history.push({artifact_version:artifact.artifact_version,check_type:"human_review",status:body.decision,note,created_at:iso()});
      if (work.retake && publishable(work.retake)) work.stage = "retake_ready";
      else if (!work.retake && work.teaching && publishable(work.teaching)) work.stage = "teaching_ready";
      else if (!work.teaching && work.items.every(publishable)) work.stage = "diagnostic_ready";
    } else {
      if (!uuid(body?.questionId)) fail("invalid_input",400);
      const work = state.works.find((w)=>w.question.id===body.questionId);
      if (!work) fail("not_found",404);
      const retryFormat = canRetryFormat(work);
      const recoverRuleExercise = ruleExerciseRecovery(work);
      const recoveredStage = mathRetryStage(work);
      const regenStage = mathRegenStage(work);
      if (!workStages.has(work.stage) && !retryFormat && !recoveredStage && !regenStage) return json(await view(task,owner,row,questions));
      if (body.expectedStage !== work.stage || body.expectedRevision !== row.revision) return json(await view(task,owner,row,questions));
      if (((retryFormat && !recoverRuleExercise) || regenStage) && await budget.count(task,owner) >= budget.limit(task)) fail("budget_exceeded",409);
      state.lock = { until:new Date(Date.now()+lockDurationMs).toISOString() };
      const claimed = await save(row,state);
      if (retryFormat) {
        work.stage = work.fixStage;
        if (!recoverRuleExercise) work.formatRecoveryUsed = true;
      }
      if (regenStage) {
        const artifact = work.retake ? work.retake : work.teaching ? work.teaching : work.items.find(canRegenMathArtifact);
        markRegenUsed(work, regenStage === "retake" ? "retake" : regenStage === "generate_teaching" ? "teaching" : "items");
        work.mathFix = { stage: regenStage === "retake" ? "verify_retake" : regenStage, code: artifact?.mathCode ?? "math_failed" };
        if (regenStage === "retake") {
          const draft = retakeDraft(work);
          if (draft) {
            work.retake = makeArtifact(draft,templateAuthor,work.retake);
            work.stage = "verify_retake";
          } else {
            work.error = "retake_rule_unavailable";
          }
        } else {
          work.stage = regenStage;
        }
      }
      try {
        if (recoveredStage) {
          const artifacts = work.retake ? [work.retake] : work.teaching ? [work.teaching] : work.items;
          await verifyArtifacts(artifacts.filter(canRetryMathArtifact));
          work.error = null;
          if (artifacts.every(publishable)) work.stage = recoveredStage;
        } else if (!regenStage || work.stage !== "needs_review") {
          await execute(claimed,work);
        }
      } catch {
        work.error = "learning_step_failed";
      }
      state.lock = null;
      const updated = await save(claimed,state);
      return json(await view(task,owner,updated,await currentQuestions(task,owner)));
    }
    const updated = await save(row,state);
    return json(await view(task,owner,updated,questions));
  };
}
