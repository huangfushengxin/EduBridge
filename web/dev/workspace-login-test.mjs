import assert from "node:assert/strict";
import { application } from "../functions/routes.mjs";
import { BackendError, errorResponse, makeDb, makeStorage } from "./memory-adapter.mjs";

const db = makeDb();
const storage = makeStorage();
const password = "local-login-fixture";
const signingKey = "local-workspace-session-signing-fixture";
const credentials = {username:"EduBridge",password};

function setup(login) {
  const handle = application({db,storage,BackendError,login});
  return async (path,{method="GET",token,cookie,access,body,site}={}) => {
    const headers = new Headers();
    if (token) headers.set("x-eb-session",token);
    if (access) headers.set("x-eb-workspace",access);
    if (cookie) headers.set("cookie",cookie);
    if (site) headers.set("sec-fetch-site",site);
    if (body) headers.set("content-type","application/json");
    const request = new Request(`https://local.test/functions/v1/app/api/${path}`,{
      method,headers,body:body ? JSON.stringify(body) : undefined,
    });
    let response;
    try {
      response = await handle({request,requestId:crypto.randomUUID()});
    } catch (error) {
      if (!(error instanceof BackendError)) throw error;
      response = errorResponse(error);
    }
    return {status:response.status,body:await response.json(),cookie:response.headers.get("set-cookie")};
  };
}

const legacy = setup();
const guest = await legacy("session",{method:"POST"});
const token = guest.body.token;
const otherToken = (await legacy("session",{method:"POST"})).body.token;
const task = await legacy("tasks",{method:"POST",token,body:{kind:"manual"}});
assert.equal(task.status,201);
assert.deepEqual((await legacy("auth/status")).body,{required:false,configured:false,authenticated:false});

const publicSite = setup({required:false,password,signingKey});
assert.deepEqual((await publicSite("auth/status")).body,{required:false,configured:false,authenticated:false});
assert.equal((await publicSite(`tasks/${task.body.id}`,{token})).status,200);
assert.equal((await publicSite(`tasks/${task.body.id}`,{token:otherToken})).status,404);
assert.equal((await publicSite("tasks")).body.error,"session_required");

const locked = setup({required:true});
assert.equal((await locked("health")).status,200);
assert.equal((await locked("session",{method:"POST"})).status,201);
assert.equal((await locked("tasks",{token})).status,401);
assert.equal((await locked("auth/login",{method:"POST",token,body:credentials})).status,503);

const call = setup({required:true,password,signingKey});
assert.deepEqual((await call("auth/status")).body,{required:true,configured:true,authenticated:false});
assert.equal((await call("tasks",{token})).body.error,"login_required");
assert.equal((await call("auth/login",{method:"POST",token,body:{...credentials,password:"wrong"}})).body.error,"login_bad_credentials");
assert.equal((await call("auth/login",{method:"POST",token,body:credentials,site:"cross-site"})).status,403);
const login = await call("auth/login",{method:"POST",token,body:credentials,site:"same-origin"});
assert.equal(login.status,200);
const access = login.body.token;
assert.match(access,/^\d{10}\.[0-9a-f]{64}$/);
const headers = {token,access};
assert.equal((await call("auth/status",headers)).body.authenticated,true);
assert.equal((await call(`tasks/${task.body.id}`,headers)).status,200);
assert.equal((await call(`tasks/${task.body.id}`,{access,token:otherToken})).status,401);
assert.equal((await call("auth/status",{access,cookie:guest.cookie.split(";",1)[0]})).body.authenticated,true);
assert.equal((await call("auth/status",{...headers,access:access.replace(/\d{10}/,"1234567890")})).body.authenticated,false);
assert.equal((await setup({required:true,password:"rotated",signingKey})("auth/status",headers)).body.authenticated,false);
assert.equal((await call("tasks",{token})).status,401);

const attempts = await Promise.all(Array.from({length:9},()=>call("auth/login",{
  method:"POST",token:otherToken,body:{...credentials,password:"wrong"},
})));
assert.equal(attempts.filter(({status})=>status===429).length,1);
console.log("PASS workspace login, session ownership, configuration and rate limits");
