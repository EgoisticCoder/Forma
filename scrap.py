"""
scrap.py — UI/UX audit dataset scraper with DevTools & Computed Metrics Collector

Usage:
    pip install playwright pillow
    playwright install chromium
    python scrap.py sites.txt --out dataset --max-per-site 8 --augment-prob 0.25

sites.txt: one URL per line. Lines starting with # are ignored.

Outputs:
    dataset/images/*.jpg          captured screenshots + section crops
    dataset/entries.jsonl         entries with multimodal prompts + devtools telemetry
    dataset/labels.jsonl          (empty file; CLI labeling agent fills this)

To enable axe-core, install the bundle locally and pass its path:
    npm install --no-save axe-core
    python scrap.py sites.txt --axe-script node_modules/axe-core/axe.min.js
"""
import argparse
import hashlib
import json
from pathlib import Path
import random
import re
import sys
import time

from PIL import Image
from playwright.sync_api import Page, sync_playwright

# ---------------------------------------------------------------- config
DESKTOP = {"width": 1440, "height": 900}
MOBILE = {"width": 390, "height": 844}
AUDIT_VIEWPORTS = [1920, 768, 390]

USER_PROMPT = (
    "You are a professional UI/UX auditor. Analyze the attached website screenshot "
    "and produce the structured audit specified by the labeling prompt. Use the "
    "entry's devtools telemetry, axe-core violations, network failures, and responsive "
    "measurements as supporting evidence. Explain only user-visible or user-impacting "
    "consequences; do not assume every console warning is a UX defect, and do not "
    "claim an axe violation is visually apparent unless the screenshot supports it. "
    "Provide a concise evidence summary rather than private chain-of-thought."
)

AUGMENTATIONS = {
    "low_contrast": "* { color: #b9b9b9 !important; text-shadow: none !important; }",
    "tiny_text": "body { font-size: 9px !important; }",
    "cramped_spacing": "body { letter-spacing: -1px !important; line-height: 1 !important; } * { margin: 0 !important; padding: 0 !important; }",
    "broken_hierarchy": "h1, h2, h3, h4, h5, h6 { font-size: 14px !important; font-weight: 400 !important; }",
    "flat_buttons": "button, a, [role='button'] { background: transparent !important; border: none !important; color: inherit !important; text-decoration: none !important; cursor: default !important; }",
}

RANDOM_CROPS = 2
MAX_SLICES = 2
JPG_QUALITY = 85
LOAD_TIMEOUT = 30_000
AXE_RULES = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]


def install_performance_observers(page: Page):
    """Start Core Web Vitals observers before navigation."""
    page.add_init_script("""(() => {
      window.__uxPerf = { lcp: 0, cls: 0, long_tasks: 0 };
      try { new PerformanceObserver(list => {
        for (const e of list.getEntries()) window.__uxPerf.lcp = e.startTime;
      }).observe({type: 'largest-contentful-paint', buffered: true}); } catch (_) {}
      try { new PerformanceObserver(list => {
        for (const e of list.getEntries()) if (!e.hadRecentInput) window.__uxPerf.cls += e.value;
      }).observe({type: 'layout-shift', buffered: true}); } catch (_) {}
      try { new PerformanceObserver(list => {
        window.__uxPerf.long_tasks += list.getEntries().length;
      }).observe({type: 'longtask', buffered: true}); } catch (_) {}
    })();""")


def run_axe_audit(page: Page, axe_script: Path | None) -> dict:
    """Inject a local axe-core bundle and retain concise, actionable violations."""
    if not axe_script:
        return {"status": "unavailable", "reason": "axe-core bundle not supplied; install axe-core and pass --axe-script"}
    try:
        page.add_script_tag(path=str(axe_script))
        return page.evaluate("""async (rules) => {
          const result = await window.axe.run(document, {runOnly: {type: 'tag', values: rules}});
          return {
            status: 'complete', passes: result.passes.length, incomplete: result.incomplete.length,
            violations: result.violations.map(v => ({
              id: v.id, impact: v.impact, help: v.help, help_url: v.helpUrl, tags: v.tags,
              affected_nodes: v.nodes.length,
              nodes: v.nodes.slice(0, 12).map(n => ({
                target: n.target, summary: n.failureSummary, html: n.html.slice(0, 240)
              }))
            }))
          };
        }""", AXE_RULES)
    except Exception as e:
        return {"status": "error", "reason": str(e)[:300]}


def format_audit_context(devtools: dict) -> str:
    """Render machine findings as bounded plain text alongside each image prompt."""
    lines = ["Machine-collected audit signals (use as evidence; assess their actual UX impact):"]
    axe = devtools.get("axe", {})
    lines.append(f"axe-core: {axe.get('status', 'unavailable')}")
    if axe.get("reason"):
        lines.append(f"axe-core note: {axe['reason']}")
    for violation in axe.get("violations", [])[:20]:
        lines.append(
            f"AXE {violation.get('impact', 'unknown')}: {violation.get('id')} — "
            f"{violation.get('help')} (affected nodes: {violation.get('affected_nodes', 0)})"
        )
        for node in violation.get("nodes", [])[:3]:
            target = ", ".join(map(str, node.get("target", [])))[:180]
            summary = re.sub(r"\s+", " ", node.get("summary") or "")[:320]
            lines.append(f"  target {target or '(not supplied)'}: {summary or 'see axe rule details'}")

    measured = devtools.get("measured", {})
    lines.append(
        "Lighthouse-style signals (not a Lighthouse score): "
        + json.dumps(measured.get("lighthouse_signals", {}), separators=(",", ":"))
    )
    lines.append(
        f"DOM accessibility measurements: {measured.get('images_missing_alt', 0)} images without alt text "
        f"out of {measured.get('total_images', 0)}; body text {measured.get('body_size', 'unknown')}px; "
        f"sampled tap targets: {json.dumps(measured.get('tap_targets', [])[:8], separators=(',', ':'))}"
    )
    responsive = devtools.get("responsive_overflow", {})
    overflow = {k: v for k, v in responsive.items() if k.startswith("overflow_x_")}
    lines.append(f"Horizontal overflow at 1920/768/390px: {json.dumps(overflow, separators=(',', ':'))}")

    console = devtools.get("console_errors", [])
    for item in console[:8]:
        lines.append(f"Console {item.get('type', 'message')}: {item.get('text', '')[:240]}")
    for error in devtools.get("page_crashes", [])[:5]:
        lines.append(f"Page error: {error[:240]}")
    for item in devtools.get("network_failures", [])[:8]:
        lines.append(
            f"Network failure ({item.get('resource_type', 'resource')}): "
            f"{item.get('url', '')[:180]} — {item.get('failure', '')[:120]}"
        )
    for item in devtools.get("http_errors", [])[:8]:
        lines.append(
            f"HTTP {item.get('status')}: {item.get('resource_type', 'resource')} "
            f"{item.get('url', '')[:180]}"
        )
    return "\n".join(lines)


def uid(url: str, tag: str) -> str:
    return f"{tag}_{hashlib.md5(url.encode()).hexdigest()[:8]}_{random.randint(0, 9999):04d}"


def load_urls(path: str) -> list[str]:
    urls = []
    for line in Path(path).read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if not re.match(r"^https?://", line):
            line = "https://" + line
        urls.append(line)
    return list(dict.fromkeys(urls))


def collect_devtools_report(
    page: Page, console_logs: list[dict], page_errors: list[str],
    failed_requests: list[dict], http_errors: list[dict], axe_script: Path | None,
) -> dict:
    """Gathers factual telemetry and DOM measurements that cannot be discerned from pixels alone."""
    report = {
        "console_errors": [log for log in console_logs if log["type"] in ("error", "warning")],
        "page_crashes": list(page_errors),
        "network_failures": list(failed_requests[:100]),
        "http_errors": list(http_errors[:100]),
    }

    try:
        # Measured DOM metrics
        report["measured"] = page.evaluate(
            """() => {
            const px = (el) => parseFloat(getComputedStyle(el).fontSize) || 0;
            const buttons = [...document.querySelectorAll("button, a, [role='button']")];
            const tap = buttons.slice(0, 15).map(b => {
                const r = b.getBoundingClientRect();
                return {
                    text: (b.innerText || b.getAttribute('aria-label') || "").trim().slice(0, 25),
                    w: Math.round(r.width),
                    h: Math.round(r.height)
                };
            });
            const body = document.body ? getComputedStyle(document.body) : null;
            return {
                body_font: body ? body.fontFamily.split(",")[0].replace(/['"]/g, "") : "unknown",
                body_size: document.body ? px(document.body) : 0,
                overflow_x: document.documentElement.scrollWidth > window.innerWidth,
                tap_targets: tap,
                images_missing_alt: [...document.images].filter(i => !i.alt).length,
                total_images: document.images.length,
                lighthouse_signals: (() => {
                    const nav = performance.getEntriesByType('navigation')[0];
                    const paints = Object.fromEntries(performance.getEntriesByType('paint')
                        .map(e => [e.name, Math.round(e.startTime)]));
                    const resources = performance.getEntriesByType('resource');
                    const perf = window.__uxPerf || {};
                    return {
                        fcp_ms: paints['first-contentful-paint'] ?? null,
                        lcp_ms: Math.round(perf.lcp || 0),
                        cls: Number((perf.cls || 0).toFixed(3)),
                        long_task_count: perf.long_tasks || 0,
                        dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
                        load_ms: nav && nav.loadEventEnd ? Math.round(nav.loadEventEnd) : null,
                        transfer_bytes: resources.reduce((n, r) => n + (r.transferSize || 0), 0),
                        resource_count: resources.length
                    };
                })(),
            };
        }"""
        )
    except Exception as e:
        report["measured"] = {"error": str(e)}

    try:
        # Active loaded web fonts
        report["fonts"] = page.evaluate(
            """() => {
            if (!document.fonts) return [];
            return [...new Set([...document.fonts].map(f => f.family.replace(/['"]/g, "")))];
        }"""
        )
    except Exception as e:
        report["fonts"] = []

    # Check horizontal scroll issues across desktop, tablet, and mobile break points
    responsive_overflow = {}
    orig_viewport = page.viewport_size or DESKTOP
    try:
        for width in AUDIT_VIEWPORTS:
            page.set_viewport_size({"width": width, "height": 800})
            page.wait_for_timeout(200)
            has_overflow = page.evaluate(
                "() => document.documentElement.scrollWidth > window.innerWidth"
            )
            responsive_overflow[f"overflow_x_{width}"] = bool(has_overflow)
            responsive_overflow[f"width_details_{width}"] = page.evaluate("""() => ({
                viewport_width: window.innerWidth,
                document_width: document.documentElement.scrollWidth,
                overflow_px: Math.max(0, document.documentElement.scrollWidth - window.innerWidth)
            })""")
    except Exception as e:
        responsive_overflow["error"] = str(e)
    finally:
        page.set_viewport_size(orig_viewport)

    report["responsive_overflow"] = responsive_overflow
    report["axe"] = run_axe_audit(page, axe_script)
    return report


def capture_page(
    page: Page, url: str, out_dir: Path, entries: list, aug_prob: float,
    axe_script: Path | None,
):
    console_logs = []
    page_errors = []
    failed_requests = []
    http_errors = []

    def on_console(msg):
        if msg.type in ("error", "warning"):
            console_logs.append({"type": msg.type, "text": msg.text[:300]})

    def on_pageerror(exc):
        page_errors.append(str(exc)[:300])

    def on_requestfailed(request):
        failed_requests.append({
            "url": request.url[:300],
            "method": request.method,
            "resource_type": request.resource_type,
            "failure": (request.failure or "unknown")[:200],
        })

    def on_response(response):
        if response.status >= 400:
            http_errors.append({
                "url": response.url[:300],
                "status": response.status,
                "resource_type": response.request.resource_type,
            })

    page.on("console", on_console)
    page.on("pageerror", on_pageerror)
    page.on("requestfailed", on_requestfailed)
    page.on("response", on_response)

    try:
        page.goto(url, timeout=LOAD_TIMEOUT, wait_until="domcontentloaded")
        page.wait_for_timeout(2500)

        # Consent banner dismissals
        for _ in range(3):
            for sel in [
                "button:has-text('Accept')",
                "button:has-text('Accept all')",
                "button:has-text('I agree')",
                "[aria-label*='close' i]",
            ]:
                try:
                    btn = page.locator(sel).first
                    if btn.is_visible(timeout=1000):
                        btn.click(timeout=1500)
                        page.wait_for_timeout(600)
                        break
                except Exception:
                    continue

        page.wait_for_timeout(1000)

        # Run pre-screenshot DevTools data collection
        devtools_data = collect_devtools_report(
            page, console_logs, page_errors, failed_requests, http_errors, axe_script
        )

        clean_name = re.sub(r"[^a-z0-9]+", "-", url.split("//")[-1])[:40]

        for vp_name, vp in [("desktop", DESKTOP), ("mobile", MOBILE)]:
            page.set_viewport_size(vp)
            page.evaluate("window.scrollTo(0, 0)")
            page.wait_for_timeout(1000)

            # 1. Full-page clean screenshot
            img_name = f"{clean_name}_{vp_name}_full.jpg"
            page.screenshot(
                path=str(out_dir / img_name),
                full_page=(vp_name == "desktop"),
                type="jpeg",
                quality=JPG_QUALITY,
            )
            entries.append(
                make_entry(url, img_name, vp_name, "full", None, devtools=devtools_data)
            )
            print(f"  + {img_name}")

            # 2. Section slices (Desktop)
            if vp_name == "desktop":
                body_h = page.evaluate("document.body.scrollHeight")
                for i in range(1, MAX_SLICES + 1):
                    y = int(body_h * (i / (MAX_SLICES + 1)))
                    page.evaluate(f"window.scrollTo(0, {y})")
                    page.wait_for_timeout(800)
                    n = f"{clean_name}_{vp_name}_slice{i}.jpg"
                    page.screenshot(path=str(out_dir / n), type="jpeg", quality=JPG_QUALITY)
                    entries.append(
                        make_entry(
                            url,
                            n,
                            vp_name,
                            "slice",
                            None,
                            devtools=devtools_data,
                            meta={"scroll_y": y},
                        )
                    )

            # 3. Augmented defect variants
            if random.random() < aug_prob:
                aug = random.choice(list(AUGMENTATIONS.keys()))
                page.add_style_tag(content=AUGMENTATIONS[aug])
                page.wait_for_timeout(600)
                n = f"{clean_name}_{vp_name}_aug_{aug}.jpg"
                page.screenshot(path=str(out_dir / n), type="jpeg", quality=JPG_QUALITY)
                entries.append(
                    make_entry(url, n, vp_name, "augmented", aug, devtools=devtools_data)
                )
                print(f"  + {n} (aug={aug})")

                page.evaluate(
                    """document.querySelectorAll('style').forEach(s => {
                        if (s.textContent.includes('!important')) s.remove();
                    })"""
                )
                page.wait_for_timeout(300)

        # 4. Random crops from full desktop render
        full_path = out_dir / f"{clean_name}_desktop_full.jpg"
        if full_path.exists():
            img = Image.open(full_path)
            for i in range(RANDOM_CROPS):
                w, h = img.size
                if w < 600 or h < 400:
                    break
                cw = random.randint(int(w * 0.55), int(w * 0.9))
                ch = random.randint(int(h * 0.35), int(h * 0.75))
                x = random.randint(0, max(w - cw, 0))
                y = random.randint(0, max(h - ch, 0))
                crop = img.crop((x, y, x + cw, y + ch))
                n = f"{clean_name}_crop{i}.jpg"
                crop.save(out_dir / n, "JPEG", quality=JPG_QUALITY)
                entries.append(
                    make_entry(
                        url,
                        n,
                        "desktop",
                        "crop",
                        None,
                        devtools=devtools_data,
                        meta={"crop_box": [x, y, x + cw, y + ch]},
                    )
                )
    except Exception as e:
        print(f"  ! failed: {url} -> {e}")
    finally:
        # Deregister listeners to avoid cross-page listener leakage
        try:
            page.remove_listener("console", on_console)
            page.remove_listener("pageerror", on_pageerror)
            page.remove_listener("requestfailed", on_requestfailed)
            page.remove_listener("response", on_response)
        except Exception:
            pass


def make_entry(url, img_name, viewport, capture, aug, devtools=None, meta=None):
    return {
        "id": uid(url, capture),
        "image_path": img_name,
        "source_url": url,
        "viewport": viewport,
        "capture": capture,
        "augmentation": aug,
        "devtools": devtools or {},
        "meta": meta or {},
        "user_prompt": USER_PROMPT + "\n\n" + format_audit_context(devtools or {}),
        "label": None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("sites_file")
    ap.add_argument("--out", default="dataset")
    ap.add_argument("--max-per-site", type=int, default=8)
    ap.add_argument("--augment-prob", type=float, default=0.25)
    ap.add_argument("--delay", type=float, default=2.0, help="politeness delay between sites (sec)")
    ap.add_argument(
        "--axe-script", type=Path,
        help="path to axe-core's axe.min.js (install with npm install --no-save axe-core)",
    )
    args = ap.parse_args()
    if args.axe_script and not args.axe_script.is_file():
        ap.error(f"axe-core script not found: {args.axe_script}")

    urls = load_urls(args.sites_file)
    if not urls:
        sys.exit("No URLs found in sites.txt")
    random.seed(42)

    out_root = Path(args.out)
    img_dir = out_root / "images"
    img_dir.mkdir(parents=True, exist_ok=True)

    entries = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        ctx = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            )
        )
        page = ctx.new_page()
        page.set_default_timeout(LOAD_TIMEOUT)
        install_performance_observers(page)

        for i, url in enumerate(urls, 1):
            print(f"[{i}/{len(urls)}] {url}")
            before = len(entries)
            capture_page(page, url, img_dir, entries, args.augment_prob, args.axe_script)
            added = len(entries) - before
            if added > args.max_per_site:
                del entries[-(added - args.max_per_site):]
            time.sleep(args.delay)
        browser.close()

    with open(out_root / "entries.jsonl", "w") as f:
        for e in entries:
            f.write(json.dumps(e) + "\n")
    (out_root / "labels.jsonl").touch()
    print(f"\nDone: {len(entries)} captures recorded -> {img_dir}")
    print("Entries file populated with visual telemetry and DevTools ground truth.")


if __name__ == "__main__":
    main()
