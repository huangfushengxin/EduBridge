import { useEffect, useRef, useState } from "react";
import { LearningPrint, LearningReport } from "@/components/LearningReport";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { MathText } from "@/components/MathText";
import { ApiError, describeError } from "@/lib/api";
import { Link, useRouter } from "@/lib/router";
import { useUploads } from "@/lib/store";
import { advanceLearning, readLearning, startLearning, startRetake, startTeaching, submitAttempt, type LearningView } from "@/lib/learning";
import { rememberStudy, studyResults } from "@/lib/study-progress";

const stages: Record<string, string> = {
  diagnose:"分析错因", generate_items:"生成诊断题", verify_items:"验证诊断题", review_items:"审核诊断题",
  diagnostic_ready:"诊断题可作答", grade:"批改诊断作答", diagnostic_submitted:"诊断作答已批改",
  generate_teaching:"生成讲解", verify_teaching:"验证讲解", review_teaching:"审核讲解",
  teaching_ready:"讲解可查看", verify_retake:"验证复测题", review_retake:"审核复测题",
  retake_ready:"复测可作答", retake_completed:"复测已完成", needs_review:"待人工复核", insufficient_evidence:"证据不足", teacher_review:"待核对老师批改",
  unsupported_topic:"暂不支持该知识点",
};
const canAdvance = new Set(["diagnose","generate_items","verify_items","review_items","grade","generate_teaching","verify_teaching","review_teaching","verify_retake","review_retake"]);
const topics: Record<string, string> = {sets:"集合",functions:"函数",basic_inequalities:"基本不等式"};
const support: Record<string, string> = {supported:"得到支持",not_supported:"暂未得到支持",needs_verification:"待验证"};
const checks: Record<string, string> = {math_verify:"数学工具",model_review:"独立模型审核",human_review:"人工复核",rule_check:"规则引用"};
const verdict: Record<string, string> = {
  pass:"通过", revise:"需修改", needs_human_review:"待人工复核", passed:"通过", failed:"未通过",
  unsupported:"未能验证", timeout:"超时", right:"正确", wrong:"错误", partial:"部分正确",
};
const problem: Record<string,string> = {
  domain_omission:"定义域遗漏", missing_condition:"题设条件遗漏", equality_unreachable:"等号不可达",
  math_error:"数学错误", evidence_missing:"证据不足", answer_leak:"题面泄露答案", format:"结构问题", other:"其他问题",
};
const errors: Record<string, string> = {
  confirmation_required:"先核对题干及老师批改并确认错题。",
  confirmation_changed:"人工确认版本已变化，请刷新后重新选择题目。",
  learning_busy:"步骤正在处理中，可以刷新状态。",
  learning_model_not_configured:"该阶段的服务端模型配置未就绪。",
  independent_model_required:"需要与生成模型不同家族的独立审核模型。",
  budget_exceeded:"已用完该任务的模型调用预算，输入和已有结果已保存。",
  attempts_required:"完成诊断作答并取得反馈后即可生成讲解。",
  retake_requires_teaching:"讲解通过审核并可查看后，即可进入变式复测。",
  practice_rule_unavailable:"这道错题还没有匹配的规则题。已保存原题、作答和错因报告，可以继续处理其他题。",
  retake_rule_unavailable:"该题的错因规则暂无适用的复测题。",
  attempt_exists:"该题已保存作答，可以刷新查看。",
  item_not_ready:"题目还在审核或已过期，请刷新。",
  learning_step_failed:"步骤执行失败，已保存的内容可继续恢复。",
  math_response_invalid:"数学验证服务返回了无法读取的结果。",
  invalid_claim:"数学断言格式未通过验证。",
  review_blocked:"该版本仍有阻断项，需要重新审核。",
  math_not_configured:"SymPy 服务未配置",
  math_service_unavailable:"SymPy 服务暂不可用",
  math_timeout:"SymPy 验证超时",
  no_supported_claim:"当前内容没有可验证命题",
  domain_contains_undefined_point:"声明的定义域含未定义点",
  equality_unreachable:"等号条件在题设范围内不可取得",
};
const formatErrors: Record<string,string> = {
  diagnosis_json:"模型未返回可解析的 JSON。",
  diagnosis_topic:"模型返回的知识点超出支持范围。",
  diagnosis_step:"模型引用的错误步骤无法对应到已确认的作答。",
  diagnosis_hypotheses:"模型返回的错因假设缺少必填内容或分类有误。",
  diagnosis_rules:"模型引用的规则与题目知识点不匹配。",
  diagnosis_evidence:"模型引用的证据无法对应到已确认的题干或作答原文。",
};
const message = (error: unknown) => error instanceof ApiError && errors[error.message] ? errors[error.message] : describeError(error);
const clock = (value: string) => new Date(value).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai",hour12:false});

function LearningTask({taskId}: {taskId:string}) {
  const [view, setView] = useState<LearningView | null>(null);
  useEffect(()=>{
    if (view) rememberStudy([studyResults(taskId,view)]);
  },[taskId,view]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [answers, setAnswers] = useState<Record<string,string>>({});
  const [error, setError] = useState("");
  const [pending, setPending] = useState(true);
  const alive = useRef(false);

  useEffect(() => {
    alive.current = true;
    void readLearning(taskId).then((state) => {
      if (!alive.current) return;
      setView(state);
      if (state.eligibleQuestions.length === 1) setChosen([state.eligibleQuestions[0].id]);
    }).catch((e) => { if (alive.current) setError(message(e)); })
      .finally(() => { if (alive.current) setPending(false); });
    return () => { alive.current = false; };
  }, [taskId]);

  // 状态查询只读取当前进度，重进页面后也能跟踪服务端正在处理的步骤。
  useEffect(() => {
    if (!view?.busy || view.stale || pending) return;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const state = await readLearning(taskId, controller.signal);
        if (controller.signal.aborted) return;
        setView(state);
        if (!state.busy || state.stale) return;
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(refresh, 3000);
    };

    timer = setTimeout(refresh, 3000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [taskId, view?.busy, view?.stale, pending]);

  async function perform(action: () => Promise<LearningView>, run = false) {
    if (pending) return;
    setPending(true);
    setError("");
    try {
      let state = await action();
      if (!alive.current) return;
      setView(state);
      for (let i = 0; run && i < 32 && !state.stale && !state.busy; i++) {
        const current = state.work.find((work) => canAdvance.has(work.stage) && (!work.error || work.repairPending));
        if (!current) break;
        const next = await advanceLearning(taskId,current.question.id,current.stage,state.revision);
        if (!alive.current) return;
        setView(next);
        if (state.revision === next.revision) break;
        state = next;
      }
    } catch (e) {
      if (!alive.current) return;
      setError(message(e));
      if (e instanceof ApiError &&
        (e.status === 0 || e.status >= 500 || ["learning_busy", "write_conflict"].includes(e.message))) {
        try {
          const state = await readLearning(taskId);
          if (!alive.current) return;
          setView(state);
          if (state.busy) setError("");
        } catch {
          // 保留原请求的错误和最近一次成功获取的状态。
        }
      }
    } finally {
      if (alive.current) setPending(false);
    }
  }

  const activeStep = view?.work.find(work => canAdvance.has(work.stage) && (!work.error || work.repairPending));
  const availableToContinue = activeStep &&
    (activeStep.stage.startsWith("verify_") || (view && view.modelCalls < view.modelLimit));

  return (
    <div className="grid gap-5" aria-busy={pending}>
      {view?.simulated && <p className="rounded-md bg-amber-100 p-3 text-sm text-amber-950">模拟数据 · 本地测试使用模拟模型和验证结果。</p>}
      {error && <p role="alert" className="rounded-md border border-destructive p-3 text-sm text-destructive">{error}</p>}
      <Card>
        <CardHeader><CardTitle>选择已确认错题</CardTitle></CardHeader>
        <CardContent className="grid gap-4">
          {view && <p className="text-sm text-muted-foreground">模型调用 {view.modelCalls}/{view.modelLimit} 次 · 识别、诊断、审核、讲解与复测共用预算。</p>}
          {view?.stale && <p role="status" className="text-sm">原题确认版本已变化。请重新选择已确认题目。</p>}
          {view && !view.configured && <p role="status" className="text-sm">诊断模型暂不可用，请联系站点负责人检查服务端配置。</p>}
          {view && (view.busy || pending) && (
            <p role="status" className="text-sm">
              {activeStep ? "正在" + stages[activeStep.stage] + "…" : "正在处理…"}
              {view.busy && !pending && " 页面会自动更新进度。"}
            </p>
          )}
          {view && !view.stale && !view.busy && !pending && availableToContinue && (
            <p className="text-sm text-muted-foreground">下方可以点击「继续处理」，从已保存的步骤接着做。</p>
          )}
          {view?.eligibleQuestions.map((q)=>(
            <label key={q.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={chosen.includes(q.id)}
                disabled={pending || (!chosen.includes(q.id) && chosen.length >= 3)}
                onChange={(e) => setChosen((list)=>e.target.checked ? [...list,q.id] : list.filter((id)=>id!==q.id))} />
              第 {q.number ?? "未编号"} 题 · 确认版本 {q.version}
            </label>
          ))}
          {view && view.eligibleQuestions.length === 0 && <p className="text-sm text-muted-foreground">请先在人工确认页的识别结果中，逐题确认至少一道老师已判错的题目。</p>}
          <div className="flex flex-wrap gap-2">
            <Button disabled={pending || !view?.configured || view.busy || !view.eligibleQuestions.some((q)=>chosen.includes(q.id)) || Boolean(view && view.modelCalls>=view.modelLimit)}
              onClick={()=>void perform(()=>startLearning(taskId,view!.eligibleQuestions.filter((q)=>chosen.includes(q.id))),true)}>开始所选错题诊断</Button>
            <Button variant="outline" disabled={pending} onClick={()=>void perform(()=>readLearning(taskId))}>刷新状态</Button>
            <Button asChild variant="ghost"><Link to="/confirm?mode=custom">返回人工确认</Link></Button>
          </div>
          {view && view.modelCalls>=view.modelLimit && <p role="status" className="text-sm text-muted-foreground">本任务模型预算已用尽（{view.modelCalls}/{view.modelLimit}）。开始诊断已停用；刷新状态、查看报告、打印与返回确认仍可用。</p>}
        </CardContent>
      </Card>
      {view && <LearningPrint work={view.work} simulated={view.simulated} />}
      {view?.work.map((work)=>(
        <Card key={work.question.id + "/" + work.question.version}>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">第 {work.question.number ?? "未编号"} 题 <Badge variant="outline">{work.ruleExerciseRecoveryAvailable ? "诊断题可恢复" : work.stage === "needs_review" && work.error === "schema_invalid" ? "格式校验未通过" : stages[work.stage] ?? work.stage}</Badge></CardTitle>
          </CardHeader>
          <CardContent className="grid gap-5">
            {work.ruleExerciseRecoveryAvailable && <p role="status" className="text-sm text-muted-foreground">已保存错因报告。可从已有规则题继续，题目会先经过数学验证与独立审核。</p>}
            {work.error && !work.ruleExerciseRecoveryAvailable && <p role="alert" className="text-sm text-destructive">
              {work.error === "schema_invalid"
                ? (work.formatIssue && formatErrors[work.formatIssue]) || "模型输出未通过结构校验。已保存此前可用的结果。"
                : errors[work.error] ?? describeError(new ApiError(work.error,0))}
            </p>}
            {work.stage === "unsupported_topic" && <p className="text-sm text-muted-foreground">目前支持集合、函数和基本不等式的错因诊断。</p>}
            {work.teacher_review_reason && <div role="status" className="rounded-md border p-3 text-sm">请人工核对批改与解答。<MathText text={work.teacher_review_reason}/></div>}
            {work.diagnosis && (
              <section className="grid gap-3">
                <h2 className="font-semibold">错因报告 · {topics[work.diagnosis.knowledge_point]}</h2>
                {work.diagnosis.first_error_step_id !== null && <p className="text-sm">首个待核对步骤 {work.diagnosis.first_error_step_id+1}</p>}
                {work.diagnosis.hypotheses.map((h)=>(
                  <article key={h.hypothesis_id} className="grid gap-2 rounded-md border p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{h.category === "insufficient_evidence" ? "证据不足" : support[h.support_status]}</Badge><MathText text={h.statement} /></div>
                    <MathText text={h.applicability} />
                    {h.insufficient_reason && <MathText text={h.insufficient_reason} />}
                    {h.evidence.map((e,i)=>(
                      <div key={i} className="border-l-2 pl-3">
                        <p className="text-muted-foreground">{e.source_type==="student_step" ? "学生第 " + (Number(e.step_id)+1) + " 步" : "题目条件"}</p>
                        <MathText text={e.snippet} studentWork={e.source_type === "student_step"} />
                      </div>
                    ))}
                    {h.rule_ids.length>0 && <p className="text-muted-foreground">规则 {h.rule_ids.join("、")}</p>}
                  </article>
                ))}
              </section>
            )}
            {work.items.length > 0 && <h2 className="font-semibold">诊断练习</h2>}
            {work.stage === "diagnostic_ready" && (
              <p className="text-sm text-muted-foreground">完成诊断练习后生成并审核讲解，再开始变式复测。</p>
            )}
            {work.items.map((item)=>(
              <form key={item.id + "/" + item.artifact_version} className="grid gap-3 rounded-md border p-4 text-sm"
                onSubmit={(e)=>{e.preventDefault();void perform(()=>submitAttempt(taskId,item,answers[item.id] ?? ""),true);}}>
                <MathText text={item.stem} />
                {item.conditions.length>0 && <ul className="list-disc pl-5">{item.conditions.map((condition,index)=><li key={index}><MathText text={condition} /></li>)}</ul>}
                {item.attempt ? <>
                  <p>已提交作答</p><MathText text={item.attempt.response} />
                  {item.attempt.result && <p>反馈 · {verdict[item.attempt.result]}</p>}
                  {item.attempt.note && <MathText text={item.attempt.note} />}
                  {item.attempt.answer && <details><summary className="cursor-pointer">参考解答</summary><MathText text={item.attempt.answer} /></details>}
                </> : <>
                  {item.options ? (
                    <fieldset className="grid gap-2" disabled={pending || view.busy || work.stage!=="diagnostic_ready"}>
                      <legend className="pb-2">请选择一项</legend>
                      {item.options.map((option) => (
                        <label key={option.key} className="flex items-start gap-2 rounded-md border px-3 py-2">
                          <input type="radio" className="mt-1" name={"response-" + item.id} value={option.key}
                            checked={answers[item.id]===option.key}
                            onChange={()=>setAnswers((values)=>({...values,[item.id]:option.key}))}/>
                          <span>{option.key}.</span><MathText text={option.text}/>
                        </label>
                      ))}
                    </fieldset>
                  ) : <>
                    <label htmlFor={"response-" + item.id}>写出你的答案或关键步骤</label>
                    <Textarea id={"response-" + item.id} value={answers[item.id] ?? ""} maxLength={2400}
                      disabled={pending || view.busy || work.stage!=="diagnostic_ready"} onChange={(e)=>setAnswers((values)=>({...values,[item.id]:e.target.value}))}/>
                  </>}
                  <Button type="submit" className="w-fit" disabled={pending || view.busy || work.stage!=="diagnostic_ready" || !answers[item.id]?.trim()}>提交作答</Button>
                </>}
              </form>
            ))}
            {work.stage==="diagnostic_submitted" && work.diagnosis && (
              <Button className="w-fit" disabled={pending || view.busy} onClick={()=>void perform(()=>startTeaching(taskId,work.diagnosis!.diagnosis_id),true)}>生成针对性讲解</Button>
            )}
            {(canAdvance.has(work.stage) || work.formatRetryAvailable) && (
              <Button variant="outline" className="w-fit" disabled={pending || view.busy || (view.modelCalls>=view.modelLimit && !work.stage.startsWith("verify_") && !work.ruleExerciseRecoveryAvailable)}
                onClick={()=>void perform(()=>advanceLearning(taskId,work.question.id,work.stage,view.revision),true)}>
                {work.ruleExerciseRecoveryAvailable ? "使用规则题继续" : work.formatRetryAvailable ? "重新生成当前步骤（1 次）" : work.error ? "重试当前步骤" : "继续处理"}
              </Button>
            )}
            {work.mathRetryAvailable && (
              <Button variant="outline" className="w-fit" disabled={pending || view.busy}
                onClick={()=>void perform(()=>advanceLearning(taskId,work.question.id,work.stage,view.revision))}>
                重新进行数学验证
              </Button>
            )}
            {work.mathRegenAvailable && (
              <div className="grid gap-1">
                <Button variant="outline" className="w-fit" disabled={pending || view.busy || view.modelCalls>=view.modelLimit}
                  onClick={()=>void perform(()=>advanceLearning(taskId,work.question.id,work.stage,view.revision),true)}>
                  {work.templateRecoveryAvailable ? "用核验模板重做讲解" : "按失败原因重新生成（1 次）"}
                </Button>
                <p className="text-sm text-muted-foreground">
                  {work.templateRecoveryAvailable ? "根据已确认的题干重做讲解，重新送数学验证和独立审核。" : "数学验证未通过。重生成的内容须重新验证并审核。"}
                </p>
              </div>
            )}
            {work.teaching && (
              <section className="grid gap-3">
                <h2 className="font-semibold">针对性讲解</h2>
                {work.teaching.steps.map((s,index)=>(
                  <details key={index} className="rounded-md border p-3" open={index===0}>
                    <summary className="cursor-pointer font-medium">{index+1}. {s.title}</summary>
                    <div className="mt-3 grid gap-2 text-sm">
                      {s.original_step && <div className="rounded-md bg-muted p-3"><p className="text-muted-foreground">学生原步骤</p><MathText text={s.original_step} studentWork /></div>}
                      <MathText text={s.text} />
                    </div>
                  </details>
                ))}
              </section>
            )}
            {work.stage==="teaching_ready" && (
              <Button className="w-fit" disabled={pending || view.busy || view.modelCalls>=view.modelLimit}
                onClick={()=>void perform(()=>startRetake(taskId,work.question.id),true)}>开始变式复测</Button>
            )}
            {work.stage==="teaching_ready" && view.modelCalls>=view.modelLimit && (
              <p className="text-sm text-muted-foreground">本任务的模型额度已用完，复测题尚无法完成独立审核。</p>
            )}
            {work.retake && (
              <section className="grid gap-3">
                <h2 className="font-semibold">变式复测</h2>
                <form className="grid gap-3 rounded-md border p-4 text-sm" onSubmit={(event)=>{
                  event.preventDefault();
                  const item = work.retake;
                  if (item) void perform(()=>submitAttempt(taskId,item,answers[item.id] ?? ""));
                }}>
                  <MathText text={work.retake.stem} />
                  <fieldset className="grid gap-2" disabled={pending || view.busy || Boolean(work.retake.attempt) || work.stage!=="retake_ready"}>
                    <legend className="pb-2">请选择一项</legend>
                    {work.retake.options?.map((option)=>(
                      <label key={option.key} className="flex items-start gap-2 rounded-md border px-3 py-2">
                        <input type="radio" className="mt-1" name={"retake-" + work.retake!.id} value={option.key}
                          checked={(work.retake!.attempt?.response ?? answers[work.retake!.id]) === option.key}
                          onChange={()=>setAnswers((values)=>({...values,[work.retake!.id]:option.key}))} />
                        <span>{option.key}.</span><MathText text={option.text}/>
                      </label>
                    ))}
                  </fieldset>
                  {work.retake.attempt ? <>
                    <p role="status">{work.retake.attempt.note}</p>
                    {work.retake.attempt.answer && <details><summary className="cursor-pointer">参考解答</summary><MathText text={work.retake.attempt.answer}/></details>}
                  </> : <Button type="submit" className="w-fit" disabled={pending || view.busy || work.stage!=="retake_ready" || !answers[work.retake.id]}>提交复测</Button>}
                </form>
              </section>
            )}
            {work.stage==="needs_review" && work.error!=="schema_invalid" && !work.mathRetryAvailable && !work.mathRegenAvailable && <p className="text-sm text-muted-foreground">请联系有审核权限的辅导老师复核。处理前暂缓展示对应内容。</p>}
            {work.stage==="needs_review" && work.error==="schema_invalid" && !work.ruleExerciseRecoveryAvailable && (!work.formatRetryAvailable || view.modelCalls>=view.modelLimit) && (
              <p className="text-sm text-muted-foreground">本题已保存。当前无法再次生成，可以继续处理其他题目。</p>
            )}
            {work.checks.length>0 && (
              <details className="rounded-md border p-3 text-sm" open={work.stage==="needs_review"}>
                <summary className="cursor-pointer font-medium">审核与验证记录</summary>
                <ul className="mt-2 grid gap-3">
                  {work.checks.map((artifact,index)=>(
                    <li key={artifact.artifact_id}>
                      <p>内容 {index+1} · 版本 {artifact.artifact_version}{artifact.reviewed_by==="human" ? " · 人工审核通过" : ""}</p>
                      {artifact.math_code && errors[artifact.math_code] && <p className="text-muted-foreground">{errors[artifact.math_code]}</p>}
                      {artifact.checks.map((check,i)=>(
                        <p key={i} className="text-muted-foreground">v{check.artifact_version} · {checks[check.check_type]} · {verdict[check.status]}
                          {check.issues.length>0 ? " · " + check.issues.map((issue)=>problem[issue.type] ?? issue.type).join("、") : ""} · {clock(check.created_at)}
                        </p>
                      ))}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </CardContent>
        </Card>
      ))}
      {view?.report && <LearningReport report={view.report} stages={stages} topics={topics} />}
    </div>
  );
}

export default function LearningPage() {
  const {query} = useRouter();
  const {activeTaskId, sessionStatus} = useUploads();
  const taskId = query.get("task") || activeTaskId;
  return (
    <div className="mx-auto grid w-full max-w-4xl gap-5 px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">错因诊断与讲解</h1>
      {sessionStatus==="ready" && taskId
        ? <LearningTask key={taskId} taskId={taskId}/>
        : <p className="text-sm text-muted-foreground">{sessionStatus==="loading" ? "正在恢复任务…" : "请先在上传页选择任务。"} <Link to="/upload" className="underline">前往上传页</Link></p>}
    </div>
  );
}
