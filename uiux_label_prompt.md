# TASK: Label UI/UX audit dataset

You are a labeling agent. Your job: iterate over every entry in `dataset/entries.jsonl`
where `label` is null, open the image at `dataset/images/<image_path>` with your vision
capability, apply the audit rubric below, and APPEND one JSON line per entry to
`dataset/labels.jsonl`. Do not skip, do not duplicate ids, process entries in order.
Work in batches of ~10; after each batch, verify the JSONL is valid (each line parses).

For each entry produce: {"id": <id>, "reasoning": "<think text>", "answer": <report JSON>}

## REASONING (the think block) — STRICT RULES
- 150–300 words. Written as short numbered steps, ALWAYS in this exact order:
  1. LAYOUT: describe the page structure, sections, and element inventory.
  2. TYPOGRAPHY: font sizes/weights, type-scale ratio, line length, line height.
  3. COLOR & CONTRAST: estimate foreground/background colors (hex if possible),
     compute rough WCAG contrast ratio (4.5:1 normal text, 3:1 large text/UI).
  4. HIERARCHY & SPACING: visual weight of primary/secondary/tertiary elements,
     8pt-grid consistency, alignment, margins, padding.
  5. ACCESSIBILITY & SIZING: touch-target sizes (~44x44px), affordances, text
     legibility, color-only meaning, placeholder-only labels.
  6. VERDICT: rank the 3-8 most important issues found.
- Be concrete: reference actual elements and estimated measurements. No filler.
- If the screenshot is genuinely well-designed, say so and list only minor issues.

## ANSWER (the final report) — this JSON schema, no extra prose:
{
  "issues": [
    {
      "category": "accessibility | typography | contrast | hierarchy | color |
                  spacing | alignment | element_size | consistency | imagery | other",
      "severity": "critical | moderate | minor",
      "element": "<the UI element affected>",
      "evidence": "<what is observed, with estimated values/colors>",
      "detail": "<why it is a problem, cite the rule (e.g. WCAG AA 4.5:1)>",
      "suggestion": "<how to fix — describe visually, DO NOT write code>"
    }
  ],
  "scores": {                     // 0-10 integers
    "accessibility": 0, "typography": 0, "hierarchy": 0,
    "color": 0, "spacing": 0, "element_sizing": 0
  },
  "summary": "<2-3 sentence overall assessment>",
  "page_type": "<landing | dashboard | e-commerce | form | article | mobile-app | other>"
}

## SEVERITY RULES
- critical: blocks usability (unreadable contrast, unfindable CTA, overlapping text)
- moderate: violates a clear heuristic (inconsistent spacing, >3 font families,
  touch targets < 40px, weak hierarchy between primary/secondary actions)
- minor: polish issues (slightly off-grid, heavy visual noise, dated styling)

## CATEGORY RUBRIC (checklist to reason through)
- Accessibility: contrast ratios, text size <12px, touch-target size, color-only
  status meaning, icon-only buttons without visible labels, low focus affordance.
- Typography: type-scale consistency (ideal ratios ~1.25 major third / 1.333),
  max 2 font families, line height 1.4–1.6 for body, line length 50–75 chars,
  ALL-CAPS long text, underlined non-links.
- Hierarchy: is the primary CTA visually dominant? 3+ clear levels of visual
  weight? does content follow logical reading order? competing focal points?
- Color: palette coherence (≤1 primary +1 accent), conflicting saturated colors,
  garish gradients, colors inconsistent with brand tone, contrast of text on images.
- Spacing/Alignment: 8pt grid violations, inconsistent margins between sections,
  orphaned elements, cramped or excessive whitespace.
- Element size: buttons < 40px tall, inputs < 40px, unreadable caption text,
  oversized hero text on small crops, icons vs text mismatch.
- Consistency: mixed border radii, mixed button styles, inconsistent date/case
  formatting visible in text.

## HARD CONSTRAINTS
- NEVER write code, CSS, or HTML in any field. Suggestions are visual descriptions.
- 3–8 issues per screenshot (fewer only if truly well-designed).
- Do not invent elements you cannot see. If the crop cuts an element off, audit
  only what is visible and note it in reasoning step 1.
- `entries.jsonl` has an `augmentation` field; use it only as a hint that defects
  were injected — still audit only what you actually observe.
