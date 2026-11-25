const accessHeader = "x-eb-workspace";
const lifetime = 12 * 60 * 60;
const encoder = new TextEncoder();
const hex = (bytes) => Array.from(new Uint8Array(bytes),(byte)=>byte.toString(16).padStart(2,"0")).join("");
const digest = async (value) => hex(await crypto.subtle.digest("SHA-256",encoder.encode(value)));

function equalHash(left,right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index=0;index<left.length;index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function workspaceLogin({input,fail,noStore,resolveOwner,required=false,password,signingKey}) {
  const configured = required && Boolean(password && signingKey?.length >= 32);
  const key = configured
    ? crypto.subtle.importKey("raw",encoder.encode(signingKey),{name:"HMAC",hash:"SHA-256"},false,["sign"])
    : null;
  const verifier = configured ? digest(password) : null;
  const attempts = new Map();

  async function signature(owner,expiry) {
    return hex(await crypto.subtle.sign("HMAC",await key,
      encoder.encode(`edubridge-workspace-v1\n${owner}\n${expiry}\n${await verifier}`)));
  }

  async function authorized(request) {
    if (!configured) return false;
    const value = request.headers.get(accessHeader);
    const match = value?.match(/^(\d{10})\.([0-9a-f]{64})$/);
    if (!match || Number(match[1]) <= Math.floor(Date.now()/1000)) return false;
    const owner = await resolveOwner(request);
    return Boolean(owner && equalHash(await signature(owner,match[1]),match[2]));
  }

  const reply = (body) => Response.json(body,{headers:noStore});

  function rateLimit(owner) {
    const minute = Math.floor(Date.now()/60_000);
    for (const [id,bucket] of attempts) if (bucket.minute < minute) attempts.delete(id);
    const total = attempts.get("all") ?? {minute,count:0};
    const current = attempts.get(owner) ?? {minute,count:0};
    if (total.count >= 120 || current.count >= 8) fail("login_rate_limited",429);
    attempts.set("all",{minute,count:total.count+1});
    attempts.set(owner,{minute,count:current.count+1});
  }

  return async (path,request) => {
    if (path === "/api/auth/status" && request.method === "GET") {
      return reply({required,configured,authenticated:required && await authorized(request)});
    }
    if (path === "/api/auth/login" && request.method === "POST") {
      const site = request.headers.get("sec-fetch-site");
      if (site && !["same-origin","none"].includes(site)) fail("login_wrong_origin",403);
      if (!configured) fail("login_not_configured",503);
      const owner = await resolveOwner(request);
      if (!owner) fail("session_required",401);
      rateLimit(owner);
      const body = await input(request);
      const candidate = typeof body?.password === "string" && body.password.length <= 128 ? body.password : "";
      const correct = equalHash(await digest(candidate),await verifier);
      if (!correct || body?.username !== "EduBridge") fail("login_bad_credentials",401);
      attempts.delete(owner);
      const expiry = Math.floor(Date.now()/1000) + lifetime;
      return reply({token:`${expiry}.${await signature(owner,expiry)}`});
    }
    if (required && !await authorized(request)) fail("login_required",401);
    return null;
  };
}
