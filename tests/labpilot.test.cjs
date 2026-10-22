// Run: node --test tests/   (Node 18+; no npm install needed)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Core = require("../js/core.js");
const Report = require("../js/report.js");
const Gemini = require("../js/gemini.js");
const docx = require("../vendor/docx.umd.js");

const ROOT = path.join(__dirname, "..");
const demo = JSON.parse(fs.readFileSync(path.join(ROOT, "demo/demo-result.json"), "utf8"));
const checklistText = fs.readFileSync(path.join(ROOT, "demo/checklist.txt"), "utf8");
const images = demo.images.map((i, k) => ({ id: i.id, name: i.file, order: k }));
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });

test("parseChecklist reads title, aim and 12 numbered steps", () => {
  const c = Core.parseChecklist(checklistText);
  assert.equal(c.steps.length, 12);
  assert.equal(c.steps[0].id, "S1");
  assert.match(c.steps[11].text, /S3 website endpoint/);
  assert.match(c.title, /EC2/);
  assert.match(c.aim, /Apache/);
});

test("parseChecklist handles 'Step N:' style, wrapped lines and bullets", () => {
  const a = Core.parseChecklist("Step 1: Create a VPC\nwith two subnets\nStep 2: Launch an instance\nStep 3) Attach an EBS volume");
  assert.deepEqual(a.steps.map((s) => s.n), [1, 2, 3]);
  assert.match(a.steps[0].text, /two subnets/);
  const b = Core.parseChecklist("Tasks\n- Install Docker\n- Run hello-world\n- Push an image");
  assert.equal(b.steps.length, 3);
  assert.equal(b.steps[2].text, "Push an image");
});

test("parseChecklist joins wrapped Aim lines (PDF text)", () => {
  const c = Core.parseChecklist("Aim: To deploy a web server and host a static website\nusing S3 hosting.\n1. Launch an instance\n2. Install httpd");
  assert.equal(c.aim, "To deploy a web server and host a static website using S3 hosting.");
  assert.equal(c.steps.length, 2);
});

test("parseChecklist renumbers duplicate numbers", () => {
  const c = Core.parseChecklist("1. a step one\n2. a step two\n1. step again");
  assert.deepEqual(c.steps.map((s) => s.id), ["S1", "S2", "S3"]);
});

test("demo model: matches, missing steps 1 and 12, partial 8 and 11, unmatched image", () => {
  const checklist = Core.parseChecklist(checklistText);
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis: demo.analysis });
  assert.equal(m.stats.steps, 12);
  assert.equal(m.stats.missing, 2);
  assert.equal(m.stats.figures, 10);
  const byType = (t) => m.warnings.filter((w) => w.type === t);
  assert.deepEqual(byType("missing").map((w) => w.n), [1, 12]);
  assert.equal(byType("missing")[1].message, "Step 12: no screenshot for \u201cOpen the S3 website endpoint in a browser and show the page loading\u201d");
  assert.deepEqual(byType("partial").map((w) => w.n), [8, 11]);
  assert.equal(byType("unmatched").length, 1);
  assert.equal(byType("unverified").length, 0, "every demo quote should be found in the transcription");
  assert.equal(m.steps[0].explanation, "");
  assert.equal(m.steps[4].figures[0].image_id, "IMG3");
  // figures numbered in step order
  assert.deepEqual(m.steps.flatMap((s) => s.figures.map((f) => f.number)), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
});

test("grounding gate: invented quote is flagged and explanation falls back to the transcription", () => {
  const checklist = Core.parseChecklist(checklistText);
  const analysis = JSON.parse(JSON.stringify(demo.analysis));
  const s4 = analysis.steps.find((s) => s.step_id === "S4");
  s4.explanation = "The instance has IP 54.1.2.3 and is Stopped.";
  s4.evidence = [{ image_id: "IMG7", quote: "54.1.2.3" }, { image_id: "IMG7", quote: "Stopped" }];
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis });
  const step = m.steps.find((s) => s.id === "S4");
  assert.ok(step.flags.includes("unverified"));
  assert.ok(step.flags.includes("auto_text"));
  assert.doesNotMatch(step.explanation, /54\.1\.2\.3/);
  assert.match(step.explanation, /Running/);
  assert.ok(m.warnings.some((w) => w.type === "unverified" && w.n === 4));
});

test("evidence citing an image assigned to a different step is not accepted", () => {
  const checklist = Core.parseChecklist(checklistText);
  const analysis = JSON.parse(JSON.stringify(demo.analysis));
  analysis.steps.find((s) => s.step_id === "S9").evidence = [{ image_id: "IMG7", quote: "Running" }];
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis });
  assert.ok(m.steps.find((s) => s.id === "S9").flags.includes("unverified"));
});

test("model claims coverage for a step without images -> forced to none and flagged missing", () => {
  const checklist = Core.parseChecklist(checklistText);
  const analysis = JSON.parse(JSON.stringify(demo.analysis));
  const s12 = analysis.steps.find((s) => s.step_id === "S12");
  s12.coverage = "full"; s12.explanation = "The website loaded at the endpoint.";
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis });
  const step = m.steps.find((s) => s.id === "S12");
  assert.equal(step.coverage, "none");
  assert.equal(step.explanation, "");
});

test("bad ids, duplicate matches and 'Step 4' style ids are normalised", () => {
  const checklist = Core.parseChecklist(checklistText);
  const analysis = { matches: [
    { image_id: "IMG7", step_id: "Step 4", confidence: 0.9, reason: "" },
    { image_id: "IMG7", step_id: "S9", confidence: 0.9, reason: "dup" },
    { image_id: "IMG99", step_id: "S1", confidence: 1, reason: "ghost" },
    { image_id: "IMG5", step_id: "S77", confidence: 1, reason: "bad step" },
  ], steps: [] };
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis });
  assert.equal(m.assign.IMG7, "S4");
  assert.equal(m.assign.IMG5, "NONE");
  assert.ok(!("IMG99" in m.assign));
});

test("manual override moves an image and low confidence is reported", () => {
  const checklist = Core.parseChecklist(checklistText);
  const analysis = JSON.parse(JSON.stringify(demo.analysis));
  analysis.matches.find((x) => x.image_id === "IMG10").confidence = 0.3;
  let m = Core.buildModel({ checklist, images, observations: demo.observations, analysis });
  assert.ok(m.warnings.some((w) => w.type === "low_confidence" && w.image_id === "IMG10"));
  m = Core.buildModel({ checklist, images, observations: demo.observations, analysis, overrides: { IMG4: "S1" } });
  const s1 = m.steps.find((s) => s.id === "S1");
  assert.equal(s1.figures.length, 1);
  assert.notEqual(s1.coverage, "none");
  assert.match(s1.explanation, /bubble_sort/, "manual assignment gets text built only from the transcription");
  assert.equal(m.unmatched.length, 0);
});

test("user edits replace the explanation", () => {
  const checklist = Core.parseChecklist(checklistText);
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis: demo.analysis, edits: { S2: "My own words." } });
  assert.equal(m.steps.find((s) => s.id === "S2").explanation, "My own words.");
});

test("quoteSupported tolerates quotes/case/spacing but rejects absent values", () => {
  const o = demo.observations.find((x) => x.image_id === "IMG8");
  assert.ok(Core.quoteSupported("ACTIVE:  active (running)", o));
  assert.ok(Core.quoteSupported("listening on: port 80", o));
  assert.ok(!Core.quoteSupported("inactive (dead)", o));
  assert.ok(!Core.quoteSupported("x", o));
});

test("parseJsonLoose strips code fences", () => {
  assert.deepEqual(Core.parseJsonLoose("```json\n{\"a\":1}\n```"), { a: 1 });
  assert.deepEqual(Core.parseJsonLoose("Here you go: {\"b\":[2]}"), { b: [2] });
});

test("report outline has details table, missing-evidence blocks and warnings section", () => {
  const checklist = Core.parseChecklist(checklistText);
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis: demo.analysis });
  const o = Report.outline(m, demo.details);
  assert.equal(o[0].kind, "title");
  assert.equal(o[1].kind, "details");
  assert.equal(o[1].rows[0][1], "Demo Student");
  assert.deepEqual(o.filter((x) => x.kind === "section").map((x) => x.heading), ["Aim", "Theory", "Conclusion"]);
  assert.equal(o.filter((x) => x.kind === "step").length, 12);
  assert.equal(o.at(-1).kind, "warnings");
  assert.equal(Report.outline(m, demo.details, { includeWarnings: false }).some((x) => x.kind === "warnings"), false);
  assert.equal(Report.fileName(m, demo.details).endsWith(".docx"), true);
});

test("buildDocx packs a valid .docx with 10 embedded images", async () => {
  const checklist = Core.parseChecklist(checklistText);
  const m = Core.buildModel({ checklist, images, observations: demo.observations, analysis: demo.analysis });
  const byId = Object.fromEntries(demo.images.map((i) => [i.id, i.file]));
  const getImage = (id) => {
    const buf = fs.readFileSync(path.join(ROOT, "demo/screenshots", byId[id]));
    return { data: new Uint8Array(buf), type: "png", ...pngSize(buf) };
  };
  const doc = Report.buildDocx(docx, m, demo.details, getImage);
  const buf = await docx.Packer.toBuffer(doc);
  assert.equal(buf.slice(0, 2).toString(), "PK");
  const media = (buf.toString("latin1").match(/word\/media\/[^\s"]+?\.png/g) || []);
  assert.ok(new Set(media).size >= 10, "expected 10 media files, got " + new Set(media).size);
});

test("Report.fit keeps aspect ratio within page width", () => {
  assert.deepEqual(Report.fit(1280, 720), { width: 600, height: 338 });
  assert.deepEqual(Report.fit(400, 300), { width: 400, height: 300 });
});

test("Gemini request bodies match the documented REST shapes", () => {
  const parts = [{ text: "hi" }, { mime: "image/png", data: "AAAA" }];
  const i = Gemini.buildRequest("interactions", { model: "gemini-3.8-flash", system: "sys", parts, schema: { type: "object" } });
  assert.equal(i.url, "https://generativelanguage.googleapis.com/v1beta/interactions");
  assert.equal(i.body.store, false);
  assert.deepEqual(i.body.input[1], { type: "image", data: "AAAA", mime_type: "image/png" });
  assert.equal(i.body.response_format.mime_type, "application/json");
  const g = Gemini.buildRequest("generateContent", { model: "gemini-3.8-flash", system: "sys", parts, schema: { type: "object" } });
  assert.match(g.url, /models\/gemini-3\.8-flash:generateContent$/);
  assert.deepEqual(g.body.contents[0].parts[1], { inline_data: { mime_type: "image/png", data: "AAAA" } });
  assert.equal(g.body.generationConfig.responseMimeType, "application/json");
});

test("extractText reads Interactions steps and generateContent candidates", () => {
  const t = Gemini.extractText("interactions", { status: "completed", steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "text", text: "{\"a\":1}" }] }] });
  assert.equal(t, "{\"a\":1}");
  const g = Gemini.extractText("generateContent", { candidates: [{ content: { parts: [{ text: "{\"b\"" }, { text: ":2}" }] } }] });
  assert.equal(g, "{\"b\":2}");
});

function fakeFetch(seq) {
  let n = 0;
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const r = seq[Math.min(n++, seq.length - 1)];
    if (r === "network") throw new TypeError("Failed to fetch");
    return { ok: r.status === 200, status: r.status, headers: { get: () => null }, json: async () => r.body };
  };
  f.calls = calls;
  return f;
}
const okBody = (obj) => ({ status: 200, body: { status: "completed", steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(obj) }] }] } });

test("callJson retries 503, network errors and bad JSON, then succeeds", async () => {
  const f = fakeFetch([{ status: 503, body: {} }, "network", { status: 200, body: { steps: [{ type: "model_output", content: [{ type: "text", text: "not json" }] }] } }, okBody({ ok: true })]);
  const out = await Gemini.callJson({ fetchImpl: f, apiKey: "k", model: "m", system: "s", parts: [{ text: "x" }], schema: {}, baseDelayMs: 1, maxRetries: 3 });
  assert.deepEqual(out, { ok: true });
  assert.equal(f.calls.length, 4);
  assert.equal(f.calls[0].init.headers["x-goog-api-key"], "k");
});

test("callJson does not retry a 404 and gives a readable message", async () => {
  const f = fakeFetch([{ status: 404, body: { error: { message: "models/x is not found" } } }]);
  await assert.rejects(Gemini.callJson({ fetchImpl: f, apiKey: "k", model: "x", system: "s", parts: [{ text: "x" }], schema: {}, baseDelayMs: 1 }), /Model not found/);
  assert.equal(f.calls.length, 1);
});

test("observe batches images and fills in observations the model skipped", async () => {
  const imgs = Array.from({ length: 7 }, (_, k) => ({ id: "IMG" + (k + 1), name: "f" + k + ".png", mime: "image/png", data: "AA" }));
  const f = async (url, init) => {
    const body = JSON.parse(init.body);
    const ids = body.input.filter((p) => p.type === "text" && p.text.startsWith("Image id ")).map((p) => p.text.split(" ")[2]);
    const obs = ids.slice(0, ids.length - 1).map((id) => ({ image_id: id, screen_kind: "terminal", visible_text: ["$ ls"], summary: "s", legible: true }));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => okBody({ observations: obs }).body };
  };
  const out = await Gemini.observe(imgs, { fetchImpl: f, apiKey: "k", model: "m", batchSize: 4, baseDelayMs: 1 });
  assert.equal(out.length, 7);
  assert.equal(out.filter((o) => o.legible === false).length, 2);
});
