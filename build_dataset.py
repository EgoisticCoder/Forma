# build_dataset.py — run after the CLI labeling agent finishes
import json
import random
from pathlib import Path

root = Path("dataset")
entries_path = root / "entries.jsonl"
labels_path = root / "labels.jsonl"

# Verify files exist before attempting ingestion
if not entries_path.exists() or not labels_path.exists():
    raise FileNotFoundError(f"Missing required source files: {entries_path} or {labels_path}")

entries, labels = {}, {}

# Ingest entries
with open(entries_path, "r", encoding="utf-8") as f:
    for line_num, line in enumerate(f, 1):
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
            entries[e["id"]] = e
        except (json.JSONDecodeError, KeyError) as err:
            print(f"[Warning] Skipping malformed entry at line {line_num}: {err}")

# Ingest labels
with open(labels_path, "r", encoding="utf-8") as f:
    for line_num, line in enumerate(f, 1):
        line = line.strip()
        if not line:
            continue
        try:
            l = json.loads(line)
            labels[l["id"]] = l
        except (json.JSONDecodeError, KeyError) as err:
            print(f"[Warning] Skipping malformed label at line {line_num}: {err}")

missing = [i for i in entries if i not in labels]
print(f"{len(entries)} entries | {len(labels)} labeled | {len(missing)} unlabeled (skipped)")

rows = []
for id_, e in entries.items():
    if id_ not in labels:
        continue

    l = labels[id_]

    devtools = e.get("devtools") or e.get("devtools_report")
    if "user_prompt" not in e or devtools is None:
        print(f"[Warning] Entry '{id_}' missing required keys. Skipping.")
        continue

    # Construct formatted user prompt injecting browser context
    user_text = (
        f"{e['user_prompt']}\n\n"
        f"Browser context (measured, authoritative — trust these over visual estimates):\n"
        f"{json.dumps(devtools, ensure_ascii=False)}"
    )

    # Format assistant response with CoT tags and ground-truth answer
    reasoning = l.get("reasoning", "").strip()
    assistant = (
        f"<think>\n{reasoning}\n</think>\n\n"
        + json.dumps(l["answer"], ensure_ascii=False)
    )

    rows.append({
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "image", "image": str(root / "images" / e.get("image_path", ""))},
                    {"type": "text", "text": user_text},
                ],
            },
            {"role": "assistant", "content": assistant},
        ]
    })

if not rows:
    raise ValueError("No valid rows assembled. Check source JSONL files.")

# Deterministic train/validation split
random.Random(123).shuffle(rows)
n_val = max(50, int(0.05 * len(rows))) if len(rows) > 50 else max(1, int(0.1 * len(rows)))

train_rows = rows[n_val:]
val_rows = rows[:n_val]

with open("train.jsonl", "w", encoding="utf-8") as f:
    f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in train_rows)

with open("validation.jsonl", "w", encoding="utf-8") as f:
    f.writelines(json.dumps(r, ensure_ascii=False) + "\n" for r in val_rows)

print(f"train={len(train_rows)}  validation={len(val_rows)}")
