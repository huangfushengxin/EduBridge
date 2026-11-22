import assert from 'node:assert/strict';
import {application} from '../functions/routes.mjs';
import {createModelProvider} from '../functions/model.mjs';
import {mergeQuestionRows,teacherResult,questionKey} from '../functions/question-merge.mjs';
import {makeDb,makeStorage,BackendError} from './memory-adapter.mjs';
export async function runRepairTests(){
 let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;};
 const db=makeDb(),storage=makeStorage(),token='a'.repeat(64),owner=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex'),taskId=crypto.randomUUID();
 await db.from('tasks').insert({id:taskId,kind:'manual',owner_token_hash:owner});
 const pages=[{kind:'paper',page:0,numbers:['1','2','3','4','5','6']},{kind:'paper',page:1,numbers:['7','16(1)','16(2)']},{kind:'paper',page:2,numbers:['17']},{kind:'sheet',page:0,numbers:['1','2','7']},{kind:'sheet',page:1,numbers:['16(1)','16(2)','17']}];
 for(let i=0;i<pages.length;i++){const p=pages[i];p.id=crypto.randomUUID();await db.from('assets').insert({id:p.id,task_id:taskId,owner_token_hash:owner,kind:p.kind,page_index:p.page,object_path:'page-'+i,mime:'image/png',size_bytes:1});await storage.upload('page-'+i,new TextEncoder().encode(String(i)),{contentType:'image/png'});}
 const calls=[];let failSheet=true;
 const model={isConfigured:()=>({configured:true,missing:[]}),recognize:async({images,prompt})=>{
  const i=Number(Buffer.from(images[0].base64,'base64').toString()),p=pages[i];calls.push(i);
  if(i===3&&failSheet)return {ok:false,errorCode:'model_timeout',latencyMs:34000};
  if(prompt.includes('只建立本图片的题号目录'))return {ok:true,content:JSON.stringify({page_status:'read',numbers:p.numbers,unreadable_regions:[]}),actualModelId:'mock'};
  const chunk=prompt.match(/本次仅转录这些已从图片目录读取的题号：(\[[^\n]+?\])/);
  const nums=chunk?JSON.parse(chunk[1]):p.numbers;
  return {ok:true,actualModelId:'mock',content:JSON.stringify({schema_version:1,page_status:'read',numbers:p.numbers,source:{asset_kind:p.kind==='paper'?'original':'answer_sheet',page_index:0},questions:nums.map(n=>({number:n,number_status:'recognized',stem:p.kind==='paper'?'题'+n+' $\\frac{1}{2}$':null,stem_status:p.kind==='paper'?'recognized':'missing',student_steps:p.kind==='sheet'?[{step_index:0,content:n==='1'?'D':'答案'+n,status:'recognized',scope:'question'}]:[],teacher_marks:p.kind==='sheet'?(n==='7'?[{kind:'cross',content:'×',status:'recognized',scope:'question'},{kind:'check',content:'√',status:'recognized',scope:'question'}]:[{kind:n==='2'?'check':'cross',content:n==='2'?'√':'×',status:'recognized',scope:'question'}]):[],uncertain_fields:[],overall_status:'recognized',source_image_index:0,answer_image_index:p.kind==='sheet'?0:null})),unreadable_regions:[]})};
 }};
 const handle=application({db,storage,BackendError,model});
 async function call(method,path,json,auth=token){try{const res=await handle({request:new Request('http://local/functions/v1/app'+path,{method,headers:{'x-eb-session':auth,...(json?{'content-type':'application/json'}:{})},body:json?JSON.stringify(json):undefined}),requestId:crypto.randomUUID()});return {status:res.status,data:await res.json()};}catch(e){return {status:e.status??500,data:{error:e.code??e.message}};}}
 const begin=await call('POST','/api/tasks/'+taskId+'/recognize',{idempotencyKey:'one'});check(begin.status===202,'queued, no model call');check(calls.length===0,'read/start never consumes model');const jid=begin.data.job.id;
 check(db._raw.jobs[0].source_assets.length===5,'more than four assets are retained');
 let state;for(let i=0;i<30;i++){state=await call('POST','/api/jobs/'+jid+'/run');check(state.status===200,'run route succeeds');if(state.data.job.status!=='queued')break;}
 check(state.data.job.errorCode==='model_timeout','failure recorded');
 const partial=await call('GET','/api/tasks/'+taskId+'/recognition');check(partial.data.questions.length===10,'all paper questions survive sheet timeout, deduplicated');
 const q1=partial.data.questions.find(q=>q.number==='1');
 const revision=await call('POST','/api/questions/'+q1.id+'/revision',{baseVersion:0,number:'1（人工修订）',stem:q1.stem,studentAnswer:'手工保留',gradingResult:'unclear',gradingNote:'人工备注'});check(revision.status===200,'revision saved');
 const callsBefore=calls.filter(i=>i<3).length;
 failSheet=false;
 const resume=await call('POST','/api/tasks/'+taskId+'/recognize',{idempotencyKey:'two'});check(resume.data.job.id===jid,'retry resumes same job');
 for(let i=0;i<30;i++){state=await call('POST','/api/jobs/'+jid+'/run');check(state.status===200,'resume route succeeds');if(state.data.job.status!=='queued')break;}
 check(state.data.job.status==='succeeded','all pages finish');check(calls.filter(i=>i<3).length===callsBefore,'retry does not recall completed paper pages');
 const final=await call('GET','/api/tasks/'+taskId+'/recognition'),qs=final.data.questions;
 check(qs.length===10&&new Set(qs.map(q=>q.number)).size===10,'one result per question, no history duplication');
 check(qs.find(q=>q.number==='7').sourceAssetId===pages[1].id,'page 2 source correct');check(qs.find(q=>q.number==='17').sourceAssetId===pages[2].id,'fifth asset not silently omitted');
 check(qs.find(q=>q.number==='2').studentAnswer==='答案2','answer matched by printed question number');
 check(qs.find(q=>q.number==='2').teacherResult==='right','red check transcribed');check(qs.find(q=>q.number==='7').teacherResult==='unclear','contradictory marks require confirmation');
 const edited = qs.find((q) => q.id === q1.id);
 check(edited?.human.studentAnswer === '手工保留' && edited.number === '1（人工修订）', 'retry preserves the manual answer and edited number');
 check(edited?.answerAssetId === pages[3].id, 'edited number still links to the original answer');
 const confirmed = await call('POST', '/api/questions/' + q1.id + '/confirm', { baseVersion: 0, ...edited.human, stem: null });
 check(confirmed.data.confirmedVersion === 1 && confirmed.data.human.stem === null &&
   confirmed.data.answerAssetId === pages[3].id, 'confirmation retains intentionally cleared fields and the answer link');
 check(qs.find(q=>q.number==='16(1)').studentAnswer==='答案16(1)'&&qs.find(q=>q.number==='16(2)').studentAnswer==='答案16(2)','subquestion identities remain separate');
 await db.from('questions').insert({...db._raw.questions[0],id:crypto.randomUUID(),job_id:crypto.randomUUID()});
 check((await call('GET','/api/tasks/'+taskId+'/recognition')).data.questions.length===10,'older job rows hidden, not deleted');
 check((await call('GET','/api/tasks/'+taskId+'/recognition',undefined,'b'.repeat(64))).status===404,'cross-session isolation');
 const count=calls.length;await call('POST','/api/jobs/'+jid+'/run');check(calls.length===count,'successful run idempotent');
 const legacyTask = crypto.randomUUID();
 const legacyJob = crypto.randomUUID();
 await db.from('tasks').insert({ id: legacyTask, kind: 'manual', owner_token_hash: owner });
 const legacyMaterials = db._raw.assets.filter((asset) => asset.task_id === taskId)
   .map((asset) => ({ ...asset, id: crypto.randomUUID(), task_id: legacyTask, object_path: 'legacy-' + asset.object_path }));
 for (const item of legacyMaterials) {
   await db.from('assets').insert(item);
   await storage.upload(item.object_path, new Uint8Array([1]), { contentType: item.mime });
 }
 await db.from('jobs').insert({
   id: legacyJob, task_id: legacyTask, status: 'failed', owner_token_hash: owner,
   source_assets: legacyMaterials.slice(0, 4).map((page, index) => ({
     assetId: page.id, kind: page.kind, pageIndex: page.page_index, status: index < 3 ? 'done' : undefined,
   })),
 });
 const legacyResume = await call('POST', '/api/tasks/' + legacyTask + '/recognize', { idempotencyKey: 'legacy-retry' });
 const legacyAssets = db._raw.jobs.find((job) => job.id === legacyJob).source_assets;
 check(legacyResume.status === 200 && legacyResume.data.job.id === legacyJob, 'legacy partial recognition resumes under its original job');
 check(legacyAssets.length === 5 && legacyAssets[2].status === 'done' && legacyAssets[3].status === 'pending' &&
   legacyAssets[4].assetId === legacyMaterials[4].id && calls.length === count, 'resume preserves completed pages and appends omitted material without a model call');
 for(let slot=db._raw.model_runs.length;slot<12;slot++)await db.from('model_runs').insert({ task_id:taskId,owner_token_hash:owner,job_id:jid });
 const overBudget = await call('POST', '/api/tasks/' + taskId + '/recognize', { idempotencyKey: 'over-budget' });
 check(overBudget.status === 429 && calls.length === count, 'the 13th call is blocked');
 const currentJob = db._raw.jobs.find((job) => job.id === jid);
 const replacement = { ...currentJob, id: crypto.randomUUID(), status: 'queued', created_at: '2099-01-01T00:00:00Z' };
 await db.from('jobs').insert(replacement);
 const afterReplacement = await call('GET', '/api/tasks/' + taskId + '/recognition');
 check(afterReplacement.data.questions.length === 0 &&
   afterReplacement.data.previousEdits.some((edit) => edit.id === q1.id && edit.fields.studentAnswer === '手工保留'),
   'a newer job keeps older manual edits available without mixing old recognition results');
 check((await call('DELETE', '/api/tasks/' + taskId)).status === 200 &&
   storage._objects.size === legacyMaterials.length && legacyMaterials.every((asset) => storage._objects.has(asset.object_path)),
   'explicit task deletion cleans all repair batch raw objects along with uploaded assets');
 check(questionKey('第 ０１ 题')==='1','fullwidth question number normalization');
 check(questionKey('16.（1）') === questionKey('16(1)') && questionKey('16（2）') !== questionKey('16(1)'),
   'normalize a subquestion separator without joining different subquestions');
 check(teacherResult([{kind:'score',content:'3',status:'recognized',scope:'question'}])==='unclear','score alone is not correctness');
 const env=k=>({MODEL_BASE_URL:'https://example.test/v1',MODEL_API_KEY:'test-only-key',VISION_MODEL:'mock'})[k];
 const reviewRequest=async (base)=>{
   let body;
   const provider=createModelProvider({
     readEnv:name=>({MODEL_BASE_URL:base,REVIEW_MODEL:'deepseek-v4-pro'})[name] ?? env(name),
     fetchImpl:async (_url,options)=>{
       body=JSON.parse(options.body);
       return Response.json({choices:[{message:{content:'{"reviews":[]}'}}]});
     },
   });
   check((await provider.generate('review','只输出 JSON',1000)).ok,'review request reaches the configured provider');
   return body;
 };
 const bailianReview=await reviewRequest('https://dashscope.aliyuncs.com/compatible-mode/v1');
 check(bailianReview.enable_thinking===false && bailianReview.stream===false && bailianReview.max_tokens===1000 &&
   !Object.hasOwn(bailianReview,'thinking'),'Bailian DeepSeek review disables thinking with the supported parameter');
 const deepseekReview=await reviewRequest('https://api.deepseek.com/v1');
 check(deepseekReview.thinking?.type==='disabled' && !Object.hasOwn(deepseekReview,'enable_thinking'),
   'direct DeepSeek review uses its own thinking parameter');
 const proxyReview=await reviewRequest('https://example.test/v1');
 check(!Object.hasOwn(proxyReview,'thinking') && !Object.hasOwn(proxyReview,'enable_thinking'),
   'an unrelated provider does not receive vendor-specific parameters');
 const timeoutProvider=createModelProvider({readEnv:env,timeoutMs:25,fetchImpl:async()=>({ok:true,headers:new Headers(),json:()=>new Promise(()=>{})})});
 const timeout=await timeoutProvider.recognize({images:[],prompt:'mock'});check(timeout.errorCode==='model_timeout'&&timeout.latencyMs<1000,'deadline includes response body');
 const outputProvider=createModelProvider({readEnv:env,fetchImpl:async()=>({ok:true,headers:new Headers(),json:async()=>({choices:[{finish_reason:'length',message:{content:'{"partial":'}}]})})});
 check((await outputProvider.recognize({images:[],prompt:'mock'})).errorCode==='model_output_truncated','truncation is not false success');
 const quotaProvider=createModelProvider({readEnv:env,fetchImpl:async()=>({ok:false,status:403,json:async()=>({error:{code:'AllocationQuota.FreeTierOnly'}})})});
 check((await quotaProvider.recognize({images:[],prompt:'mock'})).errorCode==='model_quota_exhausted','quota distinguished from bad key');
 return {passed:checks,paidCalls:0,questions:qs.length};
}
