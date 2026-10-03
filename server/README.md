# Run FORMA on Kaggle

`forma_server_kaggle.py` is designed to be pasted into a single Kaggle notebook cell. It installs inference/server dependencies, can download the adapter from Hugging Face, can locate it in Kaggle inputs, tries the vLLM backends in priority order, falls back to a Qwen2.5-VL Transformers pipeline, launches an authenticated FastAPI server, creates a tunnel, and prints the API URL and random token.

## Notebook setup

1. Create a notebook with the two-T4 GPU accelerator.
2. For automatic Hugging Face download, set `FORMA_HF_REPO` to your model repo ID; for a private repo, add a Kaggle secret named `HF_TOKEN`. Alternatively, attach the adapter as a Kaggle input. The server searches `/kaggle/input/**/adapter_config.json` as a fallback.
3. Paste the complete Python file into one notebook cell and run it. Optional settings: `FORMA_HF_REPO`, `FORMA_ADAPTER_PATH`, `FORMA_BASE_MODEL`, `FORMA_MAX_NEW_TOKENS`, and `FORMA_REQUEST_TIMEOUT`.
4. Cloudflare quick tunnel is attempted first. If it cannot create a tunnel, add `NGROK_AUTHTOKEN` under Kaggle notebook secrets and rerun.
5. Keep the cell running. Kaggle runtime sessions are time-limited and the URL changes on restart.

## Backend ladder

The server logs each selected or failed path:

1. Load the corresponding Qwen2.5-VL base in fp16, merge the LoRA weights, then launch vLLM with tensor parallel size 2.
2. Launch vLLM with bnb-4bit plus the LoRA adapter.
3. Load with Unsloth `FastVisionModel`, or Transformers if Unsloth loading fails. It uses `apply_chat_template(tokenize=False)`, `qwen_vl_utils.process_vision_info`, processor tensor construction, generation, and decode of new tokens only.

Kaggle T4 GPUs use fp16, not bf16 or FlashAttention-2. The vLLM options have not been exercised on the actual Kaggle GPU environment in this workspace. The chosen runtime path must be confirmed in a Kaggle session before relying on it. Logs for vLLM attempts are written to `/kaggle/working/vllm.log`.

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
