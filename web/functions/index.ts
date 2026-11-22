import { createDatabaseClient, createSiteContext, errorResponse, BackendError } from './_qoder/backend.mjs';
import { createStorageClient } from './_qoder/storage.mjs';
import { application } from './routes.mjs';
import { createModelProvider } from './model.mjs';
import { createMathVerifier } from './math-client.mjs';
import { parseBudgetOverrides } from './model-budget.mjs';

// 模型适配层仅在服务端读取平台 Secret（MODEL_BASE_URL/MODEL_API_KEY/VISION_MODEL）；
// 前端不直连供应商，密钥不进入浏览器代码/仓库/日志。
const readEnv = (name: string) => Deno.env.get(name);
const model = createModelProvider({ readEnv, fetchImpl: fetch });
const verifyMath = createMathVerifier({ readEnv });
async function authorizeReviewer(request: Request) {
  const secret = readEnv('EB_REVIEWER_TOKEN');
  const provided = request.headers.get('x-eb-reviewer');
  if (!secret || secret.length < 32 || !provided || provided.length > 500) return false;
  const encoder = new TextEncoder();
  const hash = async (v: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(v)));
  const [left, right] = await Promise.all([hash(secret), hash(provided)]);
  return left.reduce((difference, byte, i) => difference | (byte ^ right[i]), 0) === 0;
}
// 单任务联调预算覆盖来自站点环境变量（非密钥配置），默认 12、非法或缺失回退 12。
const handle = application({ db: createDatabaseClient(), storage: createStorageClient(), BackendError, model, verifyMath, authorizeReviewer,
  budgetOverrides: parseBudgetOverrides(Deno.env.get('EB_TASK_BUDGET_OVERRIDES')) });
Deno.serve(async request => {
  let context;
  try { context = createSiteContext(request); return await handle(context); }
  catch (error) { return errorResponse(error, context?.requestId); }
});
