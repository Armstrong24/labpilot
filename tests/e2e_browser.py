"""Headless end-to-end check of LabPilot in a real Chromium.

1. Demo mode: one click -> review -> download DOCX.
2. Live path with Gemini *intercepted*: upload a PDF/DOCX checklist + screenshots through the real
   file inputs, set a dummy key, click Analyze. Requests to generativelanguage.googleapis.com are
   answered from demo/demo-result.json by a Playwright route, so no key and no real API call is used.
   It verifies the request shape the app sends (store=false, JSON schema, inline images) and the
   retry path (first call returns 503).

Usage:  python3 -m http.server 8765 &   then   python3 tests/e2e_browser.py [--chromium /usr/bin/chromium]
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
BASE = os.environ.get("LABPILOT_URL", "http://localhost:8765/index.html")
CHROME = sys.argv[sys.argv.index("--chromium") + 1] if "--chromium" in sys.argv else os.environ.get("CHROMIUM", "/usr/bin/chromium")
OUT = os.environ.get("E2E_OUT", "/tmp/labpilot-e2e")
os.makedirs(OUT, exist_ok=True)
demo = json.load(open(os.path.join(ROOT, "demo/demo-result.json")))
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (" - " + detail if detail and not cond else ""))


async def demo_flow(browser):
    ctx = await browser.new_context(viewport={"width": 1366, "height": 800}, accept_downloads=True)
    pg = await ctx.new_page()
    errors = []
    pg.on("pageerror", lambda e: errors.append(str(e)))
    await pg.goto(BASE)
    await pg.click("#tryDemo")
    await pg.wait_for_selector("#panel2:not([hidden])", timeout=20000)
    chips = await pg.inner_text("#summary")
    check("demo: summary shows 2 missing", "2missing" in chips.replace(" ", "").replace("\n", ""), chips)
    warn = await pg.inner_text("#warnCard")
    check("demo: Step 12 missing warning", "Step 12: no screenshot" in warn, warn)
    # move the unrelated image into Step 1 and back, checking the report updates
    await pg.select_option('select[data-move="IMG4"]', "S1")
    await pg.wait_for_timeout(200)
    s1 = await pg.inner_text("#step-S1")
    s1_text = await pg.input_value('textarea[data-edit="S1"]')
    check("demo: manual move fills Step 1", "MISSING" not in s1 and "bubble_sort" in s1_text, s1_text[:200])
    await pg.select_option('#step-S1 select[data-move="IMG4"]', "NONE")
    await pg.fill('textarea[data-edit="S2"]', "Edited explanation for step two.")
    await pg.click("#toStep3")
    prev = await pg.inner_text("#preview")
    check("demo: preview carries the edit", "Edited explanation for step two." in prev)
    check("demo: preview has warnings page", "Missing Evidence and Review Notes" in prev)
    async with pg.expect_download() as dl:
        await pg.click("#downloadBtn")
    d = await dl.value
    path = os.path.join(OUT, d.suggested_filename)
    await d.save_as(path)
    check("demo: DOCX downloaded", os.path.getsize(path) > 50000, str(os.path.getsize(path)))
    check("demo: no page errors", not errors, "; ".join(errors))
    await ctx.close()


async def live_flow(browser, checklist_file):
    ctx = await browser.new_context(viewport={"width": 1280, "height": 800})
    pg = await ctx.new_page()
    errors, seen = [], {"observe": 0, "analyze": 0, "fail_once": True, "bodies": []}
    pg.on("pageerror", lambda e: errors.append(str(e)))
    name_to_demo = {i["file"]: i["id"] for i in demo["images"]}
    obs_by_id = {o["image_id"]: o for o in demo["observations"]}

    async def handle(route, request):
        body = json.loads(request.post_data or "{}")
        seen["bodies"].append(body)
        if seen["fail_once"]:
            seen["fail_once"] = False
            return await route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": {"message": "overloaded"}}))
        if "read screenshots" in (body.get("system_instruction") or ""):
            seen["observe"] += 1
            obs = []
            for part in body["input"]:
                if part.get("type") == "text" and part["text"].startswith("Image id "):
                    iid = part["text"].split(" ")[2]
                    fname = part["text"].split("(file: ", 1)[1].rsplit(")", 1)[0]
                    o = dict(obs_by_id[name_to_demo[fname]]); o["image_id"] = iid
                    obs.append(o)
            payload = {"observations": obs}
        else:
            seen["analyze"] += 1
            payload = demo["analysis"]
        resp = {"status": "completed", "steps": [{"type": "model_output", "content": [{"type": "text", "text": json.dumps(payload)}]}]}
        await route.fulfill(status=200, content_type="application/json", body=json.dumps(resp))

    await pg.route("https://generativelanguage.googleapis.com/**", handle)
    await pg.goto(BASE)
    await pg.set_input_files("#docInput", os.path.join(ROOT, "tests/fixtures", checklist_file))
    await pg.wait_for_function("document.querySelector('#parseStatus').textContent.includes('12 steps')", timeout=15000)
    check(f"live[{checklist_file}]: checklist parsed to 12 steps", True)
    files = [os.path.join(ROOT, "demo/screenshots", i["file"]) for i in demo["images"]]
    await pg.set_input_files("#imgInput", files)
    await pg.wait_for_function("document.querySelectorAll('#thumbs .thumb').length === 11", timeout=15000)
    await pg.evaluate("sessionStorage.setItem('labpilot.key', 'dummy-key-for-test')")
    await pg.click("#analyzeBtn")
    await pg.wait_for_selector("#panel2:not([hidden])", timeout=60000)
    check(f"live[{checklist_file}]: retried after 503 and reached review", True)
    check(f"live[{checklist_file}]: 3 observe batches (5+5+1) + 1 analyze", seen["observe"] == 3 and seen["analyze"] == 1, str(seen["observe"]) + "/" + str(seen["analyze"]))
    b0 = seen["bodies"][1]
    check("request: store=false", b0.get("store") is False)
    check("request: JSON schema response_format", b0.get("response_format", {}).get("mime_type") == "application/json" and "schema" in b0["response_format"])
    check("request: inline base64 images", any(p.get("type") == "image" and len(p.get("data", "")) > 1000 for p in b0["input"]))
    check("request: model id", b0.get("model") == "gemini-3.8-flash", b0.get("model"))
    warn = await pg.inner_text("#warnCard")
    check(f"live[{checklist_file}]: missing steps flagged", "Step 1: no screenshot" in warn and "Step 12: no screenshot" in warn, warn)
    check(f"live[{checklist_file}]: no page errors", not errors, "; ".join(errors))
    await ctx.close()


async def error_flow(browser):
    ctx = await browser.new_context()
    pg = await ctx.new_page()
    await pg.route("https://generativelanguage.googleapis.com/**", lambda r: r.fulfill(status=400, content_type="application/json", body=json.dumps({"error": {"message": "API key not valid. Please pass a valid API key."}})))
    await pg.goto(BASE)
    await pg.fill("#checklistText", open(os.path.join(ROOT, "demo/checklist.txt")).read())
    await pg.set_input_files("#imgInput", [os.path.join(ROOT, "demo/screenshots", demo["images"][0]["file"])])
    await pg.wait_for_function("document.querySelectorAll('#thumbs .thumb').length === 1")
    await pg.evaluate("sessionStorage.setItem('labpilot.key', 'bad')")
    await pg.click("#analyzeBtn")
    await pg.wait_for_selector("#err1:not([hidden])", timeout=20000)
    msg = await pg.inner_text("#err1")
    check("errors: bad key shows a readable message", "API key was rejected" in msg, msg)
    await ctx.close()


async def mobile(browser):
    ctx = await browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True)
    pg = await ctx.new_page()
    await pg.goto(BASE + "?demo")
    await pg.wait_for_selector("#panel2:not([hidden])", timeout=20000)
    sw = await pg.evaluate("document.documentElement.scrollWidth")
    check("mobile: no horizontal overflow at 390px", sw <= 392, str(sw))
    await pg.screenshot(path=os.path.join(OUT, "mobile_review.png"))
    await ctx.close()


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        await demo_flow(browser)
        await live_flow(browser, "checklist.pdf")
        await live_flow(browser, "checklist.docx")
        await error_flow(browser)
        await mobile(browser)
        await browser.close()
    passed = sum(1 for _, ok in results if ok)
    print(f"\n{passed}/{len(results)} checks passed")
    sys.exit(0 if passed == len(results) else 1)

asyncio.run(main())
