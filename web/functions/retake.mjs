// 诊断和复测共用可验证的规则题。评分仅接受单选题的选项标识。
const expr = (op, left, right) => ({ op, args: [left, right] });
const domain = (lower = null, lower_closed = false, exclude = []) =>
  ({ lower, upper: null, lower_closed, upper_closed: false, exclude });
const equation = (left, right, expected, range = domain()) =>
  ({ kind: "equation", left, right, relation: "eq", expected, domain: range });
const equivalent = (left, right, range = domain()) => ({ kind: "equivalent", left, right, domain: range });
const amgm = (k) => ({ kind: "amgm2", a: 1, b: k * k, claimed_lower: 2 * k, equality_x: k, domain: domain(0) });
const xSquared = expr("pow", "x", 2);

const templates = {
  "SET-01": k => ({
    stem: "设 $A=\\{" + k + "," + (k + 1) + "\\}$，$B=\\{" + k + "\\}$。以下哪个关系成立？",
    options: ["$B\\subseteq A$", "$B\\in A$", "$A\\subseteq B$"], answerIndex: 0,
    explanation: "集合 $B$ 的唯一元素属于 $A$，因此 $B$ 是 $A$ 的子集。",
    math_claims: [{ kind: "set", op: "intersection", left: [k], right: [k, k + 1], expected: [k] }],
  }),
  "SET-02": k => ({
    stem: "设 $A=\\{" + k + "\\}$，$B=\\{x\\in\\mathbb R\\mid ax=1\\}$。若 $B\\subseteq A$，实数 $a$ 的所有可能取值是什么？",
    options: ["$0$ 或 $1/" + k + "$", "$1/" + k + "$", "$0$ 或 $" + k + "$"], answerIndex: 0,
    explanation: "$a=0$ 时 $B=\\varnothing$，子集条件成立；$a\\ne0$ 时需令 $1/a=" + k + "$。",
    math_claims: [equation(0, 1, []), equation(expr("mul", k, "x"), 1, ["1/" + k])],
  }),
  "SET-03": k => ({
    stem: "已知集合 $\\{a+" + k + ",a^2+" + k + "\\}$ 恰有两个元素，且含有 $" + (k + 1) + "$。求实数 $a$。",
    options: ["$-1$", "$1$", "$-1$ 或 $1$"], answerIndex: 0,
    explanation: "先得到候选 $a=\\pm1$，代入 $a=1$ 时两项相等，只有一个元素。",
    math_claims: [equation(xSquared, 1, [-1, 1]), equation(expr("add", "x", k), k + 1, [1])],
  }),
  "FUN-01": k => {
    const excluded = k + 1;
    return {
      stem: "求实函数 $f(x)=\\sqrt{x-" + k + "}+1/(x-" + excluded + ")$ 的定义域。",
      options: ["$x\\ge " + k + "$ 且 $x\\ne " + excluded + "$", "$x\\ge " + k + "$", "$x\\ne " + excluded + "$"], answerIndex: 0,
      explanation: "偶次根式要求被开方数非负，分式要求分母非零，两项条件同时满足。",
      math_claims: [{ kind: "inequality", left: "x", right: k, relation: "ge", domain: domain(null, false, [excluded]), expected: domain(k, true, [excluded]) }],
    };
  },
  "FUN-02": k => ({
    stem: "设 $f(x)=1/(x-" + k + ")$。只判断它在整个定义域上是否为减函数，哪项正确？",
    options: [
      "是，因为它在分母为正和分母为负的区间各自递减。",
      "否，取 $" + (k - 1) + "<" + (k + 1) + "$，对应函数值 $-1<1$。",
      "是，因为分母随自变量增大，取倒数后在整个定义域上递减。",
    ], answerIndex: 1,
    explanation: "跨两个区间的这两个点违反了减函数的定义。",
    math_claims: [
      equivalent(expr("div", 1, expr("sub", k - 1, k)), -1),
      equivalent(expr("div", 1, expr("sub", k + 1, k)), 1),
    ],
  }),
  "FUN-03": k => ({
    stem: "按各自解析式的自然定义域，$f(x)=x+" + k + "$ 与 $g(x)=(x^2-" + (k * k) + ")/(x-" + k + ")$ 是否为同一函数？",
    options: ["是，约分后解析式相同。", "否，$g$ 在 $x=" + k + "$ 处无定义，$f$ 有定义。", "否，它们在公共定义域内的对应关系不同。"], answerIndex: 1,
    explanation: "约分只在分母非零时成立，完整定义域不相同。",
    math_claims: [equivalent(expr("div", expr("sub", xSquared, k * k), expr("sub", "x", k)), expr("add", "x", k), domain(null, false, [k]))],
  }),
  "INE-01": k => ({
    stem: "已知 $x<0$，求 $x+" + (k * k) + "/x$ 的最大值及取值点。",
    options: [
      "$-" + (2 * k) + "$，在 $x=-" + k + "$ 取到。",
      "$" + (2 * k) + "$，在 $x=" + k + "$ 取到。",
      "$-" + (2 * k) + "$，在 $x=" + k + "$ 取到。",
    ], answerIndex: 0,
    explanation: "令 $y=-x>0$，原式等于 $-(y+" + (k * k) + "/y)$；正值最小值取负后成为最大值。",
    math_claims: [amgm(k)],
  }),
  "INE-02": k => ({
    stem: "设 $x\\ge " + (k + 1) + "$。用基本不等式得 $x+" + (k * k) + "/x\\ge " + (2 * k) + "$，这个下界能取到吗？",
    options: [
      "能，取 $x=" + k + "$ 即可。",
      "不能，因为在正数域内等号只能在 $x=" + k + "$ 成立。",
      "不能，因为对任意正数 $x$ 都不会出现等号。",
    ], answerIndex: 1,
    explanation: "取等点须落在题设范围。唯一正取等点 $" + k + "$ 小于题设下限。",
    math_claims: [amgm(k), equation("x", k, [], domain(k + 1, true))],
  }),
  "INE-03": k => ({
    stem: "对 $x>0$，$x+" + (k * k) + "/x\\ge " + (2 * k) + "$ 的等号成立时，$x$ 等于多少？",
    options: ["$" + k + "$", "$-" + k + "$", "$" + (k * k) + "$"], answerIndex: 0,
    explanation: "由 $x=" + (k * k) + "/x$ 得 $x^2=" + (k * k) + "$，题设取正根。",
    math_claims: [amgm(k)],
  }),
};

const canonical = value => value.normalize("NFKC").replace(/\s+/g, "");

export function ruleExerciseDraft(work, {targetId, ruleIds} = {}) {
  const ordered = [...work.diagnosis.hypotheses].sort((a, b) => Number(b.support_status === "supported") - Number(a.support_status === "supported"));
  const available = (id) => Object.hasOwn(templates, id) && (!ruleIds?.length || ruleIds.includes(id));
  const target = ordered.find(h => h.category !== "insufficient_evidence" &&
    (!targetId || h.hypothesis_id === targetId) && h.rule_ids.some(available));
  if (!target) return null;
  const rule = target.rule_ids.find(available);
  const before = new Set([work.question.stem, ...work.items.map(item => item.stem), work.retake?.stem].filter(Boolean).map(canonical));
  const offset = Number.parseInt(work.question.id.slice(0, 4), 16) % 7;
  const version = work.retake?.artifact_version ?? 0;
  for (let step = 0; step < 7; step++) {
    const k = 3 + (offset + version + step) % 7;
    const draft = templates[rule](k);
    if (before.has(canonical(draft.stem))) continue;
    const order = (offset + version + step) % draft.options.length;
    const options = draft.options.map((_, index) => {
      const original = (index + order) % draft.options.length;
      return { key: "ABC"[index], text: draft.options[original] };
    });
    const correctOption = "ABC"[(draft.answerIndex - order + options.length) % options.length];
    return {
      target_hypothesis_id: target.hypothesis_id, rule_ids: [rule], stem: draft.stem, conditions: [], options,
      correctOption, answer_private: correctOption + "。 " + draft.explanation,
      rubric_private: "只接受单个选项。与正确选项一致判正确。", math_claims: draft.math_claims,
    };
  }
  return null;
}

export function retakeDraft(work) {
  const item = work.items.find((a) => a.correctOption && a.attempt?.result);
  return ruleExerciseDraft(work, item && {targetId:item.target_hypothesis_id, ruleIds:item.rule_ids});
}
