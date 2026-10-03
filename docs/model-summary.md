# FORMA model summary

FORMA is a single-turn visual UI/UX audit adapter based on `unsloth/Qwen2.5-VL-7B-Instruct-bnb-4bit`. It uses a rank-16 LoRA adapter (alpha 32) trained for two epochs on language layers while the vision encoder was frozen. Training examples pair a website screenshot, resized to a maximum side of 512 px, with the dataset's audit prompt and measured browser context. The model returns a `<think>` section followed by a structured JSON report containing issues, six scores, a summary, and a page type.

## Intended use

Use it to generate preliminary, evidence-oriented visual UI/UX audit reports that a developer can review alongside browser measurements. In Forma it is a specialist tool called by a separate coding model.

## Limits

The adapter was not trained to call tools, edit code, browse independently, or operate as an agent orchestrator. It can miss visual issues, make inaccurate estimates, or repeat generic recommendations. Its reports are not accessibility certification or a substitute for human review, real assistive-technology testing, or automated audits. The reported 20-row internal smoke evaluation is too small and not independent; do not present it as a validated quality benchmark.

## Reproducibility notes

Use the matching base model and preserve the training prompt structure. Inference screenshots are capped at 512 px; use overlapping tiles for close inspection. The original dataset rows and labels are retained locally during the current build. Redistribution of third-party website screenshots has not been established.
