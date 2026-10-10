# FORMA Kaggle server. Paste this entire file into ONE Kaggle notebook cell and run it.
# Download the adapter to /kaggle/working/forma-lora-final before running this cell.
# Optional Kaggle secret: NGROK_AUTHTOKEN.
import os, sys, subprocess, time, secrets, threading, asyncio, json, re, base64, io, logging, urllib.request, urllib.error
from collections import defaultdict, deque
from pathlib import Path

def install(*packages): subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", *packages])

install("huggingface-hub>=1.16.0,<2.0.0", "transformers>=5.0.0", "peft>=0.14.0", "accelerate>=1.2.0", "bitsandbytes>=0.45.0", "pillow", "qwen-vl-utils", "anyio==4.8.0", "starlette>=0.40.0,<0.47.0", "fastapi>=0.115.0", "uvicorn>=0.34.0")
import torch
# This server uses the Qwen PIL image processor and does not need torchvision.
# The logged Kaggle image has a broken torchvision binary (missing torchvision::nms).
try:
    import torchvision
    from torchvision.ops import nms as _torchvision_nms
except Exception:
    subprocess.run([sys.executable, "-m", "pip", "uninstall", "-y", "torchvision"], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for module_name in list(sys.modules):
        if module_name == "torchvision" or module_name.startswith("torchvision."):
            del sys.modules[module_name]
    print("Removed broken optional torchvision; Transformers will use its PIL image path.")
from PIL import Image
from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse
import uvicorn

HOST="0.0.0.0"; PORT=8000
# Keep the official base checkpoint; quantize it during loading. Do not use the
# pre-quantized Unsloth repo, which previously triggered a LinearFP4 state error.
BASE_ID=os.environ.get("FORMA_BASE_MODEL", "Qwen/Qwen2.5-VL-7B-Instruct")
if "bnb-4bit" in BASE_ID.lower():
    print("Ignoring the pre-quantized bnb base; using the official Qwen fp16 checkpoint and quantizing it during load.")
    BASE_ID="Qwen/Qwen2.5-VL-7B-Instruct"
ADAPTER=os.environ.get("FORMA_ADAPTER_PATH", "/kaggle/working/forma-lora-final")
if not Path(ADAPTER, "adapter_config.json").exists():
    candidates=list(Path("/kaggle/working").glob("**/adapter_config.json"))
    if candidates:
        candidates.sort(key=lambda p:("final" not in str(p.parent).lower(),"checkpoint" in str(p.parent).lower(),str(p)))
        ADAPTER=str(candidates[0].parent)
if not Path(ADAPTER, "adapter_config.json").exists():
    raise FileNotFoundError("Adapter files not found under /kaggle/working. Download the adapter to /kaggle/working/forma-lora-final first, or set FORMA_ADAPTER_PATH to its directory.")
TOKEN=secrets.token_urlsafe(36)
MAX_NEW_TOKENS=min(1200, max(1, int(os.environ.get("FORMA_MAX_NEW_TOKENS", "1200"))))
REQUEST_TIMEOUT=int(os.environ.get("FORMA_REQUEST_TIMEOUT", "300"))
MAX_IMAGE_SIDE=512
MODEL=None; PROCESSOR=None
QUEUE=asyncio.Semaphore(1)
RATE=defaultdict(deque)
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s forma-server %(message)s")
log=logging.getLogger("forma")

app=FastAPI(title="FORMA OpenAI-compatible server", docs_url=None, redoc_url=None)

def fit_image(image):
    image=image.convert("RGB")
    image.thumbnail((MAX_IMAGE_SIDE, MAX_IMAGE_SIDE), Image.Resampling.LANCZOS)
    return image

def image_from_url(value):
    if isinstance(value, dict): value=value.get("url", "")
    if not isinstance(value, str): raise ValueError("image_url must contain a data URL or URL")
    if value.startswith("data:"):
        try: value=value.split(",",1)[1]; raw=base64.b64decode(value, validate=True)
        except Exception as e: raise ValueError("Malformed base64 image data URL") from e
        return fit_image(Image.open(io.BytesIO(raw)))
    # Prevent the public model endpoint from being used as an arbitrary URL fetcher.
    raise ValueError("Only base64 data:image/... URLs are accepted")

def extract_user(messages):
    if not messages: raise ValueError("messages must include the user message")
    msg=messages[-1]
    parts=msg.get("content", "")
    text=[]; images=[]
    if isinstance(parts, str): text.append(parts)
    elif isinstance(parts, list):
        for p in parts:
            if p.get("type")=="text": text.append(p.get("text", ""))
            elif p.get("type")=="image_url": images.append(image_from_url(p.get("image_url")))
    else: raise ValueError("message content must be text or an array of text/image_url parts")
    if not images: raise ValueError("FORMA requires at least one image_url in the user message")
    return "\n".join(text), images

def load_runtime_model():
    global MODEL, PROCESSOR
    # Keep Kaggle's preinstalled CUDA/Torch stack intact; avoid Unsloth/vLLM installs here.
    from transformers import AutoProcessor, BitsAndBytesConfig, Qwen2_5_VLForConditionalGeneration
    from peft import PeftModel
    PROCESSOR=AutoProcessor.from_pretrained(BASE_ID, trust_remote_code=True)
    if not torch.cuda.is_available():
        raise RuntimeError("Kaggle GPU is unavailable. Enable the GPU accelerator and restart the session.")
    gpu_count=torch.cuda.device_count()
    if gpu_count < 2:
        raise RuntimeError("FORMA fp16 serving expects Kaggle's two-T4 GPU accelerator. Select GPU x2 and restart the session.")
    # Quantize the official weights at load time to leave VRAM for visual and
    # language attention activations on the two 16 GB Kaggle T4s.
    quantization_config=BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.float16,
        bnb_4bit_use_double_quant=True,
    )
    max_memory={0:"12GiB",1:"12GiB"}
    torch.cuda.empty_cache()
    base=Qwen2_5_VLForConditionalGeneration.from_pretrained(
        BASE_ID,
        torch_dtype=torch.float16,
        quantization_config=quantization_config,
        device_map="auto",
        max_memory=max_memory,
        low_cpu_mem_usage=True,
        attn_implementation="sdpa",
    )
    used_map=getattr(base,"hf_device_map",{})
    if any(str(device) in {"cpu","disk","meta"} for device in used_map.values()):
        raise RuntimeError(f"Model placement used CPU/disk offload: {used_map}. Restart Kaggle to free both T4s and retry.")
    MODEL=PeftModel.from_pretrained(base, ADAPTER, is_trainable=False, low_cpu_mem_usage=False).eval()
    # The Hub checkpoint advertises a long generation max_length. FORMA's
    # trained response budget is ~1200 new tokens; use that explicitly.
    if getattr(MODEL, "generation_config", None) is not None:
        MODEL.generation_config.max_length=20
        MODEL.generation_config.max_new_tokens=MAX_NEW_TOKENS
    log.info("Serving official Qwen2.5-VL with on-load NF4 4-bit weights, fp16 compute + FORMA PEFT; Torch=%s CUDA=%s GPUs=%s device_map=%s", torch.__version__, torch.version.cuda, gpu_count, used_map)

def run_transformers(prompt, images, temperature):
    from qwen_vl_utils import process_vision_info
    content=[{"type":"image", "image":img} for img in images]+[{"type":"text", "text":prompt}]
    messages=[{"role":"user", "content":content}]
    rendered=PROCESSOR.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    image_inputs, video_inputs=process_vision_info(messages)
    inputs=PROCESSOR(text=[rendered], images=image_inputs, videos=video_inputs, padding=True, return_tensors="pt")
    device=MODEL.get_input_embeddings().weight.device
    inputs={k:(v.to(device) if hasattr(v,"to") else v) for k,v in inputs.items()}
    with torch.inference_mode():
        generation_kwargs={"max_new_tokens":MAX_NEW_TOKENS,"do_sample":temperature>0,"use_cache":True}
        if temperature>0:
            generation_kwargs["temperature"]=max(0.05,temperature)
        output=MODEL.generate(**inputs, **generation_kwargs)
    new_tokens=output[:, inputs["input_ids"].shape[1]:]
    return PROCESSOR.batch_decode(new_tokens, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]

def parse_audit(raw):
    raw=re.sub(r"<think>\s*<think>", "<think>", raw, count=1, flags=re.I)
    match=re.search(r"\{[\s\S]*\}", raw)
    if not match: raise ValueError("No JSON object in model response")
    data=json.loads(match.group(0))
    if not isinstance(data,dict): raise ValueError("Audit JSON must be an object")
    if not isinstance(data.get("issues"),list): raise ValueError("issues must be an array")
    required={"category","severity","element","evidence","detail","suggestion"}
    for i,item in enumerate(data["issues"]):
        if not isinstance(item,dict) or not required.issubset(item): raise ValueError(f"issues[{i}] missing required fields")
    score_keys={"accessibility","typography","hierarchy","color","spacing","element_sizing"}
    if not isinstance(data.get("scores"),dict) or not score_keys.issubset(data["scores"]): raise ValueError("scores missing required keys")
    if any(not isinstance(data["scores"][k],int) or not 0<=data["scores"][k]<=10 for k in score_keys): raise ValueError("scores must be integers from 0 to 10")
    if not isinstance(data.get("summary"),str) or not isinstance(data.get("page_type"),str): raise ValueError("summary and page_type must be strings")
    return data

def openai_response(content, model="forma", parsed=None):
    # raw/parsed are additive convenience fields; OpenAI-compatible clients use choices.
    content=re.sub(r"<think>\s*<think>", "<think>", content, count=1, flags=re.I)
    return {"id":"chatcmpl-"+secrets.token_hex(12),"object":"chat.completion","created":int(time.time()),"model":model,"choices":[{"index":0,"message":{"role":"assistant","content":content},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0},"raw":content,"parsed":parsed}

async def generate(prompt, images, temperature=0.2):
    try: await asyncio.wait_for(QUEUE.acquire(),timeout=REQUEST_TIMEOUT)
    except asyncio.TimeoutError: raise asyncio.TimeoutError("Timed out while waiting for the single inference slot")
    try:
        return await asyncio.wait_for(asyncio.to_thread(run_transformers,prompt,images,temperature),timeout=REQUEST_TIMEOUT)
    finally: QUEUE.release()

def img_to_jpeg(image):
    out=io.BytesIO(); image.save(out,"JPEG",quality=90); return out.getvalue()

class SecurityAndRateLimitMiddleware:
    """Pure ASGI middleware; avoids Starlette BaseHTTPMiddleware/AnyIO TaskGroup."""
    def __init__(self, asgi_app):
        self.app=asgi_app

    async def __call__(self, scope, receive, send):
        if scope["type"]!="http":
            await self.app(scope,receive,send)
            return
        headers=dict(scope.get("headers",[]))
        authorization=headers.get(b"authorization",b"").decode("utf-8",errors="ignore")
        if authorization!="Bearer "+TOKEN:
            response=JSONResponse({"error":"unauthorized"},status_code=401)
            await response(scope,receive,send)
            return
        client=scope.get("client")
        ip=client[0] if client else "unknown"
        now=time.monotonic(); recent=RATE[ip]
        while recent and now-recent[0]>60: recent.popleft()
        if len(recent)>=30:
            response=JSONResponse({"error":"rate limit exceeded"},status_code=429)
            await response(scope,receive,send)
            return
        recent.append(now)
        await self.app(scope,receive,send)

app.add_middleware(SecurityAndRateLimitMiddleware)

@app.get("/health")
async def health(): return {"status":"ok","model":"forma","adapter":Path(ADAPTER).name,"backend":"transformers-nf4-4bit","max_image_side":MAX_IMAGE_SIDE,"max_new_tokens":MAX_NEW_TOKENS}

@app.post("/v1/chat/completions")
async def chat(request: Request):
    body=await request.json(); messages=body.get("messages",[])
    try: prompt,images=extract_user(messages)
    except Exception as e: raise HTTPException(400,str(e))
    temperature=float(body.get("temperature",0.2)); started=time.monotonic()
    try:
        raw=await generate(prompt,images,temperature)
        raw=re.sub(r"<think>\s*<think>", "<think>", raw, count=1, flags=re.I)
        try: parsed=parse_audit(raw)
        except Exception:
            raw=await generate(prompt,images,0.05)
            raw=re.sub(r"<think>\s*<think>", "<think>", raw, count=1, flags=re.I)
            try: parsed=parse_audit(raw)
            except Exception: parsed=None
        return openai_response(raw,body.get("model","forma"),parsed)
    except asyncio.TimeoutError: raise HTTPException(504,"FORMA generation timed out; Kaggle GPU may be overloaded or idle.")
    except Exception as e: log.exception("generation failed after %.1fs",time.monotonic()-started); raise HTTPException(503,"Model generation failed. Check the Kaggle notebook output and restart the session if needed.")

@app.post("/v1/audit")
async def audit(request: Request):
    body=await request.json()
    try:
        img=fit_image(Image.open(io.BytesIO(base64.b64decode(body["image_base64"],validate=True))))
        devtools=body.get("devtools",{})
        prompt=body.get("user_prompt")
        if not prompt:
            prompt="You are a professional UI/UX auditor. Analyze the attached website screenshot and produce a structured audit. First reason about it step by step inside a think block, then output the final JSON report as specified in your instructions."
            prompt += "\n\nBrowser context (measured, authoritative — trust these over visual estimates):\n"+json.dumps(devtools,ensure_ascii=False)
        raw=await generate(prompt,[img],float(body.get("temperature",0.2)))
        try: parsed=parse_audit(raw)
        except Exception as first_error:
            retry=await generate(prompt,[img],0.05)
            try: parsed=parse_audit(retry); raw=retry
            except Exception: return {"raw":raw,"parsed":None,"schema_valid":False,"error":str(first_error)[:300]}
        return {"raw":raw,"parsed":parsed,"schema_valid":True}
    except asyncio.TimeoutError: raise HTTPException(504,"Audit timed out.")
    except HTTPException: raise
    except Exception as e: raise HTTPException(400,str(e)[:400])

def wait_http(url, timeout=300, headers=None):
    end=time.time()+timeout
    while time.time()<end:
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=3) as r:
                if r.status==200: return True
        except urllib.error.HTTPError as e:
            body=e.read().decode("utf-8",errors="replace")[:1000]
            raise RuntimeError(f"FORMA health endpoint returned HTTP {e.code}: {body}") from e
        except Exception: time.sleep(3)
    return False

def open_tunnel():
    global TOKEN
    # Cloudflare quick tunnel is primary and needs no account. The random bearer token remains mandatory.
    try:
        subprocess.run(["bash","-lc","command -v cloudflared >/dev/null || (wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -O /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared)"],check=True)
        proc=subprocess.Popen(["cloudflared","tunnel","--url",f"http://127.0.0.1:{PORT}","--no-autoupdate"],stdout=open("/kaggle/working/cloudflared.log","w"),stderr=subprocess.STDOUT)
        for _ in range(90):
            try:
                text=Path("/kaggle/working/cloudflared.log").read_text(errors="ignore")
                match=re.search(r"https://[a-z0-9-]+\.trycloudflare\.com",text)
                if match:return match.group(0),proc
            except:pass
            time.sleep(1)
        proc.terminate();raise RuntimeError("cloudflared did not produce a public URL")
    except Exception as primary:
        log.warning("Cloudflare quick tunnel failed: %s",str(primary)[:250])
    # Optional fallback. Kaggle secret is preferred; environment variable also works.
    ngrok_token=os.environ.get("NGROK_AUTHTOKEN")
    try:
        from kaggle_secrets import UserSecretsClient
        ngrok_token=ngrok_token or UserSecretsClient().get_secret("NGROK_AUTHTOKEN")
    except Exception:pass
    if not ngrok_token:raise RuntimeError("Both tunnel setup paths failed. Add the Kaggle secret NGROK_AUTHTOKEN and rerun.")
    install("pyngrok")
    from pyngrok import ngrok
    ngrok.set_auth_token(ngrok_token); tunnel=ngrok.connect(PORT,"http"); return tunnel.public_url,None

print("Loading FORMA NF4 4-bit model with fp16 compute and LoRA adapter...")
print("PyTorch:", torch.__version__, "CUDA:", torch.version.cuda, "GPU count:", torch.cuda.device_count())
load_runtime_model()

config=uvicorn.Config(app,host=HOST,port=PORT,log_level="info",access_log=False,timeout_keep_alive=30)
http_server=uvicorn.Server(config)
threading.Thread(target=http_server.run,daemon=True).start()
if not wait_http(f"http://127.0.0.1:{PORT}/health",timeout=600,headers={"Authorization":"Bearer "+TOKEN}): raise RuntimeError("API startup failed. Review the cell output above.")
public_url,tunnel_proc=open_tunnel()
print("\n"+"="*72)
print("FORMA API IS READY")
print("URL:   "+public_url)
print("TOKEN: "+TOKEN)
print("OpenAI base URL: "+public_url+"/v1")
print("Model name: forma")
print("Example: curl -H 'Authorization: Bearer TOKEN' "+public_url+"/v1/chat/completions ...")
print("Keep this notebook running. URL changes after restart; Kaggle sessions are time-limited.")
print("="*72+"\n")
while True:
    time.sleep(300)
    try:print(time.strftime("FORMA heartbeat %Y-%m-%d %H:%M:%S UTC"),"backend=transformers-nf4-4bit","alive=",http_server.started)
    except Exception:pass
