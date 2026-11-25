// 自制模拟材料，覆盖两张原卷、一张答题卡和第二页故障。
import assert from "node:assert/strict";
import { application } from "../functions/routes.mjs";
import { makeDb, makeStorage, BackendError } from "./memory-adapter.mjs";
import { applyMaterialResult, decodeMaterial, planForMaterial, promptForMaterial } from "../functions/recognition-page.mjs";
import { mergeQuestionRows, questionKey, teacherResult } from "../functions/question-merge.mjs";

const page1 = Array.from({ length: 10 }, (_, index) => index + 1);
const page2 = Array.from({ length: 10 }, (_, index) => index + 11);
const token = "e".repeat(64);
const owner = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))).toString("hex");
let assertions = 0;
const same = (actual, wanted, label) => { assert.deepEqual(actual, wanted, label); assertions++; };
const truth = (value, label) => { assert.ok(value, label); assertions++; };

async function scenario(fault) {
  const db = makeDb();
  const storage = makeStorage();
  const task = crypto.randomUUID();
  await db.from("tasks").insert({ id:task, kind:"manual", owner_token_hash:owner });
  const assets = [ ["paper", 0], ["paper", 1], ["sheet", 0] ];
  for (const [i, [kind, index]] of assets.entries()) {
    const name = "fixture-" + i;
    await storage.upload(name, new Uint8Array([i]));
    await db.from("assets").insert({ id:crypto.randomUUID(),task_id:task,owner_token_hash:owner,kind,page_index:index,
      object_path:name,mime:"image/png",size_bytes:1 });
  }
  let recovered = false;
  const calls = [];
  const model = {
    isConfigured: () => ({ configured:true, missing:[] }),
    recognize: async ({images,prompt}) => {
      const i = Buffer.from(images[0].base64,"base64")[0];
      const numbers = [page1,page2,[...page1,...page2]][i];
      const inventory = prompt.includes("只建立本图片的题号目录");
      const sub = /本次仅转录这些已从图片目录读取的题号：(\[[^\n]*?\])/.exec(prompt);
      const mode = inventory ? "inventory" : sub ? "group" : "page";
      calls.push([i,mode]);
      if (fault && i===1 && !recovered) return mode==="page" ? { ok:false,errorCode:"model_timeout" } : { ok:true,content:"破损的 JSON" };
      if (inventory) return {ok:true,content:JSON.stringify({page_status:"read",numbers})};
      const requested = sub ? JSON.parse(sub[1]) : numbers;
      const questions = requested.map(n=>i===2 ? {
        question_number:"第 "+String(n).padStart(2,"0")+" 题",
        answer:n===20 ? null : n===11 ? "C" : "D",
        answer_status:n===20 ? "blank" : undefined,
        teacher_marks:n===11 ? [{kind:"check",content:"√",scope:"question"}]
          : n===12 ? [{kind:"cross",content:"×",scope:"question"}]
            : n===13 ? [{kind:"check",content:"√",scope:"partial"}] : [],
      } : {number:n,stem:"（模拟）第"+n+"题，计算 "+n+"+1。"});
      const content = JSON.stringify({page_status:"read",numbers,questions});
      return {ok:true,content:i===2 ? "识别输出\n"+String.fromCharCode(96).repeat(3)+"json\n"+content+"\n"+String.fromCharCode(96).repeat(3) : content};
    },
  };
  const handle = application({db, storage, BackendError, model});
  const base = "/api/tasks/"+task;
  async function request(path, json) {
    const response = await handle({
      request: new Request("http://fixture/functions/v1/app"+path,{
        method:json===undefined?"GET":"POST",
        headers:{"x-eb-session":token,...(json===undefined ? {} : {"content-type":"application/json"})},
        ...(json===undefined ? {} : {body:JSON.stringify(json)}),
      }),
      requestId:crypto.randomUUID(),
    });
    return response.json();
  }
  const started = await request(base+"/recognize",{idempotencyKey:"begin"});
  const id = started.job.id;
  async function drain(job) {
    let current = job;
    for (let i=0; i<20 && current.status==="queued"; i++) current=(await request("/api/jobs/"+id+"/run",{})).job;
    return current;
  }
  const job = await drain(started.job);
  let page = await request(base+"/recognition");
  if (!fault) {
    same(job.status,"succeeded","three independent healthy pages");
    same(calls,[[0,"page"],[1,"page"],[2,"page"]],"20+20 records require one model request per page");
  } else {
    same(job.status,"failed","failed page remains marked");
    same(job.materials.map(p=>p.status),["done","failed","done"],"second paper did not block the answer card");
    const incomplete = page.questions.find(q=>q.number.includes("11"));
    same(incomplete.studentAnswer,"C","answers from independently processed card are preserved");
    same(incomplete.sourceAssetId,null,"unmatched answer is not silently paired");
    same(calls,[[0,"page"],[1,"page"],[2,"page"],[1,"inventory"]],"later material runs before page fallback");
    const used = calls.length;
    recovered = true;
    const retry = await request(base+"/recognize",{idempotencyKey:"retry"});
    same(retry.job.id,id,"retry keeps job and drafts");
    const after = await drain(retry.job);
    same(after.status,"succeeded","isolated second paper restored");
    truth(calls.slice(used).every(([index])=>index===1),"completed first and answer pages did not run again");
    page = await request(base+"/recognition");
  }
  same(page.questions.length,20,"both original pages and answers merged");
  const find = (label) => page.questions.find((q) => questionKey(q.number) === label);
  same(find("11").sourcePageIndex,1,"second original page source retained");
  same(find("11").answerPageIndex,0,"answer card source retained");
  same(find("11").studentAnswer,"C","printed question number paired to selected answer");
  same(find("11").teacherResult,"right","whole-question teacher check only");
  same(find("12").teacherResult,"wrong","whole-question teacher cross only");
  same(find("13").teacherResult,"unclear","partial teacher marks are not a whole-question verdict");
  same(find("20").fieldStatus.answer,"blank","blank answer is distinct from unreadable or missing");
}
await scenario(false);
await scenario(true);

const material = {kind:"sheet",pageIndex:0,questionNumbers:["16(1)","16(2)"]};
const plan = planForMaterial(material);
const writtenSteps = [String.raw`x+y \geqslant 2\sqrt{xy}`, String.raw`\(xy \leqslant 4\) 或 xy≥16`, "0≤xy【字迹不清】4"];
const mixedAnswer = decodeMaterial(JSON.stringify({page_status:"read", numbers:["16(1)"], questions:[
  {number:"16(1)", answer_status:"unreadable", student_steps:writtenSteps.map((content)=>({content}))},
]}), material, {mode:"page"}).diagnosis.questions[0];
same(mixedAnswer.student_steps.map(({content})=>content),writtenSteps,"recognition preserves the original operators, delimiters and line order");
same(mixedAnswer.answer_status,"uncertain","visible partial transcription does not override unreadable status");
for (const mode of ["page", "transcribe"]) {
  const prompt = promptForMaterial(material,{mode,requested:["16(1)"]});
  truth(prompt.includes("不得补推导、化简") && prompt.includes("【字迹不清】") && prompt.includes(String.raw`\\(a\\leqslant b\\)`),
    "sheet " + mode + " prompts preserve signs and mark uncertain characters");
}
const parsed = decodeMaterial(JSON.stringify({answers:[
  {number:"第16题（一）", answer:4},
  {number:"(2)", answer:6},
]}),material,plan);
same(parsed.recognizedKeys,["16(1)"],"only an exact parent and sub-question match is accepted");
same(parsed.error,"model_incomplete","unmatched sub-question stays outstanding");
same(planForMaterial(applyMaterialResult(material,plan,parsed)).requested,["16(2)"],"successful records saved even when the same chunk lacks a row");
same(teacherResult([{kind:"score",status:"recognized",scope:"question",content:"5"}]),"unclear","scores alone do not determine correctness");
same(teacherResult([{kind:"cross",status:"recognized",scope:"unknown"}]),"unclear","ambiguous teacher grading requires review");
const sources=[{assetId:"a",kind:"paper",pageIndex:0},{assetId:"b",kind:"paper",pageIndex:1},{assetId:"c",kind:"sheet",pageIndex:0}];
const row=(id,source,fields)=>({id,number:"1",source_asset_id:source,field_status:{number:"recognized"},...fields});
const ambiguous=mergeQuestionRows([
  row("p1","a",{stem:"（模拟）题干一"}),row("p2","b",{stem:"（模拟）题干二"}),
  row("s1","c",{student_answer:"D",teacher_marks:[{kind:"cross",status:"recognized",scope:"question"}]}),
],sources);
same(ambiguous.length,3,"different questions with the same printed number are kept");
truth(ambiguous.every(q=>q.field_status.linkage==="uncertain"&&q.teacher_result==="unclear"),"duplicate numbering is never automatically paired or graded");
const paper = (id, number, stem, source = "b", extra = {}) => row(id, source, {
  number, stem, field_status:{number:"recognized",stem:"recognized"}, ...extra,
});
const answer = (id, number, student_answer, extra = {}) => row(id, "c", {
  number, student_answer, field_status:{number:"recognized",answer:"recognized"}, ...extra,
});
const parentStem = "已知函数 f(x)=x+4/x，x≥3。\n（1）求函数的最小值，并说明理由。\n【2】计算 f(4)。";
const cross = {kind:"cross",status:"recognized",scope:"question"};
const main = paper("p7", "第7题", parentStem, "b", {teacher_marks:[cross]});
const sub1 = answer("s71", "７［０１］", "x=2 时取等，最小值为 4", {teacher_marks:[cross]});
const sub2 = answer("s72", "7〔二〕", "f(4)=5");
const paired = mergeQuestionRows([main, sub1, sub2, answer("s8","8(1)","other")], sources);
const match = (rows, id) => rows.find((entry) => entry.id === id);
same(questionKey("第７题【一】［B］(02)"),"7(1)(b)(2)","bracket variants and nested labels normalize");
same(questionKey("(2)"),"","a bare sub-question never implies a main question");
same(match(paired,"s71").stem,"已知函数 f(x)=x+4/x，x≥3。 求函数的最小值，并说明理由。","shared conditions plus correct first sub-question");
same(match(paired,"s72").stem,"已知函数 f(x)=x+4/x，x≥3。 计算 f(4)。","second sub-question gets its own stem");
same(match(paired,"s72").student_answer,"f(4)=5","no sibling answer contamination");
same(match(paired,"s72").teacher_result,"unclear","parent grading is never copied to sub-questions");
same(match(paired,"s71").teacher_result,"wrong","sub-question grading stays with its answer");
same(match(paired,"s71").source_page_index,1,"original and sheet page attribution is preserved");
same(match(paired,"s8").stem,null,"unrelated question cannot inherit a stem");
same(match(paired,"p7").student_answer,null,"parent never collects child answer text");
const exact = mergeQuestionRows([main, paper("exact","7(1)","精确原文"), sub1],sources);
same(match(exact,"exact").stem,"精确原文","exact paper key takes priority");
const conflict = mergeQuestionRows([main, paper("duplicate","7","另一份试卷。\n(1) A。\n(2) B。","a"), sub1],sources);
same(match(conflict,"s71").field_status.linkage,"uncertain","conflicting parents require confirmation");
same(match(conflict,"s71").stem,null,"conflicting parents do not supply text");
const unmarked = mergeQuestionRows([paper("unmarked","7","请计算 f(1) 与 f(2)。"),sub1],sources);
same(match(unmarked,"s71").stem,null,"inline mathematical expressions do not split the stem");
same(match(unmarked,"s71").source_asset_id,"b","manual matching can open the parent paper");
const nested = paper("nested","7","总条件：\n(1) 第一组：\n【a】计算甲。\n【b】计算乙。\n(2) 第二组。");
const nestedAnswer = answer("nested-answer","7（1）[b]","乙的作答");
same(match(mergeQuestionRows([nested,nestedAnswer],sources),"nested-answer").stem,
  "总条件： 第一组： 计算乙。","isolates a nested section and preserves both levels of conditions");
const explicit = paper("explicit","7","总条件：\n(1)(1) 计算甲。\n(1)(2) 计算乙。\n(2) 计算丙。");
same(match(mergeQuestionRows([explicit,answer("nested-number","7[1]【二】","乙")],sources),"nested-number").stem,
  "总条件： 计算乙。","supports explicit multi-level numeric markers");
const choices = paper("choices","7","选择正确答案。\n(A) 甲\n(B) 乙");
same(match(mergeQuestionRows([choices,answer("looks-like-option","7(a)","甲")],sources),"looks-like-option").stem,
  null,"multiple-choice labels are not treated as child questions");
const revised = {...sub1, human:{number:"7(1)",stem:"人工确认的题干",gradingResult:"wrong"}, status:"confirmed", confirmed_version:2};
same(match(mergeQuestionRows([main,revised],sources),"s71").human.stem,"人工确认的题干","existing confirmation stays anchored to the sheet row");
console.log(assertions+" passed; synthetic materials, no external model calls");
