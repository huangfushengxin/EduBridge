// 服务端调用独立数学工具。拒绝跳转，连同响应体读取一起限时。
// 送检前按已知 schema 做确定性正规化（仅修正可无歧义字段，不删除有效断言）：
// - equation/inequality/equivalent 缺失 domain 时，用题目条件中唯一显式区间补全；
// - expected 为单元素区间数组时解包为区间对象（服务端只接受对象或有限点数组）；
// - 不含 x 的等式是数值恒等式，按 equivalent 在全实数域核对，避免“解集等于某点”的错误语义。
const statuses = new Set(["passed", "failed", "unsupported", "timeout"]);
const INF = "(?:\\+?\\\\?infty|\\+?∞)";
const NUM = "-?\\d+(?:/\\d+)?";
const INTERVAL_SOURCE = "([\\[(])\\s*(" + NUM + "|" + INF + "|-" + INF + ")\\s*,\\s*(" + NUM + "|" + INF + "|-" + INF + ")\\s*([\\])])";

const intervalLike = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  "lower" in value && "upper" in value && "lower_closed" in value && "upper_closed" in value;

function hasX(node) {
  if (node === "x") return true;
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(hasX);
  return typeof node.op === "string" && Array.isArray(node.args) && node.args.some(hasX);
}

function domainFromConditions(conditions) {
  if (!Array.isArray(conditions)) return null;
  const found = new Map();
  for (const text of conditions) {
    if (typeof text !== "string") continue;
    const pattern = "^\\s*定义域(?:为|[:：])\\s*\\$?" + INTERVAL_SOURCE + "\\$?\\s*[。.]?\\s*$";
    const match = new RegExp(pattern).exec(text);
    if (!match) continue;
    if ((/infty|∞/.test(match[2]) && !match[2].startsWith("-")) ||
        (/infty|∞/.test(match[3]) && match[3].startsWith("-"))) continue;
    const lower = /infty|∞/.test(match[2]) ? null : match[2];
    const upper = /infty|∞/.test(match[3]) ? null : match[3];
    const domain = { lower, upper, lower_closed: match[1] === "[", upper_closed: match[4] === "]", exclude: [] };
    found.set(JSON.stringify(domain), domain);
  }
  // 仅在题目条件断言了唯一区间时使用，多区间或无法解析时不猜。
  return found.size === 1 ? [...found.values()][0] : null;
}

export function normalizeClaims(claims, context = {}) {
  if (!Array.isArray(claims)) return claims;
  const hint = domainFromConditions(context.conditions);
  return claims.map((claim) => {
    if (!claim || typeof claim !== "object" || Array.isArray(claim)) return claim;
    const next = { ...claim };
    if (!["equation", "inequality", "equivalent"].includes(next.kind)) return next;
    if (next.kind !== "equivalent" && Array.isArray(next.expected) && next.expected.length === 1 && intervalLike(next.expected[0])) {
      next.expected = next.expected[0];
    }
    if (next.domain) return next;
    if (next.kind === "equation" && next.relation === "eq" && !hasX(next.left) &&
        (typeof next.right === "number" || typeof next.right === "string") && next.right !== "x" &&
        Array.isArray(next.expected) && next.expected.length === 1 && next.expected[0] === next.right) {
      next.kind = "equivalent";
      delete next.relation;
      delete next.expected;
      next.domain = { lower: null, upper: null, lower_closed: false, upper_closed: false, exclude: [] };
    } else if (hint && (hasX(next.left) || hasX(next.right))) {
      next.domain = { ...hint, exclude: [] };
    }
    return next;
  });
}

export function createMathVerifier({ readEnv, fetchImpl = fetch }) {
  return async function verify(claims, context = {}) {
    const normalized = normalizeClaims(claims, context);
    const url = readEnv("MATH_VERIFY_URL");
    const token = readEnv("MATH_VERIFY_TOKEN");
    if (!normalized.length) return { status:"unsupported", code:"no_supported_claim" };
    if (!url || !token) return { status:"unsupported", code:"math_not_configured" };
    try {
      const endpoint = new URL(url);
      if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && ["localhost","127.0.0.1"].includes(endpoint.hostname))) {
        return { status:"unsupported", code:"math_endpoint_invalid" };
      }
      const response = await fetchImpl(new URL("/verify", endpoint), {
        method:"POST", redirect:"error", signal:AbortSignal.timeout(16000),
        headers:{"content-type":"application/json", authorization:"Bearer " + token},
        body:JSON.stringify({claims: normalized}),
      });
      if (!response.ok) return {status:"unsupported",code:"math_service_unavailable"};
      const value = await response.json();
      if (!statuses.has(value?.status)) return {status:"unsupported",code:"math_response_invalid"};
      return {status:value.status, code:typeof value.code === "string" ? value.code.slice(0,80) : "math_checked"};
    } catch (error) {
      return error?.name === "TimeoutError" || error?.name === "AbortError"
        ? {status:"timeout",code:"math_timeout"} : {status:"unsupported",code:"math_service_unavailable"};
    }
  };
}
