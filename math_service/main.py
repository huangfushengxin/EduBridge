"""Private FastAPI endpoint. A bounded isolated process owns each SymPy check."""
import hmac
import json
import multiprocessing as mp
import os
import threading

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from math_service.verifier import verify_batch


app = FastAPI(title="EduBridge 数学验证", docs_url=None, redoc_url=None, openapi_url=None)
POOL = threading.BoundedSemaphore(2)
MAX_BODY = 24000
TIMEOUT_SECONDS = 7


def solve_in_worker(claims, sender):
    try:
        sender.send(verify_batch(claims))
    finally:
        sender.close()


def bounded_verify(claims):
    if not POOL.acquire(blocking=False):
        return {"status": "timeout", "code": "math_capacity"}
    try:
        ctx = mp.get_context("spawn")
        receive, send = ctx.Pipe(duplex=False)
        worker = ctx.Process(target=solve_in_worker, args=(claims, send), daemon=True)
        with receive, send:
            worker.start()
            send.close()
            try:
                if not receive.poll(TIMEOUT_SECONDS):
                    return {"status": "timeout", "code": "math_timeout"}
                return receive.recv()
            except EOFError:
                return {"status": "unsupported", "code": "math_worker_unavailable"}
            finally:
                worker.join(0.2)
                if worker.is_alive():
                    worker.kill()
                    worker.join()
                worker.close()
    finally:
        POOL.release()


@app.get("/health")
def health():
    return {"ok": True, "service": "edubridge-math"}


@app.post("/verify")
async def verify(request: Request):
    token = os.environ.get("MATH_VERIFY_TOKEN", "")
    if len(token) < 32:
        raise HTTPException(503, "math_not_configured")
    provided = request.headers.get("authorization", "")
    if len(provided) > 600 or not hmac.compare_digest(provided.encode(), ("Bearer " + token).encode()):
        raise HTTPException(401, "unauthorized")
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > MAX_BODY:
            raise HTTPException(413, "payload_too_large")
        data.extend(chunk)
    try:
        payload = json.loads(data)
    except (ValueError, RecursionError):
        return {"status": "unsupported", "code": "invalid_json"}
    claims = payload.get("claims") if isinstance(payload, dict) else None
    if not isinstance(claims, list) or not 1 <= len(claims) <= 3:
        return {"status": "unsupported", "code": "claim_count_unsupported"}
    return await run_in_threadpool(bounded_verify, claims)
