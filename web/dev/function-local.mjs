// 本地内存适配器默认读取服务端模型环境变量。只有显式指定 EB_MOCK_MODEL 才开启样例模拟。
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { application } from "../functions/routes.mjs";
import { createModelProvider } from "../functions/model.mjs";
import { createMathVerifier } from "../functions/math-client.mjs";
import { makeDb, makeStorage, BackendError, errorResponse, makeMockModel } from "./memory-adapter.mjs";

const readEnv = (name) => process.env[name];
const mockMode = readEnv("EB_MOCK_MODEL");
const model = mockMode ? makeMockModel(mockMode) : createModelProvider({readEnv});
if (mockMode) {
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const samples = new Set(["paper","sheet"].map((kind) => hash(readFileSync(new URL(`../public/examples/${kind}.png`, import.meta.url)))));
  const recognize = model.recognize;
  model.demoOnly = true;
  model.recognize = (input) => input.images?.length && input.images.every(({base64}) => samples.has(hash(Buffer.from(base64,"base64"))))
    ? recognize(input) : Promise.resolve({ok:false,errorCode:"simulation_only",latencyMs:0});
}

const db = makeDb();
const workspacePassword = readEnv("EB_WORKSPACE_PASSWORD");
const handle = application({
  db,
  storage: makeStorage(),
  BackendError,
  model,
  verifyMath: mockMode
    ? async (claims) => claims.length ? {status:"passed",code:"mock_math_check"} : {status:"unsupported",code:"no_supported_claim"}
    : createMathVerifier({readEnv}),
  login:workspacePassword ? {required:true,password:workspacePassword,signingKey:crypto.randomUUID()} : undefined,
});

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers.set(k, v);
      else if (Array.isArray(v)) for (const item of v) headers.append(k, item);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers,
      body: hasBody ? req : undefined,
      duplex: hasBody ? "half" : undefined,
    });
    const context = { request, requestId: crypto.randomUUID() };
    let response;
    try {
      response = await handle(context);
    } catch (error) {
      response = errorResponse(error, context.requestId);
    }
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(new Uint8Array(await response.arrayBuffer()));
  })
  .listen(Number(process.env.PORT || 8000), "127.0.0.1", () => {
    console.log(`local function adapter listening on http://127.0.0.1:${process.env.PORT || 8000}`);
  });
