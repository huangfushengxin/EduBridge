// Run with node --experimental-strip-types web/dev/workspace-progress-test.mjs.
import assert from "node:assert/strict";
import { petGrowth, readProfile, rememberStudy, saveProfile, studyResults, summarizeStudy, taskDiagnosisStatus } from "../lib/study-progress.ts";

const now = Date.parse("2026-11-22T01:00:00Z");
const questions = [
  {id:"first",version:1,topic:"sets",stage:"retake_completed",status:"passed",diagnosedAt:"2026-11-21T16:00:00Z",completedAt:"2026-11-21T16:40:00Z"},
  {id:"second",version:1,topic:"functions",stage:"retake_completed",status:"practice_needed",diagnosedAt:"2026-11-21T15:59:59Z",completedAt:"2026-11-21T16:45:00Z"},
  {id:"pending",version:1,topic:"basic_inequalities",stage:"diagnostic_ready",status:"pending",diagnosedAt:"2026-11-21T17:00:00Z",completedAt:null},
];
const simulated = {...questions[0],id:"fake"};
const eligibleQuestions = questions.map(({id,version})=>({id,version}));
const results = studyResults("task",{simulated:false,eligibleQuestions,report:{questions,history:[
  {questions:[questions[0]],simulated:false},
  {questions:[simulated],simulated:true},
]}});
assert.equal(results.diagnoses.length,3);
assert.equal(results.retakes.length,2);
const summary = summarizeStudy([results,results],now);
assert.equal(summary.count,2);
assert.equal(summary.right,1);
assert.equal(summary.retakeCount,2);
assert.equal(summary.diagnosedTasks,1);
assert.deepEqual(summary.topics,[["集合",1],["基本不等式",1]]);
assert.deepEqual(summary.days.map(({count})=>count),[0,0,0,0,0,1,2]);

const storage = new Map();
Object.defineProperty(globalThis,"localStorage",{value:{getItem:(key)=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)}});
const report = {questions:[],history:[]};
const view = {stale:false,busy:false,simulated:false,eligibleQuestions,report};
const diagnosed = {...questions[0],stage:"diagnostic_ready",status:"pending",completedAt:null};
const reportWithDiagnosis = {...report,questions:[diagnosed]};
assert.equal(taskDiagnosisStatus({...view,report:null}),"未诊断");
assert.equal(taskDiagnosisStatus({...view,busy:true}),"诊断中");
assert.equal(taskDiagnosisStatus({...view,report:reportWithDiagnosis}),"已诊断");
assert.equal(taskDiagnosisStatus({...view,report:reportWithDiagnosis,stale:true}),"待重新诊断");
assert.equal(taskDiagnosisStatus({...view,report:{...report,questions:[{...diagnosed,stage:"insufficient_evidence"}]}}),"未诊断");
assert.equal(taskDiagnosisStatus({...view,report:{...report,history:[{questions:[diagnosed]}]}}),"已诊断");
assert.equal(taskDiagnosisStatus({...view,eligibleQuestions:[{id:"first",version:2}],report:{...report,history:[{questions:[diagnosed]}]}}),"待重新诊断");

const threeDiagnosedTasks = ["demo-one","exam","demo-two"].map((id) =>
  studyResults(id,{...view,report:reportWithDiagnosis}));
const emptyTask = studyResults("empty",view);
const mockTask = studyResults("mock",{...view,simulated:true,report:reportWithDiagnosis});
const threePlusOtherTasks = [...threeDiagnosedTasks,emptyTask,mockTask];
const threeSummary = summarizeStudy(threePlusOtherTasks,now);
assert.equal(threeSummary.count,3);
assert.equal(threeSummary.diagnosedTasks,3);
assert.equal(threeSummary.retakeCount,0);
assert.equal(threeSummary.days.at(-1).count,3);
assert.deepEqual(petGrowth(rememberStudy(threePlusOtherTasks)),{age:0,life:0,stage:0});
assert.ok(saveProfile({nickname:"小宁",pet:"cat",credited:[]}));
assert.deepEqual(petGrowth(rememberStudy(threePlusOtherTasks)),{age:0,life:30,stage:0});
assert.deepEqual(petGrowth(rememberStudy([...threePlusOtherTasks,...threePlusOtherTasks])),{age:0,life:30,stage:0});
assert.equal(readProfile().nickname,"小宁");

const oldProgress = {nickname:"原昵称",pet:"rabbit",adoptedAt:now,credited:["exam/q/1/1","exam/r/1/2","demo-two"]};
storage.set("eduBridge.workspaceProfile.v1",JSON.stringify(oldProgress));
assert.deepEqual(readProfile(),{nickname:"原昵称",pet:"rabbit",credited:["exam","demo-two"]});
assert.equal(petGrowth(rememberStudy(threePlusOtherTasks)).life,30);
const olderReport = studyResults("old",{...view,report:{...reportWithDiagnosis,startedAt:diagnosed.diagnosedAt,
  questions:[{...diagnosed,diagnosedAt:null}]}});
assert.equal(summarizeStudy([olderReport],now).count,1);
const historicalReport = studyResults("archived",{...view,report:{...report,history:[
  {questions:[{...diagnosed,diagnosedAt:null}],retiredAt:diagnosed.diagnosedAt,simulated:false},
]}});
assert.equal(summarizeStudy([historicalReport],now).count,1);
const staleResult = studyResults("stale",{...view,stale:true,report:reportWithDiagnosis});
assert.equal(staleResult.diagnoses.length,0);

const milestones = Array.from({length:18},(_,index)=>({...threeDiagnosedTasks[0],taskId:`new-${index}`}));
assert.deepEqual(petGrowth(rememberStudy(milestones.slice(0,6))),{age:0,life:90,stage:0});
assert.deepEqual(petGrowth(rememberStudy(milestones.slice(0,7))),{age:1,life:0,stage:1});
assert.deepEqual(petGrowth(rememberStudy(milestones)),{age:2,life:10,stage:2});
console.log("32 passed; diagnosis and retake totals, historical task rewards and profile migration.");
