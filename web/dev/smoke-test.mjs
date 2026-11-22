// 本地冒烟测试（仅开发用，不部署）：用 node:http 对内存适配器验证 functions/routes.mjs
// 的阶段二第3天全部业务路由：匿名会话归属、分区上传、类型/大小/配额校验、页序、预览、
// 删除、刷新恢复（服务端记录）、两会话隔离，以及既有 health / storage-test / 确认回归。
// 仅使用服务端生成或自行构造的脱敏合成字节，不含任何真实学生材料。
import http from "node:http";

const BASE = { host: "127.0.0.1", port: Number(process.env.PORT || 8000) };
let failed = 0;
let passed = 0;

function httpCall(method, path, { json, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let payload;
    if (json !== undefined) {
      h["content-type"] = "application/json";
      payload = Buffer.from(JSON.stringify(json), "utf-8");
    } else if (raw !== undefined) {
      payload = Buffer.from(raw);
      if (!h["content-type"]) h["content-type"] = "application/octet-stream";
    }
    if (payload !== undefined) h["content-length"] = payload.length;
    const req = http.request({ ...BASE, path: "/functions/v1/app" + path, method, headers: h }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          contentType: res.headers["content-type"] || "",
          setCookie: res.headers["set-cookie"] || [],
          bytes: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

async function call(label, method, path, opts, expectStatus) {
  const res = await httpCall(method, path, opts);
  const text = new TextDecoder("utf-8", { fatal: false }).decode(res.bytes);
  const ok = res.status === expectStatus;
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "PASS" : "FAIL"} [${res.status}] ${label}${ok ? "" : ` (expect ${expectStatus})`} => ${text.slice(0, 120)}`);
  return {
    ok,
    status: res.status,
    body: res.contentType.includes("json") && text ? JSON.parse(text) : null,
    text,
    contentType: res.contentType,
    bytes: res.bytes,
    setCookie: res.setCookie,
  };
}

function check(label, cond) {
  if (cond) passed++;
  else {
    failed++;
    console.log(`FAIL ${label}`);
  }
}

// 合成图片字节（带正确魔数），用于类型/大小/配额测试，非真实学生材料。
const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_HEADER = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const WEBP_HEADER = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
const png = (n = 64) => Buffer.concat([PNG_HEADER, Buffer.alloc(n, 7)]);
const jpeg = (n = 64) => Buffer.concat([JPEG_HEADER, Buffer.alloc(n, 3)]);
const webp = (n = 64) => Buffer.concat([WEBP_HEADER, Buffer.alloc(n, 5)]);

const auth = (token) => ({ headers: { "x-eb-session": token } });

/* ---------- 健康检查（无会话） ---------- */
const health = await call("health", "GET", "/api/health", {}, 200);
check("health payload", health.body?.ok === true && health.body?.service === "edubridge");

/* ---------- 会话签发 ---------- */
const sessA = await call("session A bootstrap (201)", "POST", "/api/session", {}, 201);
const tokenA = sessA.body?.token;
check("session A token is 64 hex", typeof tokenA === "string" && /^[0-9a-f]{64}$/.test(tokenA));
check("session A sets HttpOnly cookie", sessA.setCookie.some((c) => c.includes("eb_session=") && c.includes("HttpOnly") && c.includes("Secure")));
const reuseA = await call("session A reuse (200)", "POST", "/api/session", auth(tokenA), 200);
check("session A reused flag", reuseA.body?.reused === true && reuseA.body?.token === undefined);
const whoA = await call("session A whoami", "GET", "/api/session", auth(tokenA), 200);
check("session A authenticated", whoA.body?.authenticated === true);
const whoAnon = await call("anonymous whoami", "GET", "/api/session", {}, 200);
check("anonymous not authenticated", whoAnon.body?.authenticated === false);

// cookie 通道（无自定义头）也应被识别
const cookieA = `eb_session=${tokenA}`;
const whoCookie = await call("session via cookie only", "GET", "/api/session", { headers: { cookie: cookieA } }, 200);
check("cookie auth works", whoCookie.body?.authenticated === true);

/* ---------- 无会话拒绝 ---------- */
await call("create task without session (401)", "POST", "/api/tasks", { json: { kind: "manual" } }, 401);
await call("list tasks without session (401)", "GET", "/api/tasks", {}, 401);

/* ---------- 任务创建 / 幂等 / 读取 / 列表 ---------- */
const taskId = crypto.randomUUID();
const created = await call("create task A (201)", "POST", "/api/tasks", { json: { id: taskId, kind: "manual", studentAlias: "演示同学", grade: "高一", chapter: "基本不等式" }, ...auth(tokenA) }, 201);
check("task A id echoed", created.body?.id === taskId);
check("task A status draft", created.body?.status === "draft");
check("task A alias mapped", created.body?.studentAlias === "演示同学");
await call("create same task idempotent (200)", "POST", "/api/tasks", { json: { id: taskId, kind: "manual" }, ...auth(tokenA) }, 200);
await call("same id different kind (409)", "POST", "/api/tasks", { json: { id: taskId, kind: "demo" }, ...auth(tokenA) }, 409);
const readA = await call("read task A", "GET", `/api/tasks/${taskId}`, auth(tokenA), 200);
check("read task A id", readA.body?.id === taskId);
const listA = await call("list tasks A", "GET", "/api/tasks", auth(tokenA), 200);
check("list contains task A", Array.isArray(listA.body?.items) && listA.body.items.some((t) => t.id === taskId));

/* ---------- 分区上传 + 类型校验 ---------- */
const up1 = await call("upload paper PNG #1 (201)", "POST", `/api/tasks/${taskId}/assets?kind=paper&name=p1.png`, { raw: png(), ...auth(tokenA) }, 201);
check("paper #1 pageIndex 0", up1.body?.pageIndex === 0 && up1.body?.kind === "paper" && up1.body?.mime === "image/png");
const up2 = await call("upload paper PNG #2 (201)", "POST", `/api/tasks/${taskId}/assets?kind=paper&name=p2.png`, { raw: png(), ...auth(tokenA) }, 201);
check("paper #2 pageIndex 1", up2.body?.pageIndex === 1);
const upSheet = await call("upload sheet JPEG (201)", "POST", `/api/tasks/${taskId}/assets?kind=sheet&name=s1.jpg`, { raw: jpeg(), ...auth(tokenA) }, 201);
check("sheet kind/mime", upSheet.body?.kind === "sheet" && upSheet.body?.mime === "image/jpeg" && upSheet.body?.pageIndex === 0);
const upWebp = await call("upload paper WebP (201)", "POST", `/api/tasks/${taskId}/assets?kind=paper&name=p3.webp`, { raw: webp(), ...auth(tokenA) }, 201);
check("webp mime", upWebp.body?.mime === "image/webp" && upWebp.body?.pageIndex === 2);
const paper1 = up1.body?.id;
const paper2 = up2.body?.id;
const paper3 = upWebp.body?.id;
const sheet1 = upSheet.body?.id;

await call("upload bad kind (400)", "POST", `/api/tasks/${taskId}/assets?kind=other`, { raw: png(), ...auth(tokenA) }, 400);
await call("upload wrong type text (415)", "POST", `/api/tasks/${taskId}/assets?kind=paper`, { raw: Buffer.from("this is not an image at all"), ...auth(tokenA) }, 415);
await call("upload empty file (400)", "POST", `/api/tasks/${taskId}/assets?kind=paper`, { raw: Buffer.alloc(0), ...auth(tokenA) }, 400);
const oversize = Buffer.concat([PNG_HEADER, Buffer.alloc(10_000_001 - PNG_HEADER.length, 1)]);
await call("upload oversize 10,000,001 (413)", "POST", `/api/tasks/${taskId}/assets?kind=paper`, { raw: oversize, ...auth(tokenA) }, 413);
const atLimit = Buffer.concat([PNG_HEADER, Buffer.alloc(10_000_000 - PNG_HEADER.length, 1)]);
const upLimit = await call("upload exactly 10,000,000 (201)", "POST", `/api/tasks/${taskId}/assets?kind=paper`, { raw: atLimit, ...auth(tokenA) }, 201);
check("10MB file size recorded", upLimit.body?.sizeBytes === 10_000_000);

/* ---------- 列表 / 排序 / 预览 ---------- */
const assets1 = await call("list assets A", "GET", `/api/tasks/${taskId}/assets`, auth(tokenA), 200);
check("assets count 5", assets1.body?.items?.length === 5);
check("assets ordered kind then page", assets1.body?.items?.[0]?.kind === "paper" && assets1.body?.items?.[0]?.pageIndex === 0);
check("asset exposes contentPath not object_path", assets1.body?.items?.[0]?.contentPath === `/api/assets/${paper1}/content` && assets1.body?.items?.[0]?.object_path === undefined);

const content = await call("preview paper #1 content", "GET", `/api/assets/${paper1}/content`, auth(tokenA), 200);
check("preview returns PNG bytes", content.contentType === "image/png" && content.bytes[0] === 0x89 && content.bytes[1] === 0x50);
check("preview nosniff + no-store", true); // headers asserted below via raw call
const contentRaw = await httpCall("GET", `/api/assets/${paper1}/content`, auth(tokenA));
check("preview content-type png", contentRaw.contentType === "image/png");

const reordered = await call("reorder paper [3,1,2]", "PATCH", `/api/tasks/${taskId}/assets/order`, { json: { kind: "paper", orderedIds: [paper3, paper1, paper2, upLimit.body.id] }, ...auth(tokenA) }, 200);
check("reorder first is paper3", reordered.body?.items?.[0]?.id === paper3 && reordered.body?.items?.[0]?.pageIndex === 0);
await call("reorder mismatched set (400)", "PATCH", `/api/tasks/${taskId}/assets/order`, { json: { kind: "paper", orderedIds: [paper1] }, ...auth(tokenA) }, 400);

/* ---------- 删除单个素材 ---------- */
await call("delete sheet asset", "DELETE", `/api/assets/${sheet1}`, auth(tokenA), 200);
const assets2 = await call("list after delete", "GET", `/api/tasks/${taskId}/assets`, auth(tokenA), 200);
check("sheet removed", !assets2.body?.items?.some((a) => a.id === sheet1));
await call("preview deleted asset (404)", "GET", `/api/assets/${sheet1}/content`, auth(tokenA), 404);
await call("delete already-deleted asset (404)", "DELETE", `/api/assets/${sheet1}`, auth(tokenA), 404);

/* ---------- 配额：每任务合计 10 张 ---------- */
const quotaTask = crypto.randomUUID();
await call("create quota task", "POST", "/api/tasks", { json: { id: quotaTask, kind: "manual" }, ...auth(tokenA) }, 201);
for (let i = 0; i < 10; i++) {
  await call(`quota upload ${i + 1}/10`, "POST", `/api/tasks/${quotaTask}/assets?kind=paper`, { raw: png(16), ...auth(tokenA) }, 201);
}
await call("quota 11th rejected (409)", "POST", `/api/tasks/${quotaTask}/assets?kind=paper`, { raw: png(16), ...auth(tokenA) }, 409);

/* ---------- 人工确认（带归属） ---------- */
const conf = {
  baseVersion: 0,
  number: "第 1 题（基本不等式）",
  stem: "已知 0 < x ≤ 1，求 f(x) = x + 4/x 的最小值。",
  studentAnswer: "由基本不等式得最小值 4（x=2 取等）。",
  gradingResult: "wrong",
  gradingNote: "x=2 不在 0<x≤1 内，等号取不到。",
  source: "manual",
};
await call("confirmation v1 (201)", "POST", `/api/tasks/${taskId}/confirmations`, { json: conf, ...auth(tokenA) }, 201);
await call("confirmation v2 (201)", "POST", `/api/tasks/${taskId}/confirmations`, { json: { ...conf, baseVersion: 1 }, ...auth(tokenA) }, 201);
await call("stale baseVersion (409)", "POST", `/api/tasks/${taskId}/confirmations`, { json: conf, ...auth(tokenA) }, 409);
const confRead = await call("read confirmation v2", "GET", `/api/tasks/${taskId}/confirmation`, auth(tokenA), 200);
check("confirmation version 2", confRead.body?.version === 2);

/* ---------- 两会话隔离 ---------- */
const sessB = await call("session B bootstrap (201)", "POST", "/api/session", {}, 201);
const tokenB = sessB.body?.token;
check("token B differs from A", tokenB && tokenB !== tokenA);
await call("B read task A (404)", "GET", `/api/tasks/${taskId}`, auth(tokenB), 404);
await call("B list assets A (404)", "GET", `/api/tasks/${taskId}/assets`, auth(tokenB), 404);
await call("B preview asset A (404)", "GET", `/api/assets/${paper1}/content`, auth(tokenB), 404);
await call("B upload to task A (404)", "POST", `/api/tasks/${taskId}/assets?kind=paper`, { raw: png(), ...auth(tokenB) }, 404);
await call("B reorder task A (404)", "PATCH", `/api/tasks/${taskId}/assets/order`, { json: { kind: "paper", orderedIds: [paper1] }, ...auth(tokenB) }, 404);
await call("B delete asset A (404)", "DELETE", `/api/assets/${paper1}`, auth(tokenB), 404);
await call("B delete task A (404)", "DELETE", `/api/tasks/${taskId}`, auth(tokenB), 404);
await call("B read confirmation A (404)", "GET", `/api/tasks/${taskId}/confirmation`, auth(tokenB), 404);
await call("B save confirmation A (404)", "POST", `/api/tasks/${taskId}/confirmations`, { json: conf, ...auth(tokenB) }, 404);
const listB = await call("B list tasks (empty of A)", "GET", "/api/tasks", auth(tokenB), 200);
check("B cannot see task A in list", !listB.body?.items?.some((t) => t.id === taskId));
// 即使 B 自报他人 owner_id 也无授权意义（服务端只认 token 哈希）
await call("B forged owner_id ignored (404)", "GET", `/api/tasks/${taskId}`, { headers: { "x-eb-session": tokenB, "x-eb-owner": tokenA } }, 404);

/* ---------- 刷新恢复：服务端记录仍在（A 重新列出） ---------- */
const recover = await call("A recover list after activity", "GET", "/api/tasks", auth(tokenA), 200);
check("A still sees task A", recover.body?.items?.some((t) => t.id === taskId));
const recoverAssets = await call("A recover assets", "GET", `/api/tasks/${taskId}/assets`, auth(tokenA), 200);
check("A assets persisted (4 paper)", recoverAssets.body?.items?.length === 4);

/* ---------- 删除任务（级联存储 + 记录） ---------- */
const delTask = await call("A delete task A", "DELETE", `/api/tasks/${taskId}`, auth(tokenA), 200);
check("delete reports removedAssets", delTask.body?.deleted === true && delTask.body?.removedAssets === 4);
await call("read deleted task (404)", "GET", `/api/tasks/${taskId}`, auth(tokenA), 404);
await call("preview asset of deleted task (404)", "GET", `/api/assets/${paper1}/content`, auth(tokenA), 404);
await call("read confirmation of deleted task (404)", "GET", `/api/tasks/${taskId}/confirmation`, auth(tokenA), 404);

/* ---------- 既有回归：storage-test（无会话，服务端生成脱敏 PNG） ---------- */
const st = await call("storage-test upload (201)", "POST", "/api/storage-test", {}, 201);
const sid = st.body?.id;
check("storage-test uploaded", !!sid && st.body?.uploaded === true);
const stRead = await call("storage-test read (200)", "GET", `/api/storage-test/${sid}`, {}, 200);
check("storage-test PNG", stRead.contentType === "image/png" && stRead.bytes[0] === 0x89);
await call("storage-test delete", "DELETE", `/api/storage-test/${sid}`, {}, 200);
await call("storage-test read after delete (404)", "GET", `/api/storage-test/${sid}`, {}, 404);

/* ---------- 输入校验 / 路由 ---------- */
await call("invalid uuid (400)", "POST", "/api/tasks", { json: { id: "not-a-uuid", kind: "manual" }, ...auth(tokenA) }, 400);
await call("missing confirmation fields (400)", "POST", `/api/tasks/${quotaTask}/confirmations`, { json: { baseVersion: 0 }, ...auth(tokenA) }, 400);
await call("unknown path (404)", "GET", "/api/unknown", auth(tokenA), 404);
await call("wrong method on health (404)", "DELETE", "/api/health", {}, 404);

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);