// Only recognize complete, unambiguous positive-domain minimization questions.
const expression = "(?:函数)?(?:f\\(x\\)=)?x\\+(\\d{1,4})/x";
const range = "(x>0|x≥\\d{1,2}|0<x≤\\d{1,2})";
const ending = "(?:[,。.]?并(?:写出|说明)(?:理由|取等条件|等号成立条件|取等点|此时x的值))?[。.!?]?(?:请写出最小值和取到最小值时的x[。.]?)?";
const ask = "[,。.]+(?:\\(1\\))?求";
const functionFirst = new RegExp("^已知" + expression + "[,且]+" + range + ask + "(?:函数)?(?:f\\(x\\))?的?最小值" + ending + "$");
const domainFirst = new RegExp("^已知" + range + ask + expression + "的最小值" + ending + "$");
const op = (name, left, right) => ({op:name,args:[left,right]});
export const templateAuthor = "edubridge-template";

export function ruleLesson(work) {
  const item = work.items.find((a) => a.generatedBy === templateAuthor && a.correctOption && a.attempt?.result);
  if (!item) return null;
  const target = work.diagnosis.hypotheses.find((h) => h.hypothesis_id === item.target_hypothesis_id);
  const source = target?.evidence.find((e) => e.source_type === "student_step");
  const stepId = source?.step_id ?? work.diagnosis.first_error_step_id;
  const step = work.question.steps.find((s) => s.step_id === stepId);
  const option = item.options.find(({key}) => key === item.correctOption);
  if (!step || !option) return null;
  return {
    lesson_scope:"practice_example", rule_ids:item.rule_ids, math_claims:item.math_claims,
    steps:[
      {step_id:step.step_id, original_step:step.content, title:"回看原作答",
        text:"对照题设条件检查这一步，再用下方同类题核对你的判断。"},
      {step_id:null, original_step:null, title:"同类题讲解",
        text:item.stem + " 正确选项为 " + option.text + "。" + item.answer_private.replace(/^[ABC]。\s*/, "")},
    ],
  };
}

export function minimumLesson(work) {
  if (work.diagnosis?.knowledge_point !== "basic_inequalities") return null;
  const target = work.diagnosis.hypotheses.find((h) => h.rule_ids.some((id) => id === "INE-02" || id === "INE-03") &&
    h.evidence.some((e) => e.source_type === "student_step"));
  if (!target) return null;
  const source = target.evidence.find((e) => e.source_type === "student_step");
  const step = work.question.steps.find((s) => s.step_id === source.step_id);
  if (!step) return null;
  const stem = work.question.stem.normalize("NFKC").replace(/[\s$]/g,"")
    .replace(/\\[()[\]]/g,"").replace(/\\(?:d?frac)\{(\d+)\}\{x\}/g,"$1/x")
    .replace(/\\ge(?:q(?:slant)?)?(?![a-z])|>=/g,"≥").replace(/\\le(?:q(?:slant)?)?(?![a-z])|<=/g,"≤")
    .replace(/^(?:\d+(?:\(\d+\))?[.、:]|\(\d+\))/,"");
  const first = functionFirst.exec(stem);
  const second = first ? null : domainFirst.exec(stem);
  if (!first && !second) return null;
  const c = Number(first?.[1] ?? second[2]);
  const condition = first?.[2] ?? second[1];
  const k = Math.sqrt(c);
  const bound = condition === "x>0" ? 0 : Number(condition.match(/\d+$/)[0]);
  if (!Number.isInteger(k) || k < 1 || k > 40 || (condition !== "x>0" && (bound < 1 || bound > 70))) return null;
  const upperBounded = condition.startsWith("0<");
  const lower = upperBounded ? 0 : bound;
  const upper = upperBounded ? bound : null;
  const domain = {lower,upper,lower_closed:lower>0,upper_closed:upper!==null};
  const point = upperBounded ? Math.min(k,upper) : Math.max(k,lower);
  const numerator = point ** 2 + c;
  const value = numerator % point === 0 ? numerator / point : numerator + "/" + point;
  const functionValue = op("add","x",op("div",c,"x"));
  const check = point === k
    ? [{kind:"amgm2",a:1,b:c,domain,claimed_lower:value,equality_x:k}]
    : [
      {kind:"inequality",left:functionValue,right:value,relation:"ge",domain,expected:domain},
      {kind:"equation",left:functionValue,right:value,relation:"eq",domain,expected:[point]},
    ];
  const proof = point === k
    ? "在这个范围内可以取 $x=" + k + "$。由基本不等式，$f(x)\\ge " + value + "$，且只有在 $x=" + k + "$ 时取等。"
    : "取边界 $t=" + point + "$。由 $f(x)-f(t)=(x-t)(1-" + c + "/(tx))$，在题设范围内两个因子同号或有因子为零，所以 $f(x)\\ge f(t)=" +
      value + "$，且只在 $x=" + point + "$ 时取得。";
  return {target, teaching:{
    rule_ids:target.rule_ids.filter((id) => id === "INE-02" || id === "INE-03"),
    steps:[
      {step_id:step.step_id,original_step:step.content,title:"核对取等点",text:"先令基本不等式的两项相等，解 $x=" + c + "/x$。只取正根，得到 $x=" + k +
        "$。再和题设范围 $" + condition.replace("≥","\\ge ").replace("≤","\\le ") + "$ 对照。"},
      {step_id:null,original_step:null,title:"求出题设范围内的最小值",text:proof},
    ],
    math_claims:check,
  }};
}
