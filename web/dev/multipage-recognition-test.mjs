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
console.log(assertions+" passed; synthetic materials, no external model calls");
