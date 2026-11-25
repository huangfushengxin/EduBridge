import assert from "node:assert/strict";
import { application } from "../functions/routes.mjs";
import { makeDb, makeStorage, BackendError, errorResponse, makeMockModel } from "./memory-adapter.mjs";
import { parseDiagnosis } from "../functions/pipeline.mjs";
import { modelBudget, parseBudgetOverrides } from "../functions/model-budget.mjs";
import { createMathVerifier } from "../functions/math-client.mjs";
import { minimumLesson } from "../functions/minimum-lesson.mjs";

const png = Uint8Array.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,0x00]);
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(32)),v=>v.toString(16).padStart(2,"0")).join("");
const owner = token();
const visitor = token();
let passed = 0;
const check = (label, ok) => {assert.ok(ok,label);passed++;};

const mathEndpoint = process.env.EB_TEST_MATH_URL;
const mathToken = process.env.EB_TEST_MATH_TOKEN;
if (mathEndpoint && (!mathToken || !/^http:\/\/127\.0\.0\.1:\d+$/.test(mathEndpoint))) {
  throw new Error("The real math regression requires a loopback service and a test token.");
}
const runMath = mathEndpoint
  ? createMathVerifier({ readEnv: (key) => key === "MATH_VERIFY_URL" ? mathEndpoint : mathToken })
  : async () => ({ status: "passed", code: "mock_math_check" });

function setup({ verifyMath = runMath, modifyModel = (m) => m, budgetOverrides = {} } = {}) {
  const db = makeDb();
  const storage = makeStorage();
  const model = modifyModel(makeMockModel());
  const handle = application({db,storage,BackendError,model,verifyMath,budgetOverrides,
    authorizeReviewer: async (request) => request.headers.get("x-eb-reviewer") === "synthetic-reviewer",
  });

  async function call(path, body, {session=owner, reviewer=false, raw=false, method=body === undefined ? "GET" : "POST"}={}) {
    const headers = {"x-eb-session":session};
    if (reviewer) headers["x-eb-reviewer"] = "synthetic-reviewer";
    if (body !== undefined) headers["content-type"] = raw ? "image/png" : "application/json";
    const request = new Request("http://local/functions/v1/app" + path,{method,headers,
      body:body===undefined ? undefined : raw ? body : JSON.stringify(body)});
    let response;
    try { response=await handle({request,requestId:crypto.randomUUID()}); }
    catch (error) {
      if (!(error instanceof BackendError)) throw error;
      response=errorResponse(error);
    }
    return {status:response.status,data:await response.json()};
  }

  return {db,call};
}

async function seed(call, taskId = crypto.randomUUID()) {
  const task=taskId;
  const base="/api/tasks/"+task;
  await call("/api/tasks",{id:task,kind:"manual"});
  for (const kind of ["paper","sheet"]) {
    assert.equal((await call(base+"/assets?kind="+kind+"&name=test.png",png,{raw:true})).status,201);
  }
  const requested = await call(base+"/recognize",{idempotencyKey:"learning-fixture"});
  const job = "/api/jobs/"+requested.data.job.id+"/run";
  let status;
  for (let i=0;i<4;i++) status=(await call(job,{})).data.job.status;
  assert.equal(status,"succeeded");
  const recognize = await call(base+"/recognition");
  const q = recognize.data.questions[0];
  assert.ok(q.stem && q.studentAnswer);
  return {task,base,q,selection:{questions:[{id:q.id,version:1}]},
    fields:{baseVersion:0,number:q.number,stem:q.stem,studentAnswer:q.studentAnswer,gradingResult:"wrong",gradingNote:"脱敏模拟"},
    revision:"/api/questions/"+q.id+"/revision",
    confirm:"/api/questions/"+q.id+"/confirm"};
}

async function step(call, fixture, view) {
  const w=view.work[0];
  const result=await call(fixture.base+"/learning/advance",
    {questionId:w.question.id,expectedStage:w.stage,expectedRevision:view.revision});
  assert.equal(result.status,200);
  return result.data;
}
async function until(call,fixture,view,stage) {
  for (let i=0;i<12;i++) {
    if (view.work[0]?.stage===stage) return view;
    view=await step(call,fixture,view);
  }
  throw new Error("Did not reach " + stage + " - " + JSON.stringify(view.work.map(w => ({stage:w.stage,error:w.error,checks:w.checks}))));
}
const flow=setup();
const f=await seed(flow.call);
let res=await flow.call(f.base+"/diagnose",f.selection);
check("未确认拦截",res.status===409 && res.data.error==="confirmation_required");
check("逐题确认版本", (await flow.call(f.confirm,f.fields)).data.confirmedVersion===1);
res=await flow.call(f.base+"/diagnose",f.selection);
const initial=res.data;
check("批次提交无模型费用",res.status===202 && initial.modelCalls===2 && initial.simulated);
check("重复批次同一版本", (await flow.call(f.base+"/diagnose",f.selection)).data.revision===initial.revision);
let view=await step(flow.call,f,initial);
check("确认版证据", view.work[0].diagnosis?.hypotheses[0].evidence[0].snippet &&
  f.fields.studentAnswer.includes(view.work[0].diagnosis.hypotheses[0].evidence[0].snippet));
const old=await step(flow.call,f,initial);
check("重复推进不重复付费",old.modelCalls===3 && old.revision===view.revision);
view=await step(flow.call,f,view);
check("待审题面与答案均不下发", view.work[0].items.length===0 && !JSON.stringify(view).includes("最小值为 4，x=2 时取得。"));
check("越权读取任务", (await flow.call(f.base+"/learning",undefined,{session:visitor})).status===404);
check("无审核凭据", (await flow.call(f.base+"/learning/manual-review")).status===403);
view=await until(flow.call,f,view,"diagnostic_ready");
const diagnosedAt=view.report.questions[0].diagnosedAt;
check("错因报告生成后即有诊断时间，无需复测", diagnosedAt===view.work[0].diagnosis.created_at &&
  !Number.isNaN(Date.parse(diagnosedAt)) && view.report.questions[0].completedAt===null);
check("通过当前版本独立审核和数学验证", view.work[0].checks[0].review_status==="pass" && view.work[0].checks[0].verification_status==="passed");
check("作答前只收题面", view.work[0].items.length===1 && !/answer_private|rubric_private|评分规则|同时说明下界/.test(JSON.stringify(view)));
const item=view.work[0].items[0];
const diagnosis=view.work[0].diagnosis.diagnosis_id;
const answerPath="/api/items/"+item.id+"/attempts";
const teachPath="/api/diagnoses/"+diagnosis+"/teach";
const privateItem = (fixture, index = 0) => fixture.db._raw.learning_sessions[0].state.works[0].items[index];
check("未提交诊断练习不进入讲解",(await flow.call(teachPath,{taskId:f.task})).data.error==="attempts_required");
check("跨会话无法作答",(await flow.call(answerPath,{taskId:f.task,response:"4",artifactVersion:1},{session:visitor})).status===404);
const attempt={taskId:f.task,response:privateItem(flow).correctOption,artifactVersion:1};
view=(await flow.call(answerPath,attempt)).data;
check("单选落库时完成评分，无额外模型调用", view.work[0].stage==="diagnostic_submitted" &&
  view.work[0].items[0].attempt.result==="right" && view.modelCalls===4);
check("重复作答幂等",(await flow.call(answerPath,attempt)).data.revision===view.revision);
check("变更已提交答案返回冲突",(await flow.call(answerPath,{...attempt,response:item.options.find(({key})=>key!==attempt.response).key})).data.error==="attempt_exists");
check("服务端批改及假设状态",view.work[0].items[0].attempt.result==="right" &&
  view.work[0].diagnosis.hypotheses[0].support_status==="needs_verification");
check("报告只汇总已审核练习的评分", view.report.questions[0].diagnosticResults.join(",")==="right" &&
  view.report.questions[0].status==="pending" && !JSON.stringify(view.report).includes(view.work[0].items[0].attempt.answer));
check("已评阅后答复可见且规则仍私有",view.work[0].items[0].attempt.answer===privateItem(flow).answer_private && !JSON.stringify(view).includes("rubric_private"));
view=(await flow.call(teachPath,{taskId:f.task})).data;
view=await step(flow.call,f,view);
check("讲解草稿拦截",view.work[0].teaching===null);
view=await until(flow.call,f,view,"teaching_ready");
check("讲解引用真实原步骤", f.fields.studentAnswer.includes(view.work[0].teaching.steps[0].original_step));
check("上传到讲解使用 5 次模型调用",view.modelCalls===5 && view.modelLimit===12 && flow.db._raw.model_runs.length===5);
check("刷新恢复及持久化", (await flow.call(f.base+"/learning")).data.work[0].teaching.id===view.work[0].teaching.id);
const retakePath=f.base+"/learning/retake";
const retakeInput={questionId:f.q.id};
check("越权无法生成复测", (await flow.call(retakePath,retakeInput,{session:visitor})).status===404);
view=(await flow.call(retakePath,retakeInput)).data;
check("未审核复测不可见且不增加模型调用", view.work[0].stage==="verify_retake" &&
  view.work[0].retake===null && view.modelCalls===5 && view.report.questions[0].status==="pending");
check("重复申请复测不占用新题", (await flow.call(retakePath,retakeInput)).data.revision===view.revision);
view=await until(flow.call,f,view,"retake_ready");
const retake=view.work[0].retake;
const privateRetake=flow.db._raw.learning_sessions[0].state.works[0].retake;
check("复测换题且只返回审核后的题面", retake.stem!==item.stem &&
  retake.options.length===3 && view.modelCalls===6 && !JSON.stringify(view).includes("correctOption") &&
  retake.attempt===null);
const retakeAttemptPath="/api/items/"+retake.id+"/attempts";
const retakeAttempt={taskId:f.task,response:privateRetake.correctOption,artifactVersion:retake.artifact_version};
check("复测拒绝非选项及过期版本", (await flow.call(retakeAttemptPath,{...retakeAttempt,response:"D"})).status===400 &&
  (await flow.call(retakeAttemptPath,{...retakeAttempt,artifactVersion:0})).status===409);
view=(await flow.call(retakeAttemptPath,retakeAttempt)).data;
check("复测保存并评分且按次汇报", view.work[0].stage==="retake_completed" && view.modelCalls===6 &&
  view.work[0].retake.attempt.result==="right" && view.work[0].retake.attempt.answer &&
  view.report.questions[0].status==="passed" && view.report.questions[0].completedAt && view.report.questions[0].diagnosedAt===diagnosedAt);
check("复测重复提交幂等", (await flow.call(retakeAttemptPath,retakeAttempt)).data.revision===view.revision);
check("人工修订置为过期", (await flow.call(f.revision,{...f.fields,baseVersion:1,stem:"已修订。"+f.fields.stem})).data.status==="stale");
const stale=(await flow.call(f.base+"/learning")).data;
check("旧诊断、练习和讲解撤回",stale.stale && stale.work.length===0);
check("旧作答入口被阻断",(await flow.call(answerPath,attempt)).data.error==="confirmation_changed");
await flow.call(f.confirm,{...f.fields,baseVersion:1,studentAnswer:"4"});
view=(await flow.call(f.base+"/diagnose",{questions:[{id:f.q.id,version:2}]})).data;
view=await step(flow.call,f,view);
check("只有最终答案时证据不足",view.work[0].stage==="insufficient_evidence" && view.work[0].diagnosis.hypotheses[0].category==="insufficient_evidence");
check("旧记录留档",flow.db._raw.learning_sessions[0].state.history[0].works[0].items[0].attempt.response===attempt.response);
check("历史报告保留当次复测状态且不泄露答案", view.report.history[0].questions[0].status==="passed" &&
  view.report.history[0].questions[0].version===1 && !JSON.stringify(view.report).includes(privateRetake.answer_private));
check("其他会话不能删除任务或学习会话",
  (await flow.call(f.base, undefined, { session: visitor, method: "DELETE" })).status === 404
  && flow.db._raw.learning_sessions.some((row) => row.task_id === f.task));
const removedTask = await flow.call(f.base, undefined, { method: "DELETE" });
check("删除任务同步清理学习会话", removedTask.status === 200 && removedTask.data.deleted
  && !flow.db._raw.learning_sessions.some((row) => row.task_id === f.task));
check("删除后的诊断记录不可访问", (await flow.call(f.base + "/learning")).status === 404);
const forged={knowledge_point:"functions",first_error_step_id:99,hypotheses:[{evidence:[{step_id:99,snippet:"编造"}]}]};
check("服务端拒绝不存在的步骤",parseDiagnosis(JSON.stringify(forged),{steps:[]})===null);

const bad=setup({verifyMath:async()=>({status:"failed",code:"equality_unreachable"})});
const bf=await seed(bad.call);
await bad.call(bf.confirm,bf.fields);
let rejected=(await bad.call(bf.base+"/diagnose",bf.selection)).data;
rejected=await until(bad.call,bf,rejected,"needs_review");
check("数学失败不再调用独立审核",rejected.work[0].items.length===0 &&
  rejected.work[0].checks[0].artifact_version===1 && rejected.work[0].checks[0].verification_status==="failed" &&
  rejected.work[0].checks[0].checks.every((c)=>c.check_type!=="model_review") && rejected.modelCalls===3);
check("数学失败开放一次重生成入口",rejected.work[0].mathRegenAvailable && !rejected.work[0].mathRetryAvailable);
rejected=await until(bad.call,bf,await step(bad.call,bf,rejected),"needs_review");
check("等号不可达阻断并只重生成一次",rejected.work[0].checks[0].artifact_version===2 &&
  rejected.work[0].checks[0].verification_status==="failed" && !rejected.work[0].mathRegenAvailable && rejected.modelCalls===3);
check("有权限的人工入口保留审核原稿",(await bad.call(bf.base+"/learning/manual-review",undefined,{reviewer:true})).data.work[0].items[0].answer_private.length>0);
check("人工不可批准已验证失败的内容",(await bad.call(bf.base+"/learning/manual-review",{
  artifactId:rejected.work[0].checks[0].artifact_id,artifactVersion:2,decision:"pass",note:"（模拟）复核",
},{reviewer:true})).data.error==="review_blocked");
const missing=setup({verifyMath:async()=>({status:"unsupported",code:"math_not_configured"})});
const mf=await seed(missing.call);
await missing.call(mf.confirm,mf.fields);
let pending=(await missing.call(mf.base+"/diagnose",mf.selection)).data;
pending=await until(missing.call,mf,pending,"needs_review");
check("SymPy 未支持必须转人工",pending.work[0].items.length===0 && pending.work[0].checks[0].verification_status==="unsupported");
const reviewed=await missing.call(mf.base+"/learning/manual-review",{
  artifactId:pending.work[0].checks[0].artifact_id,artifactVersion:1,decision:"pass",note:"（模拟）人工核对了适用条件与答案",
},{reviewer:true});
check("通过独立模型审核后的人工验证不冒充 SymPy",reviewed.data.work[0].items.length===1 &&
  reviewed.data.work[0].checks[0].reviewed_by==="human" && reviewed.data.work[0].checks[0].verification_status==="unsupported");

let verifierRestored = false;
const recovering = setup({verifyMath:async () => verifierRestored
  ? {status:"passed",code:"mock_math_check"}
  : {status:"unsupported",code:"math_service_unavailable"}});
const rf = await seed(recovering.call);
await recovering.call(rf.confirm,rf.fields);
let recoveringView = (await recovering.call(rf.base+"/diagnose",rf.selection)).data;
recoveringView = await until(recovering.call,rf,recoveringView,"needs_review");
const waiting = recoveringView.work[0];
const usedBeforeRetry = recoveringView.modelCalls;
check("既有模型审核通过后可独立重试数学验证",waiting.mathRetryAvailable &&
  waiting.checks[0].review_status==="pass" && waiting.items.length===0);
recoveringView = await step(recovering.call,rf,recoveringView);
check("服务仍不可用时暂缓展示并可再次验证",recoveringView.work[0].stage==="needs_review" &&
  recoveringView.work[0].mathRetryAvailable && recoveringView.modelCalls===usedBeforeRetry);
verifierRestored = true;
recoveringView = await step(recovering.call,rf,recoveringView);
const restored = recoveringView.work[0];
check("服务恢复后沿用已审核的原诊断题和调用记录",restored.stage==="diagnostic_ready" &&
  restored.items[0].id===waiting.checks[0].artifact_id && restored.items[0].artifact_version===waiting.checks[0].artifact_version &&
  restored.checks[0].checks.filter(check=>check.check_type==="model_review").length===1 && recoveringView.modelCalls===usedBeforeRetry);
check("恢复保留数学验证的历史",restored.checks[0].checks.filter(check=>check.check_type==="math_verify")
  .map(check=>check.status).join(",")==="unsupported,unsupported,passed");
check("数学真失败的旧诊断题不会开放重试",!rejected.work[0].mathRetryAvailable);

const same=setup({modifyModel:m=>({...m,modelIds:()=>({diagnosis:"qwen-text",tutor:"qwen-teach",review:"qwen-review"})})});
const sf=await seed(same.call);
await same.call(sf.confirm,sf.fields);
let refused=(await same.call(sf.base+"/diagnose",sf.selection)).data;
refused=await until(same.call,sf,refused,"review_items");
refused=await step(same.call,sf,refused);
check("同家族审核拒绝并保留未审草稿",refused.work[0].error==="independent_model_required" && refused.work[0].items.length===0 && refused.modelCalls===3);


const multi=setup({modifyModel:base=>({...base,async generate(role,prompt){
  const original=await base.generate(role,prompt);
  const data=JSON.parse(original.content);
  if (data.hypotheses?.[0]?.evidence.length) {
    const h=data.hypotheses[0];
    data.hypotheses.push({...h,category:"reasoning_gap",statement:"（模拟）可能没有验证候选取等点能否代回题设。"});
  }
  return {...original,content:JSON.stringify(data)};
}})});
const two=await seed(multi.call);
await multi.call(two.confirm,two.fields);
let both=(await multi.call(two.base+"/diagnose",two.selection)).data;
both=await until(multi.call,two,both,"diagnostic_ready");
check("多个错因时只选一道诊断题",both.work[0].diagnosis.hypotheses.length===2 && both.work[0].items.length===1);
const multiWork=multi.db._raw.learning_sessions[0].state.works[0];
// 模拟已经发布的旧版两道自由作答题，继续从原有入口提交。
const legacyItem={...multiWork.items[0],generatedBy:"qwen-mock",options:undefined,correctOption:undefined,
  stem:"（模拟）当 $1\\le x\\le3$ 时，求 $x+4/x$ 的最小值。",answer_private:"4",rubric_private:"最小值为 4。"};
multiWork.items=[legacyItem,{...legacyItem,id:crypto.randomUUID(),target_hypothesis_id:"h2",
  stem:"（模拟）当 $2\\le x\\le4$ 时，求 $x+9/x$ 的最小值。",answer_private:"6",rubric_private:"最小值为 6。"}];
both=(await multi.call(two.base+"/learning")).data;
const twoItems=both.work[0].items;
const writeOne=(item,response)=>multi.call("/api/items/"+item.id+"/attempts",{taskId:two.task,response,artifactVersion:item.artifact_version});
both=(await writeOne(twoItems[0],"4")).data;
check("只交第一题时仍隐藏第二题答案",both.work[0].stage==="diagnostic_ready" && both.work[0].items.every((item)=>!item.attempt?.answer));
both=(await writeOne(twoItems[1],"6")).data;
both=await until(multi.call,two,both,"diagnostic_submitted");
check("旧版两题仍在同一步评阅",both.work[0].items.every((item)=>item.attempt.result==="right") && both.modelCalls===5);

const modelRejection=setup({modifyModel:base=>({...base,async generate(role,prompt){
  const original=await base.generate(role,prompt);
  if (role!=="review") return original;
  const data=JSON.parse(original.content);
  for (const review of data.reviews) review.issues=[{type:"domain_omission",severity:"major",field_or_step:"定义域",
    evidence:"（模拟）候选题漏写了分母限制",suggestion:"补充 x≠0"}];
  return {...original,content:JSON.stringify(data)};
}})});
const dm=await seed(modelRejection.call);
await modelRejection.call(dm.confirm,dm.fields);
let blocked=(await modelRejection.call(dm.base+"/diagnose",dm.selection)).data;
blocked=await until(modelRejection.call,dm,blocked,"needs_review");
check("独立审核遗漏定义域阻止出题和教学",blocked.work[0].items.length===0 && blocked.work[0].teaching===null &&
  blocked.work[0].checks[0].checks.filter((c)=>c.check_type==="model_review").every((r)=>r.status==="revise"));


const uncertain=setup({modifyModel:base=>({...base,async generate(role,prompt){
  const source=await base.generate(role,prompt);
  const data=JSON.parse(source.content);
  if (data.hypotheses) data.grading_review_reason="（模拟）请核对批改步骤和标记。";
  return {...source,content:JSON.stringify(data)};
}})});
const uf=await seed(uncertain.call);
await uncertain.call(uf.confirm,uf.fields);
const flagged=await step(uncertain.call,uf,(await uncertain.call(uf.base+"/diagnose",uf.selection)).data);
check("批改有疑问只显示人工核对提示",flagged.work[0].stage==="teacher_review" &&
  flagged.work[0].teacher_review_reason && !flagged.work[0].diagnosis && !flagged.work[0].items.length);

let reviewRequest;
const slow=setup({modifyModel:base=>({...base,async generate(role,prompt,maxTokens) {
  if (role !== "review") return base.generate(role,prompt);
  const payload = JSON.parse(prompt.split("\n").find((line)=>line.startsWith("输入资料：")).slice("输入资料：".length));
  reviewRequest = {payload,prompt,maxTokens};
  return {ok:false,errorCode:"model_timeout"};
}
})});
const slowFixture=await seed(slow.call);
await slow.call(slowFixture.confirm,slowFixture.fields);
let timed=(await slow.call(slowFixture.base+"/diagnose",slowFixture.selection)).data;
timed=await until(slow.call,slowFixture,timed,"review_items");
timed=await step(slow.call,slowFixture,timed);
check("审核超时留档并拦截学生内容",timed.work[0].error==="model_timeout" &&
  timed.work[0].items.length===0 && timed.work[0].checks[0].checks.some((check)=>check.check_type==="model_review" && check.status==="timeout"));
const sentArtifact=reviewRequest.payload.artifacts[0];
check("审核只发送当前题目、必要证据与数学验证，限制输出量",reviewRequest.maxTokens===1000 &&
  reviewRequest.prompt.includes("只需独立求解候选题") && sentArtifact.verification_status==="passed" &&
  sentArtifact.math_claims.length>0 && sentArtifact.options.length===3 && sentArtifact.answer_private &&
  !Object.hasOwn(sentArtifact,"history") && !Object.hasOwn(reviewRequest.payload.question,"studentAnswer") &&
  reviewRequest.payload.question.steps.some((s)=>s.step_id===reviewRequest.payload.diagnosis.hypotheses[0].evidence[0].step_id));

// 超时恢复：数学已通过时审核超时占一个槽位并留档，重试成功且保留已判作答
let reviewCalls=0;
const timeoutRecover=setup({modifyModel:base=>({...base,generate:(role,prompt)=>{
  if (role==="review" && ++reviewCalls===2) return Promise.resolve({ok:false,errorCode:"model_timeout",latencyMs:48000});
  return base.generate(role,prompt);
}})});
const trf=await seed(timeoutRecover.call);
await timeoutRecover.call(trf.confirm,trf.fields);
let trView=(await timeoutRecover.call(trf.base+"/diagnose",trf.selection)).data;
trView=await until(timeoutRecover.call,trf,trView,"diagnostic_ready");
const trItem=trView.work[0].items[0];
trView=(await timeoutRecover.call("/api/items/"+trItem.id+"/attempts",{taskId:trf.task,response:privateItem(timeoutRecover).correctOption,artifactVersion:1})).data;
trView=await until(timeoutRecover.call,trf,trView,"diagnostic_submitted");
trView=(await timeoutRecover.call("/api/diagnoses/"+trView.work[0].diagnosis.diagnosis_id+"/teach",{taskId:trf.task})).data;
trView=await until(timeoutRecover.call,trf,trView,"review_teaching");
const trBefore=trView.modelCalls;
trView=await step(timeoutRecover.call,trf,trView);
check("讲解审核超时留档且拦截讲解",trView.work[0].stage==="review_teaching" && trView.work[0].error==="model_timeout" &&
  trView.work[0].teaching===null && trView.modelCalls===trBefore+1 &&
  trView.work[0].checks[1].checks.some((c)=>c.check_type==="model_review"&&c.status==="timeout"));
check("超时不清空已判正确的练习作答",trView.work[0].items[0].attempt.result==="right");
trView=await step(timeoutRecover.call,trf,trView);
check("超时重试成功后讲解可见",trView.work[0].stage==="teaching_ready" && trView.work[0].teaching?.artifact_version===1 &&
  trView.modelCalls===trBefore+2);

// 旧版卡死状态复现：数学 failed + 审核两次超时停在 review_teaching，恢复只处理失败阶段
const legacy=setup();
const lf=await seed(legacy.call);
await legacy.call(lf.confirm,lf.fields);
let lView=(await legacy.call(lf.base+"/diagnose",lf.selection)).data;
lView=await until(legacy.call,lf,lView,"diagnostic_ready");
const lItem=lView.work[0].items[0];
lView=(await legacy.call("/api/items/"+lItem.id+"/attempts",{taskId:lf.task,response:privateItem(legacy).correctOption,artifactVersion:1})).data;
lView=await until(legacy.call,lf,lView,"diagnostic_submitted");
const lDiagnosis=lView.work[0].diagnosis.diagnosis_id;
lView=(await legacy.call("/api/diagnoses/"+lDiagnosis+"/teach",{taskId:lf.task})).data;
lView=await until(legacy.call,lf,lView,"teaching_ready");
const lState=legacy.db._raw.learning_sessions[0].state.works[0];
lState.teaching.verification_status="failed";
lState.teaching.mathCode="claim_does_not_hold";
lState.teaching.review_status=null;
lState.teaching.reviewedBy=null;
lState.teaching.history.push(
  {artifact_version:1,check_type:"math_verify",status:"failed",created_at:new Date().toISOString()},
  {artifact_version:1,check_type:"model_review",status:"timeout",created_at:new Date().toISOString()},
  {artifact_version:1,check_type:"model_review",status:"timeout",created_at:new Date().toISOString()});
lState.stage="review_teaching";
lState.error="model_timeout";
lView=(await legacy.call(lf.base+"/learning")).data;
const lBefore=lView.modelCalls;
check("旧卡死状态讲解仍被门槛拦截",lView.work[0].stage==="review_teaching" && lView.work[0].teaching===null);
lView=await step(legacy.call,lf,lView);
check("卡死状态无模型调用转待复核",lView.work[0].stage==="needs_review" && lView.work[0].error===null &&
  lView.modelCalls===lBefore && lView.work[0].mathRegenAvailable);
lView=await until(legacy.call,lf,await step(legacy.call,lf,lView),"teaching_ready");
check("重生成只补失败阶段并保留作答与错因",lView.work[0].teaching?.artifact_version===2 &&
  lView.work[0].items[0].attempt.result==="right" && lView.work[0].diagnosis.diagnosis_id===lDiagnosis &&
  lView.modelCalls===lBefore+1 && !lView.work[0].mathRegenAvailable);
check("失败与超时历史留档",lView.work[0].checks[1].checks.filter((c)=>c.check_type==="math_verify"&&c.status==="failed").length===1 &&
  lView.work[0].checks[1].checks.filter((c)=>c.check_type==="model_review"&&c.status==="timeout").length===2);
lView=(await legacy.call(lf.base+"/learning/retake",{questionId:lf.q.id})).data;
lView=await until(legacy.call,lf,lView,"retake_ready");
const lPrivate=legacy.db._raw.learning_sessions[0].state.works[0].retake;
lView=(await legacy.call("/api/items/"+lView.work[0].retake.id+"/attempts",
  {taskId:lf.task,response:lPrivate.correctOption,artifactVersion:lView.work[0].retake.artifact_version})).data;
check("恢复后复测可提交且报告记录本次结论",lView.work[0].stage==="retake_completed" &&
  lView.work[0].retake.attempt.result==="right" && lView.report.questions[0].status==="passed");

let completions=0;
const malformed=setup({modifyModel:base=>({...base,async generate(role,prompt){
  if (prompt.includes("证据驱动的错因诊断") && ++completions===1) return {ok:true,content:"invalid",actualModelId:"qwen-mock"};
  return base.generate(role,prompt);
}})});
const invalid=await seed(malformed.call);
await malformed.call(invalid.confirm,invalid.fields);
let correcting=(await malformed.call(invalid.base+"/diagnose",invalid.selection)).data;
correcting=await step(malformed.call,invalid,correcting);
check("异常 JSON 允许一次结构修复",correcting.work[0].repairPending && correcting.work[0].diagnosis===null);
correcting=await step(malformed.call,invalid,correcting);
check("结构修复成功后才生成诊断题",correcting.work[0].stage==="generate_items" && !correcting.work[0].repairPending && correcting.modelCalls===4);


const sourceQuestion = {
  id:"diagnosis-fixture", stem:"已知 f(x) 的定义域。",
  steps:[{step_id:0,content:"将 x=0 代入分母。"}],
};
const sourceDiagnosis = {
  knowledge_point:"functions",first_error_step_id:"0",hypotheses:[{
    category:"domain_omission",statement:"可能遗漏定义域",applicability:"分母不能为零",
    rule_ids:["FUN-01"],evidence:[{step_id:"0",snippet:"x=0"}],
  }],
};
const recoveredIndex=parseDiagnosis(JSON.stringify(sourceDiagnosis),sourceQuestion);
check("数字字符串步骤安全归一化", recoveredIndex?.first_error_step_id===0 &&
  recoveredIndex.hypotheses[0].evidence[0].step_id===0);
let rejectionReason;
const changedEvidence=structuredClone(sourceDiagnosis);
changedEvidence.hypotheses[0].evidence[0].snippet="x=1";
check("拒绝伪造原文并指出失败字段",parseDiagnosis(JSON.stringify(changedEvidence),sourceQuestion,
  (issue)=>{rejectionReason=issue;})===null && rejectionReason==="diagnosis_evidence");
const changedRule=structuredClone(sourceDiagnosis);
changedRule.hypotheses[0].rule_ids=["INE-02"];
check("拒绝跨知识点规则",parseDiagnosis(JSON.stringify(changedRule),sourceQuestion,
  (issue)=>{rejectionReason=issue;})===null && rejectionReason==="diagnosis_rules");
check("明确超出支持范围的题目不伪造诊断",parseDiagnosis('{"unsupported_topic":true}',sourceQuestion)?.diagnosis_status==="unsupported_topic");

let formatAttempts=0;
const blockedFormat=setup({modifyModel:base=>({...base,async generate(role,prompt){
  if (prompt.includes("证据驱动的错因诊断") && ++formatAttempts<=2) return {ok:true,content:"invalid",actualModelId:"qwen-mock"};
  return base.generate(role,prompt);
}})});
const formatFixture=await seed(blockedFormat.call);
await blockedFormat.call(formatFixture.confirm,formatFixture.fields);
let formatView=(await blockedFormat.call(formatFixture.base+"/diagnose",formatFixture.selection)).data;
formatView=await step(blockedFormat.call,formatFixture,formatView);
check("首次格式失败返回具体诊断原因", formatView.work[0].formatIssue==="diagnosis_json" && formatView.work[0].repairPending);
formatView=await step(blockedFormat.call,formatFixture,formatView);
check("二次失败保留正确确认版本并允许手动恢复", formatView.work[0].stage==="needs_review" &&
  formatView.work[0].formatRetryAvailable && formatView.work[0].question.version===1 && formatView.modelCalls===4);
const legacyWork=blockedFormat.db._raw.learning_sessions[0].state.works[0];
delete legacyWork.formatIssue;
formatView=await step(blockedFormat.call,formatFixture,formatView);
check("旧格式失败数据无需重传即可重新生成", formatView.work[0].stage==="generate_items" &&
  formatView.work[0].diagnosis && !formatView.work[0].formatRetryAvailable && formatView.modelCalls===5);
const repeatedFormat=setup({modifyModel:base=>({...base,async generate(){
  return {ok:true,content:"invalid",actualModelId:"qwen-mock"};
}})});
const repeatFixture=await seed(repeatedFormat.call);
await repeatedFormat.call(repeatFixture.confirm,repeatFixture.fields);
let repeatView=(await repeatedFormat.call(repeatFixture.base+"/diagnose",repeatFixture.selection)).data;
repeatView=await until(repeatedFormat.call,repeatFixture,repeatView,"needs_review");
repeatView=await step(repeatedFormat.call,repeatFixture,repeatView);
check("手动恢复再次失败后不重复调用",repeatView.work[0].stage==="needs_review" &&
  !repeatView.work[0].formatRetryAvailable && (await step(repeatedFormat.call,repeatFixture,repeatView)).modelCalls===5);

const db=makeDb();
const budget=modelBudget(db,result=>result.data);
const ids=await Promise.all(Array.from({length:18},()=>budget.reserve("one-task","owner","job","vision","test")));
check("18 路并发最多 12 次槽位",ids.filter(Boolean).length===12 && new Set(ids.filter(Boolean)).size===12);

// 单任务联调预算：默认 12，仅覆盖任务提额；识别预检、reserve、学习视图共用同一上限。
const targetTask="749b4f83-f2fd-4c77-ad61-3dd543a5a9dc";
const overrides=parseBudgetOverrides(JSON.stringify({[targetTask]:24,"not-a-task":7}));
check("仅接受合法任务覆盖",Object.keys(overrides).length===1 && overrides[targetTask]===24);
check("非法或越界配置回退默认",Object.keys(parseBudgetOverrides("not-json")).length===0 &&
  !parseBudgetOverrides(JSON.stringify({[targetTask]:101}))[targetTask] &&
  !parseBudgetOverrides(JSON.stringify({[targetTask]:0}))[targetTask]);
const quotaDb=makeDb();
const quota=modelBudget(quotaDb,(r)=>r.data,{overrides});
for(let i=0;i<12;i++) assert.ok(await quota.reserve(targetTask,"owner","job","vision","test"));
check("默认 12 槽先用满", (await quota.count(targetTask,"owner"))===12 && quota.limit(targetTask)===24);
const extra=await quota.reserve(targetTask,"owner","job","vision","test");
check("已满任务调额后可继续", Boolean(extra) && (await quota.count(targetTask,"owner"))===13);
const otherTask="6a0e1f6c-1111-4222-8333-444455556666";
for(let i=0;i<12;i++) await quota.reserve(otherTask,"owner","job","vision","test");
check("其他任务仍 12 并拒绝继续", quota.limit(otherTask)===12 && (await quota.count(otherTask,"owner"))===12 &&
  (await quota.reserve(otherTask,"owner","job","vision","test"))===null);
const boosted=setup({budgetOverrides:overrides});
const boostedFixture=await seed(boosted.call,targetTask);
const boostedOwner=boosted.db._raw.model_runs[0]?.owner_token_hash ?? owner;
for(let i=boosted.db._raw.model_runs.length;i<12;i++) boosted.db._raw.model_runs.push({
  id:crypto.randomUUID(),task_id:boostedFixture.task,owner_token_hash:boostedOwner,role:"vision",status:"succeeded",created_at:new Date().toISOString()});
const boostedView=(await boosted.call(boostedFixture.base+"/learning")).data;
check("学习视图显示 12/24", boostedView.modelCalls===12 && boostedView.modelLimit===24);
check("覆盖任务识别预检满 12 仍可排队", (await boosted.call(boostedFixture.base+"/recognize",{idempotencyKey:"boosted-retry"})).status===202);
const capped=setup();
const cappedFixture=await seed(capped.call);
const cappedOwner=capped.db._raw.model_runs[0]?.owner_token_hash ?? owner;
for(let i=capped.db._raw.model_runs.length;i<12;i++) capped.db._raw.model_runs.push({
  id:crypto.randomUUID(),task_id:cappedFixture.task,owner_token_hash:cappedOwner,role:"diagnosis",status:"succeeded",created_at:new Date().toISOString()});
const cappedView=(await capped.call(cappedFixture.base+"/learning")).data;
check("未覆盖任务满额视图为 12/12", cappedView.modelCalls===12 && cappedView.modelLimit===12);
check("未覆盖任务识别预检拒绝", (await capped.call(cappedFixture.base+"/recognize",{idempotencyKey:"capped-retry"})).status===429);

// 数学真实失败：仅一次按原因重生成，新版本重新验证与审核，禁止绕过
const regen=setup();
const regenFixture=await seed(regen.call);
await regen.call(regenFixture.confirm,regenFixture.fields);
let regenView=(await regen.call(regenFixture.base+"/diagnose",regenFixture.selection)).data;
regenView=await until(regen.call,regenFixture,regenView,"diagnostic_ready");
const regenBefore=regenView.modelCalls;
const regenState=regen.db._raw.learning_sessions[0].state.works[0];
regenState.items[0].verification_status="failed";
regenState.items[0].mathCode="equality_unreachable";
regenState.items[0].history.push({artifact_version:1,check_type:"math_verify",status:"failed",created_at:new Date().toISOString()});
regenState.stage="needs_review";
regenView=(await regen.call(regenFixture.base+"/learning")).data;
check("数学失败隐藏内容并给出一次重生成", regenView.work[0].mathRegenAvailable===true &&
  regenView.work[0].mathRetryAvailable===false && regenView.work[0].items.length===0);
regenView=(await regen.call(regenFixture.base+"/learning/advance",
  {questionId:regenFixture.q.id,expectedStage:"needs_review",expectedRevision:regenView.revision})).data;
regenView=await until(regen.call,regenFixture,regenView,"diagnostic_ready");
check("按原因重生成后重新通过数学与审核", regenView.work[0].stage==="diagnostic_ready" &&
  regenView.work[0].items[0]?.artifact_version===2 && regenView.work[0].items[0]?.verification_status==="passed" &&
  regenView.work[0].items[0]?.review_status==="pass" && regenView.modelCalls===regenBefore+1);
check("重生成只提供一次且保留失败历史", regenView.work[0].mathRegenAvailable===false &&
  regen.db._raw.learning_sessions[0].state.works[0].items[0].history.some((h)=>h.check_type==="math_verify"&&h.status==="failed"));

// 截图的场景：多变量原题已生成错因，但旧版自由出题连同重试都未通过结构校验。
let draftingCalls=0;
const recovery=setup({modifyModel:base=>({...base,async generate(role,prompt) {
  if (prompt.includes("编写高一短诊断题") || role==="tutor") {
    draftingCalls++;
    return {ok:true,content:"{invalid",actualModelId:"qwen-mock"};
  }
  return base.generate(role,prompt);
}})});
const recoverFixture=await seed(recovery.call);
const originalStep="由基本不等式推得 xy ≤ 4 或 xy ≥ 16。";
await recovery.call(recoverFixture.confirm,{...recoverFixture.fields,number:"16(1)",
  stem:"若正数 x、y 满足 x+y=xy-8，求 xy 的取值范围。",studentAnswer:originalStep+"综上 0 ≤ xy ≤ 4 或 xy ≥ 16。"});
let recovered=(await recovery.call(recoverFixture.base+"/diagnose",recoverFixture.selection)).data;
recovered=await until(recovery.call,recoverFixture,recovered,"generate_items");
const recoverDiagnosis=recovered.work[0].diagnosis.diagnosis_id;
const recoverWork=recovery.db._raw.learning_sessions[0].state.works[0];
Object.assign(recoverWork,{stage:"needs_review",error:"schema_invalid",fixStage:"generate_items",formatRecoveryUsed:true});
recovered=(await recovery.call(recoverFixture.base+"/learning")).data;
check("旧任务格式重试已用完仍可换规则题",recovered.work[0].ruleExerciseRecoveryAvailable===true &&
  recovered.work[0].formatRetryAvailable===true && recovered.work[0].items.length===0);
recovered=await step(recovery.call,recoverFixture,recovered);
check("保留错因和确认版，零模型调用生成规则题草稿",recovered.work[0].stage==="verify_items" &&
  !recovered.work[0].error && !recovered.work[0].ruleExerciseRecoveryAvailable && recovered.modelCalls===3 &&
  recovered.work[0].diagnosis.diagnosis_id===recoverDiagnosis && recovered.work[0].question.version===1 && !recovered.work[0].items.length);
recovered=await until(recovery.call,recoverFixture,recovered,"diagnostic_ready");
const recoveredItem=recovered.work[0].items[0];
check("恢复后的诊断题须通过数学与审核且先隐藏答案",recoveredItem.verification_status==="passed" &&
  recoveredItem.review_status==="pass" && recoveredItem.attempt===null && !JSON.stringify(recovered).includes("correctOption"));
recovered=(await recovery.call("/api/items/"+recoveredItem.id+"/attempts",{
  taskId:recoverFixture.task,response:privateItem(recovery).correctOption,artifactVersion:recoveredItem.artifact_version,
})).data;
recovered=(await recovery.call("/api/diagnoses/"+recoverDiagnosis+"/teach",{taskId:recoverFixture.task})).data;
recovered=await until(recovery.call,recoverFixture,recovered,"teaching_ready");
check("复杂原题用同类题讲解并引用原作答",recovered.work[0].teaching.steps[0].original_step.includes(originalStep) &&
  recovered.work[0].teaching.steps[1].title==="同类题讲解" && recovered.work[0].teaching.steps[1].text.includes(recoveredItem.stem));
recovered=(await recovery.call(recoverFixture.base+"/learning/retake",{questionId:recoverFixture.q.id})).data;
recovered=await until(recovery.call,recoverFixture,recovered,"retake_ready");
const recoveredRetake=recovered.work[0].retake;
check("变式复测呈现且关闭自由出题和自由讲解调用",recoveredRetake.stem!==recoveredItem.stem &&
  !recoveredRetake.attempt && recovered.modelCalls===6 && draftingCalls===0);
recovered=(await recovery.call("/api/items/"+recoveredRetake.id+"/attempts",{taskId:recoverFixture.task,
  response:recovery.db._raw.learning_sessions[0].state.works[0].retake.correctOption,artifactVersion:recoveredRetake.artifact_version})).data;
check("旧任务恢复后可以提交复测并查看本次报告",recovered.work[0].stage==="retake_completed" && recovered.report.questions[0].status==="passed");

// 既有 v2 断言的正规化：补全题目域、解包单区间、数值恒等式按等价处理（无模型）
let normalizedBody;
const normalizer=createMathVerifier({readEnv:(name)=>name==="MATH_VERIFY_URL"?"https://math.example.com":"synthetic token",
  fetchImpl:async (url,init)=>{normalizedBody=JSON.parse(init.body);return Response.json({status:"passed",code:"symbolic_check_passed"});}});
const v2Claims=[
  {kind:"inequality",left:{op:"add",args:["x",{op:"div",args:[4,"x"]}]},
    right:{op:"add",args:[3,{op:"div",args:[4,3]}]},
    expected:[{lower:3,upper:null,exclude:[],lower_closed:true,upper_closed:false}],relation:"ge"},
  {kind:"equation",left:{op:"add",args:[3,{op:"div",args:[4,3]}]},right:"13/3",expected:["13/3"],relation:"eq"}];
const v2Result=await normalizer(v2Claims,{conditions:["定义域为 $[3, +\\infty)$"]});
check("缺失域按题目条件补全并解包区间", v2Result.status==="passed" &&
  normalizedBody.claims[0].domain?.lower==="3" && normalizedBody.claims[0].domain?.upper_closed===false &&
  !Array.isArray(normalizedBody.claims[0].expected) && normalizedBody.claims[0].expected?.lower===3);
check("数值恒等式按等价处理", normalizedBody.claims[1].kind==="equivalent" &&
  normalizedBody.claims[1].domain?.lower===null && !("expected" in normalizedBody.claims[1]));

// invalid_claim 的既有断言可无模型重验，通过后恢复发布态
const replay=setup();
const replayFixture=await seed(replay.call);
await replay.call(replayFixture.confirm,replayFixture.fields);
let replayView=(await replay.call(replayFixture.base+"/diagnose",replayFixture.selection)).data;
replayView=await until(replay.call,replayFixture,replayView,"diagnostic_ready");
const replayBefore=replayView.modelCalls;
const replayState=replay.db._raw.learning_sessions[0].state.works[0];
replayState.items[0].verification_status="unsupported";
replayState.items[0].mathCode="invalid_claim";
replayState.items[0].history.push({artifact_version:1,check_type:"math_verify",status:"unsupported",created_at:new Date().toISOString()});
replayState.stage="needs_review";
replayState.mathRegenUsed=true;
replayView=(await replay.call(replayFixture.base+"/learning")).data;
check("既有断言可无模型重验", replayView.work[0].mathRetryAvailable===true && replayView.work[0].mathRegenAvailable===false);
replayView=(await replay.call(replayFixture.base+"/learning/advance",
  {questionId:replayFixture.q.id,expectedStage:"needs_review",expectedRevision:replayView.revision})).data;
check("重验通过恢复发布态且不增加模型调用", replayView.work[0].stage==="diagnostic_ready" &&
  replayView.modelCalls===replayBefore && replayView.work[0].items[0]?.verification_status==="passed");

// 按阶段重生成：旧任务练习已用一次，讲解仍可单独重生成；作答/判分/历史保留
const perStage=setup();
const psFixture=await seed(perStage.call);
await perStage.call(psFixture.confirm,psFixture.fields);
let psView=(await perStage.call(psFixture.base+"/diagnose",psFixture.selection)).data;
psView=await until(perStage.call,psFixture,psView,"diagnostic_ready");
const psItem=psView.work[0].items[0];
psView=(await perStage.call("/api/items/"+psItem.id+"/attempts",{taskId:psFixture.task,response:privateItem(perStage).correctOption,artifactVersion:1})).data;
psView=await until(perStage.call,psFixture,psView,"diagnostic_submitted");
psView=(await perStage.call("/api/diagnoses/"+psView.work[0].diagnosis.diagnosis_id+"/teach",{taskId:psFixture.task})).data;
psView=await until(perStage.call,psFixture,psView,"teaching_ready");
const psBefore=psView.modelCalls;
const psState=perStage.db._raw.learning_sessions[0].state.works[0];
psState.mathRegenUsed=true;
psState.teaching.verification_status="failed";
psState.teaching.mathCode="equality_unreachable";
psState.teaching.review_status=null;
psState.teaching.math_coverage=null;
psState.teaching.history.push({artifact_version:1,check_type:"math_verify",status:"failed",created_at:new Date().toISOString()});
psState.stage="review_teaching";
psState.error="model_timeout";
psView=(await perStage.call(psFixture.base+"/learning")).data;
check("旧超时状态保留且未额外调用", psView.work[0].stage==="review_teaching" && psView.modelCalls===psBefore);
psView=(await perStage.call(psFixture.base+"/learning/advance",
  {questionId:psFixture.q.id,expectedStage:"review_teaching",expectedRevision:psView.revision})).data;
check("旧讲解数学失败且无覆盖字段仍可零调用恢复", psView.work[0].stage==="needs_review" &&
  psView.modelCalls===psBefore && psView.work[0].mathRegenAvailable===true);
psView=(await perStage.call(psFixture.base+"/learning/advance",
  {questionId:psFixture.q.id,expectedStage:"needs_review",expectedRevision:psView.revision})).data;
psView=await until(perStage.call,psFixture,psView,"teaching_ready");
check("讲解单独重生成通过数学与审核", psView.modelCalls===psBefore+1 &&
  perStage.db._raw.learning_sessions[0].state.works[0].teaching.artifact_version===2 &&
  psView.work[0].mathRegenAvailable===false);
check("重生成保留作答判分与历史", perStage.db._raw.learning_sessions[0].state.works[0].items[0].attempt?.result==="right" &&
  perStage.db._raw.learning_sessions[0].state.works[0].teaching.history.some((h)=>h.check_type==="math_verify"&&h.status==="failed"));

const guided = setup();
const gf = await seed(guided.call);
await guided.call(gf.confirm,{...gf.fields,stem:"7. 已知函数 f(x)=x+4/x，x≥3. (1) 求函数的最小值，并说明理由。"});
let gv=(await guided.call(gf.base+"/diagnose",gf.selection)).data;
gv=await until(guided.call,gf,gv,"diagnostic_ready");
const gItem=gv.work[0].items[0];
check("题干支持时仅出一道核验单选诊断题", gv.work[0].items.length===1 && gItem.options?.length===3 && gv.modelCalls===4);
check("模板诊断题不返回正确选项和解答", !Object.hasOwn(gItem,"correctOption") && !gItem.attempt);
const gWork=()=>guided.db._raw.learning_sessions[0].state.works[0];
const lesson=minimumLesson(gWork());
check("受限定义域送检边界最小值及唯一取值点", lesson.teaching.math_claims[0].right==="13/3" &&
  lesson.teaching.math_claims[1].expected[0]===3);
check("有额外条件时不套用最小值模板", minimumLesson({...gWork(),question:{...gWork().question,stem:gWork().question.stem+"另有 x<4。"}})===null);
check("无约束的正数域检查基本不等式取等点", minimumLesson({...gWork(),question:{...gWork().question,
  stem:"已知 x>0，求 f(x)=x+9/x 的最小值。请写出最小值和取到最小值时的 x。"}}).teaching.math_claims[0].equality_x===3);
check("识别常见的 LaTeX 转录分式和比较符", minimumLesson({...gWork(),question:{...gWork().question,
  stem:"已知函数 \\(f(x)=x+\\dfrac{4}{x}\\)，且 \\(x\\geqslant 3\\)。求函数的最小值。"}}).teaching.math_claims[1].expected[0]===3);
gv=(await guided.call("/api/items/"+gItem.id+"/attempts",{taskId:gf.task,response:gWork().items[0].correctOption,artifactVersion:1})).data;
check("结构化诊断练习本地规则判分且不推断长期掌握", gv.work[0].stage==="diagnostic_submitted" &&
  gv.work[0].items[0].attempt.result==="right" && gv.modelCalls===4);
gv=(await guided.call("/api/diagnoses/"+gv.work[0].diagnosis.diagnosis_id+"/teach",{taskId:gf.task})).data;
gv=await until(guided.call,gf,gv,"teaching_ready");
check("讲解不占生成调用，数学及独立审核通过后展示", gv.modelCalls===5 &&
  gv.work[0].teaching.steps[0].original_step===gWork().question.steps[0].content);
const gLegacy=gWork();
gLegacy.stage="needs_review";
gLegacy.mathRegenUsed={items:true,teaching:true,retake:false};
Object.assign(gLegacy.teaching,{generatedBy:"qwen-mock",verification_status:"failed",review_status:null,mathCode:"claim_does_not_hold"});
gv=(await guided.call(gf.base+"/learning")).data;
check("已耗尽旧重生成次数的讲解可一次迁移至核验模板", gv.work[0].templateRecoveryAvailable && !gv.work[0].teaching);
gv=await until(guided.call,gf,await step(guided.call,gf,gv),"teaching_ready");
check("旧讲解迁移后版本递增并保留作答", gv.work[0].teaching.artifact_version===2 &&
  gv.work[0].items[0].attempt.result==="right" && gv.modelCalls===6 && !gv.work[0].templateRecoveryAvailable);
gv=(await guided.call(gf.base+"/learning/retake",{questionId:gf.q.id})).data;
gv=await until(guided.call,gf,gv,"retake_ready");
check("诊断练习与复测是不同变式", gv.work[0].retake.stem!==gItem.stem && gv.modelCalls===7);
const gRetake=gv.work[0].retake;
gv=(await guided.call("/api/items/"+gRetake.id+"/attempts",{taskId:gf.task,response:gWork().retake.correctOption,artifactVersion:1})).data;
check("收敛流程生成本次复测报告", gv.report.questions[0].status==="passed" && gv.work[0].stage==="retake_completed");

const env = (name) => name === "MATH_VERIFY_URL" ? "https://math.example.com" : "synthetic token";
const adapter = createMathVerifier({readEnv:env,fetchImpl:async (url,init)=>{
  assert.equal(url.pathname,"/verify");
  assert.equal(init.headers.authorization,"Bearer synthetic token");
  assert.equal(init.redirect,"error");
  return Response.json({status:"failed",code:"domain_contains_undefined_point"});
}});
check("服务间认证及结构化验证", (await adapter([{kind:"equivalent"}])).status==="failed");
check("数学服务未配置", (await createMathVerifier({readEnv:()=>null})([{kind:"equivalent"}])).code==="math_not_configured");
for(const [httpStatus,status,code] of [
  [408,"timeout","math_timeout"],[504,"timeout","math_timeout"],
  [429,"timeout","math_capacity"],[503,"unsupported","math_service_unavailable"],
]){
  const unavailable=createMathVerifier({readEnv:env,fetchImpl:async()=>new Response(null,{status:httpStatus})});
  const result=await unavailable([{kind:"equivalent"}]);
  check("数学 HTTP 错误 "+httpStatus+" 保持未完成状态",result.status===status&&result.code===code);
}
const invalidMath=createMathVerifier({readEnv:env,fetchImpl:async()=>Response.json({status:"ok"})});
check("无效的数学核验响应不得通过",(await invalidMath([{kind:"equivalent"}])).code==="math_response_invalid");
console.log(passed+" passed; simulated inputs and model calls; "+(mathEndpoint ? "real local SymPy HTTP" : "simulated math")+"; 0 paid requests");
