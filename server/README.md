# Run FORMA on Kaggle

`forma_server_kaggle.py` is designed to be pasted into a single Kaggle notebook cell. It preserves Kaggle's installed CUDA/Torch packages, uses pinned Transformers/PEFT versions, removes a broken optional torchvision installation if detected, loads Qwen2.5-VL through Transformers, launches an authenticated FastAPI server, creates a tunnel, and prints the API URL and random token.

## Notebook setup

1. Create a notebook with the two-T4 GPU accelerator.
2. Download the adapter from Hugging Face to `/kaggle/working/forma-lora-final` in a separate cell before starting the server. For a private repo, add a Kaggle secret named `HF_TOKEN` for the download cell.
3. Paste the complete Python file into one notebook cell and run it. Optional settings: `FORMA_ADAPTER_PATH`, `FORMA_BASE_MODEL`, `FORMA_MAX_NEW_TOKENS`, and `FORMA_REQUEST_TIMEOUT`.
4. Cloudflare quick tunnel is attempted first. If it cannot create a tunnel, add `NGROK_AUTHTOKEN` under Kaggle notebook secrets and rerun.
5. Keep the cell running. Kaggle runtime sessions are time-limited and the URL changes on restart.

The inference path loads the official `Qwen/Qwen2.5-VL-7B-Instruct` checkpoint using bitsandbytes NF4 4-bit quantization with fp16 compute, then attaches the FORMA LoRA adapter. Quantization happens during loading; it does not use the separate pre-quantized Unsloth checkpoint that previously triggered a `LinearFP4` state assertion. This reduces the model's weight memory to leave room for attention activations on Kaggle's two T4 GPUs. Images are resized to 512px. It uses `apply_chat_template(tokenize=False)`, `qwen_vl_utils.process_vision_info`, processor tensor construction, generation (capped at 1200 new tokens), and decodes only new tokens. It deliberately does not install Unsloth or vLLM because the reported Kaggle runtime's Torch/CUDA versions conflict with those wheels.

If the notebook has already run the previous unpinned install cell, restart the Kaggle session before running the updated cell. The old cell replaced Kaggle's Torch/CUDA stack and installed incompatible Transformers/vLLM builds.

## API

- `GET /health` — requires the bearer token.
- `POST /v1/chat/completions` — OpenAI-compatible single-turn audit with base64 `image_url` content; example model name is `forma`.
- `POST /v1/audit` — convenience JSON API; accepts `image_base64`, `devtools`, and optional `user_prompt`, returns `raw`, `parsed`, and `schema_valid`.

All endpoints require `Authorization: Bearer <TOKEN>`. Remote image URLs are rejected to prevent server-side arbitrary URL fetching. CORS is not enabled; requests are serialized with a single generation slot and limited per client IP. Output is checked against the audit schema and retried once at lower temperature if parsing fails.

Example health check:

```sh
curl -H 'Authorization: Bearer YOUR_TOKEN' https://YOUR_TUNNEL/health
```

Treat the token like a password. Do not paste it into public notebooks, source control, or shared logs.
