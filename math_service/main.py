"""Private FastAPI endpoint. A bounded isolated process owns each SymPy check."""
import hmac
import json
import multiprocessing as mp
import os
from contextlib import asynccontextmanager
from queue import Empty, Queue
from time import monotonic

from fastapi import FastAPI, HTTPException, Request
from starlette.concurrency import run_in_threadpool

from math_service.verifier import verify_batch


MAX_BODY = 24000
TIMEOUT_SECONDS = 7
STARTUP_SECONDS = 7
SLOTS = Queue()
for _ in range(2):
    SLOTS.put(None)


def solve_in_worker(connection):
    with connection:
        connection.send("ready")
        while True:
            try:
                claims = connection.recv()
            except EOFError:
                return
            connection.send(verify_batch(claims))


def stop_worker(slot):
    if slot is None:
        return
    worker, connection = slot
    connection.close()
    if worker.is_alive():
        worker.kill()
    worker.join()
    worker.close()


def start_worker():
    ctx = mp.get_context("spawn")
    parent, child = ctx.Pipe()
    worker = ctx.Process(target=solve_in_worker, args=(child,), daemon=True)
    with child:
        try:
            worker.start()
        except (OSError, RuntimeError):
            parent.close()
            worker.close()
            raise
    return worker, parent


def bounded_verify(claims):
    try:
        slot = SLOTS.get_nowait()
    except Empty:
        return {"status": "timeout", "code": "math_capacity"}
    reusable = False
    try:
        if slot is not None and not slot[0].is_alive():
            stop_worker(slot)
            slot = None
        if slot is None:
            started = monotonic()
            slot = start_worker()
            connection = slot[1]
            if not connection.poll(max(0, STARTUP_SECONDS - (monotonic() - started))) or connection.recv() != "ready":
                return {"status": "unsupported", "code": "math_worker_unavailable"}
        connection = slot[1]
        connection.send(claims)
        if not connection.poll(TIMEOUT_SECONDS):
            return {"status": "timeout", "code": "math_timeout"}
        result = connection.recv()
        reusable = True
        return result
    except (EOFError, OSError, RuntimeError):
        return {"status": "unsupported", "code": "math_worker_unavailable"}
    finally:
        try:
            if not reusable:
                stop_worker(slot)
        finally:
            SLOTS.put(slot if reusable else None)


@asynccontextmanager
async def lifespan(_app):
    yield
    # ASGI finishes in-flight requests before shutdown.
    for _ in range(2):
        stop_worker(SLOTS.get_nowait())
        SLOTS.put(None)


app = FastAPI(title="EduBridge 数学验证", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)


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
