// 固定样例与规则库的数值核对（仅开发用，不部署、不调用模型）。
// 数值抽样只用于核对参考结果与发现反例，不构成"已证明恒成立"（AGENTS.md §2）。
// 用法：node dev/math-check.mjs
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log(`PASS  ${name}${detail ? "  " + detail : ""}`); }
  else { failed++; console.log(`FAIL  ${name}${detail ? "  " + detail : ""}`); }
}
const approx = (a, b) => Math.abs(a - b) < 1e-9;

// FUN-02：1/x 跨区间反例
const f1 = (x) => 1 / x;
check("FUN-02 反例：-1<1 但 f(-1)<f(1)", -1 < 1 && f1(-1) < f1(1), `f(-1)=${f1(-1)}, f(1)=${f1(1)}`);

// FUN-01：定义域端点
check("FUN-01：x=1 有定义（根式=0，分母=-1）", 1 - 1 >= 0 && 1 - 2 !== 0);
check("FUN-01：x=2 分母为零不可取", 2 - 2 === 0);
check("FUN-01：x=3 有定义", 3 - 1 >= 0 && 3 - 2 !== 0);

// INE-01：x<0 时 x+1/x ≤ -2，最大值 -2 于 x=-1
const g = (x) => x + 1 / x;
check("INE-01：x=-1 取值 -2", approx(g(-1), -2));
check("INE-01：x=-2 取值 -2.5 < -2", g(-2) < -2, `g(-2)=${g(-2)}`);
check("INE-01：x=-0.5 取值 -2.5 < -2", g(-0.5) < -2, `g(-0.5)=${g(-0.5)}`);
let ineq1 = true;
for (let x = -0.01; x >= -100; x *= 1.3) if (g(x) > -2 + 1e-9) ineq1 = false;
check("INE-01：负轴抽样均 ≤ -2（抽样非证明）", ineq1);

// INE-03：等号点 x=2（x>0）
const h = (x) => x + 4 / x;
check("INE-03：x=2 时 h=4=2√4", approx(h(2), 4) && approx(2 * Math.sqrt(4), 4));
check("INE-03：x=4 不是等号点（h(4)=5>4）", h(4) > 4, `h(4)=${h(4)}`);

// INE-02：x≥3 时等号点 x=2 在范围外；最小值 f(3)=13/3
check("INE-02：等号点 2 < 3（范围外）", 2 < 3);
check("INE-02：f(3)=13/3", approx(h(3), 13 / 3), `f(3)=${h(3)} ≈ ${(13 / 3).toFixed(4)}`);
check("INE-02：f(3) > 4（下界4取不到）", h(3) > 4);
let mono = true;
for (let x = 3; x < 1000; x += 0.7) if (h(x + 0.7) <= h(x)) mono = false;
check("INE-02：[3,1000) 抽样递增（抽样非证明）", mono);
check("INE-02：导数 f'(x)=1-4/x² 在 x>2 为正（x=3 处）", 1 - 4 / 9 > 0);
// INE-02 专项：闭区间 x≥3 与开区间 x>3 的最小值/下确界区分
check("INE-02：x=3 可取（闭区间），f(3)=13/3 即最小值", approx(h(3), 13 / 3));
check("INE-02：x>3 时 f(x)>13/3（3.0001 处）", h(3.0001) > 13 / 3, `f(3.0001)=${h(3.0001).toFixed(8)}`);
let approach = true;
for (const eps of [0.1, 0.01, 0.001, 0.0001]) if (!(h(3 + eps) > 13 / 3 && h(3 + eps) - 13 / 3 < eps)) approach = false;
check("INE-02：x→3⁺ 时 f→13/3（开区间下确界13/3取不到，无最小值）", approach);
check("INE-02：4 是下界但非下确界（4 < 13/3）", 4 < 13 / 3);
// 差值法单调性（高一可用，不依赖导数）：3≤a<b 时 f(b)-f(a)=(b-a)(1-4/(ab))>0
let diffMono = true;
for (let a = 3; a < 50; a += 1.3) {
  const b = a + 0.9;
  const diff = (b - a) * (1 - 4 / (a * b));
  if (!(diff > 0 && approx(h(b) - h(a), diff))) diffMono = false;
}
check("INE-02：差值法 f(b)-f(a)=(b-a)(1-4/(ab))>0 抽样核对", diffMono);

// SET-02：a=0 时 B=∅⊆A；a=1 时 B={1}⊆A
check("SET-02：a=0 ⇒ ax=1 无解（B=∅）", 0 * 1 !== 1 && 0 * 100 !== 1);
check("SET-02：a=1 ⇒ x=1 ∈ A={1}", 1 / 1 === 1);

// SET-03（v2 新例）：{a+1, a²+1} 恰有两个元素且 2 属于该集合，求 a
// 候选：a+1=2 ⇒ a=1；a²+1=2 ⇒ a=±1。a=1 时 {2,2}={2} 仅一个元素（违反"恰有两个"）；a=-1 时 {0,2} 符合。
const elems = (a) => [...new Set([a + 1, a * a + 1])];
check("SET-03：候选枚举 {1,-1}（a+1=2 或 a²+1=2）", [1, -1].every((a) => elems(a).includes(2)) && elems(2).includes(2) === false && elems(0).includes(2) === false);
check("SET-03：a=1 时 {2,2}={2} 仅一个元素，违反恰有两个元素", elems(1).length === 1 && elems(1)[0] === 2);
check("SET-03：a=1 时 2∈{2} 仍成立（无个数要求时不能舍 a=1）", elems(1).includes(2));
check("SET-03：a=-1 时 {0,2} 恰有两个元素且含 2", elems(-1).length === 2 && elems(-1).includes(2) && elems(-1).includes(0));
check("SET-03：旧例 a∈{1,a²} 中 a=1 合法（{1,1}={1}，1∈{1}）——旧规则舍 a=1 有误", new Set([1, 1 * 1]).has(1));

// SET-01（v2）：A={1,2} 的元素是 1 和 2；{1}⊆A、{1}⊊A 成立，{1}∈A 不成立；集合可作元素
const A = [1, 2];
const subset = (B, C) => B.every((x) => C.includes(x));
check("SET-01：{1}⊆A（1∈A）", subset([1], A));
check("SET-01：{1}⊊A（2∈A 但 2∉{1}）", subset([1], A) && A.some((x) => ![1].includes(x)));
check("SET-01：{1}∈A 不成立（A 的元素是数 1、2，不含集合 {1}）", !A.some((x) => Array.isArray(x)));
check("SET-01：{1}∈{{1},2} 成立（集合可以是另一集合的元素）", [[1], 2].some((x) => Array.isArray(x) && x.length === 1 && x[0] === 1));

// INE-01（v2）：公式对 a,b≥0 成立（含 0），严格正数非必要条件
check("INE-01：a=0,b=5 时 0+5≥2√0=0 成立", 0 + 5 >= 2 * Math.sqrt(0 * 5));
check("INE-01：a=b=0 时等号成立（0=0）", approx(0 + 0, 2 * Math.sqrt(0)));
let nonneg = true;
for (let i = 0; i < 500; i++) {
  const a = Math.random() * 50, b = Math.random() * 50;
  if (a + b < 2 * Math.sqrt(a * b) - 1e-9) nonneg = false;
}
check("INE-01：a,b≥0 随机抽样 a+b≥2√(ab)（抽样非证明）", nonneg);

console.log(`\n结果：${passed} 通过，${failed} 失败`);
if (failed > 0) process.exit(1);