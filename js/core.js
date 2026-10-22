/* LabPilot core: checklist parsing, schemas, prompt text, and the grounding /
 * matching rules that turn raw model output into a report model.
 * Pure functions, no DOM. Works in the browser (window.LabCore) and in Node (require). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LabCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const LOW_CONFIDENCE = 0.55;

  // ---------------------------------------------------------------- parsing
  const STEP_RE = /^\s*(?:step|task|q(?:uestion)?)?\s*(\d{1,3})\s*[.):\-–]\s*(.+)$/i;
  const STEP_WORD_RE = /^\s*(?:step|task)\s+(\d{1,3})\s*[:.\-–]?\s*(.*)$/i;
  const BULLET_RE = /^\s*(?:[-*•▪◦]|\(\w\))\s+(.+)$/;
  const META_RE = /^\s*(title|aim|objective|experiment(?:\s*no\.?)?|subject|course)\s*[:\-–]\s*(.+)$/i;

  function cleanLine(s) {
    return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  /** Parse a checklist / problem statement into numbered steps. */
  function parseChecklist(text) {
    const lines = String(text || "").split(/\r?\n/);
    const meta = {};
    const steps = [];
    const bullets = [];
    let heading = "";
    let current = null;
    let lastMeta = null;
    for (const raw of lines) {
      const line = cleanLine(raw);
      if (!line) { current = null; lastMeta = null; continue; }
      const m = line.match(META_RE);
      if (m && !steps.length) { lastMeta = m[1].toLowerCase().split(/\s/)[0]; meta[lastMeta] = m[2].trim(); continue; }
      if (lastMeta && /^[a-z(]/.test(line)) { meta[lastMeta] += " " + line; continue; }
      lastMeta = null;
      const s = line.match(STEP_WORD_RE) || line.match(STEP_RE);
      if (s && s[2] && s[2].length > 2) {
        current = { n: Number(s[1]), text: s[2].trim() };
        steps.push(current);
        continue;
      }
      const b = line.match(BULLET_RE);
      if (b) { bullets.push(b[1].trim()); current = null; continue; }
      if (current && /^[a-z(]/.test(line)) { current.text += " " + line; continue; }
      if (!heading && !steps.length) heading = line;
    }
    let list = steps;
    if (list.length < 2 && bullets.length >= 2) list = bullets.map((t, i) => ({ n: i + 1, text: t }));
    // Renumber duplicates / gaps defensively while keeping the author's numbers when sane.
    const seen = new Set();
    const ok = list.every((s) => !seen.has(s.n) && seen.add(s.n));
    const out = list.map((s, i) => {
      const n = ok ? s.n : i + 1;
      return { id: "S" + n, n, text: s.text.replace(/\s+/g, " ").trim() };
    });
    return {
      heading,
      title: meta.title || "",
      aim: meta.aim || meta.objective || "",
      steps: out,
    };
  }

  /** Short label for a step, used in warnings ("no screenshot of ..."). */
  function shortStep(text, max) {
    max = max || 70;
    let t = cleanLine(text).replace(/[.;]+$/, "");
    if (t.length <= max) return t;
    t = t.slice(0, max);
    return t.slice(0, t.lastIndexOf(" ") > 30 ? t.lastIndexOf(" ") : max) + "…";
  }

  // ---------------------------------------------------------------- schemas
  const OBSERVE_SCHEMA = {
    type: "object",
    properties: {
      observations: {
        type: "array",
        items: {
          type: "object",
          properties: {
            image_id: { type: "string", description: "The id given for the image, e.g. IMG3." },
            screen_kind: { type: "string", enum: ["terminal", "cloud_console", "browser", "code_editor", "document", "other"] },
            visible_text: {
              type: "array",
              description: "Up to 14 of the most important lines of text exactly as they appear in the image (commands, outputs, status words, ids, URLs). Copy verbatim; never correct or complete them.",
              items: { type: "string" },
            },
            summary: { type: "string", description: "One or two plain sentences describing only what is visibly on screen." },
            key_values: {
              type: "array",
              items: {
                type: "object",
                properties: { label: { type: "string" }, value: { type: "string" } },
                required: ["label", "value"],
              },
            },
            legible: { type: "boolean", description: "False if the image is too blurry/cropped to read." },
          },
          required: ["image_id", "screen_kind", "visible_text", "summary", "legible"],
        },
      },
    },
    required: ["observations"],
  };

  const ANALYZE_SCHEMA = {
    type: "object",
    properties: {
      report_title: { type: "string" },
      aim: { type: "string" },
      matches: {
        type: "array",
        description: "Exactly one entry per image id.",
        items: {
          type: "object",
          properties: {
            image_id: { type: "string" },
            step_id: { type: "string", description: "A step id such as S4, or NONE if the image fits no step." },
            confidence: { type: "number", description: "0 to 1" },
            reason: { type: "string" },
          },
          required: ["image_id", "step_id", "confidence", "reason"],
        },
      },
      steps: {
        type: "array",
        description: "Exactly one entry per step id.",
        items: {
          type: "object",
          properties: {
            step_id: { type: "string" },
            coverage: { type: "string", enum: ["full", "partial", "none"] },
            explanation: { type: "string", description: "2-3 sentences, past tense, describing what the matched screenshots show was done. Empty string when coverage is none." },
            evidence: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  image_id: { type: "string" },
                  quote: { type: "string", description: "A short exact substring of that image's visible_text that supports the explanation." },
                },
                required: ["image_id", "quote"],
              },
            },
            gap: { type: "string", description: "What the step asks for that no screenshot shows. Empty if nothing is missing." },
          },
          required: ["step_id", "coverage", "explanation", "evidence", "gap"],
        },
      },
      theory: { type: "string", description: "120-200 words of background theory on the concepts the assignment names. No claims about this student's outputs." },
      conclusion: { type: "string", description: "2-4 sentences. Only state as achieved what the evidence shows; mention unevidenced steps as not shown." },
    },
    required: ["report_title", "aim", "matches", "steps", "theory", "conclusion"],
  };

  const EXTRACT_STEPS_SCHEMA = {
    type: "object",
    properties: {
      title: { type: "string" },
      aim: { type: "string" },
      steps: { type: "array", items: { type: "string" } },
    },
    required: ["title", "aim", "steps"],
  };

  // ---------------------------------------------------------------- prompts
  const SYSTEM_OBSERVE =
    "You read screenshots from a student's lab assignment. Report ONLY what is visibly on screen. " +
    "Copy text verbatim, including typos. Never guess hidden, cropped or blurred values; if something is unreadable, say so. " +
    "Do not interpret beyond what is shown.";

  const SYSTEM_ANALYZE =
    "You assemble a lab report from a checklist of steps and OBSERVATIONS transcribed from the student's screenshots. " +
    "You cannot see the images; the observations are your only evidence. Rules: " +
    "(1) Match each image to the single step it best evidences, or NONE. " +
    "(2) Every factual statement in an explanation must be supported by an evidence quote that is an exact substring of that image's visible_text. " +
    "(3) Never invent commands, outputs, ids, IPs, names or results. " +
    "(4) If a step has no matching image, coverage is none, explanation is empty and gap says what screenshot is needed. " +
    "(5) If an image only shows part of a step, coverage is partial and gap names the missing part. " +
    "(6) Theory may explain general concepts but must not describe this student's results.";

  function observePrompt(images) {
    return (
      "Transcribe each of the following " + images.length + " screenshots. Each image is preceded by its id. " +
      "Return one observation per image id: " + images.map((i) => i.id).join(", ") + "."
    );
  }

  function analyzePrompt(checklist, observations, images) {
    const stepLines = checklist.steps.map((s) => s.id + ": " + s.text).join("\n");
    const obs = observations.map((o) => {
      const img = images.find((i) => i.id === o.image_id);
      return {
        image_id: o.image_id,
        file_name: img ? img.name : undefined,
        screen_kind: o.screen_kind,
        legible: o.legible,
        summary: o.summary,
        visible_text: o.visible_text,
        key_values: o.key_values || [],
      };
    });
    return [
      "ASSIGNMENT HEADING: " + (checklist.heading || ""),
      "TITLE: " + (checklist.title || "(not given)"),
      "AIM: " + (checklist.aim || "(not given)"),
      "STEPS:\n" + stepLines,
      "OBSERVATIONS (JSON):\n" + JSON.stringify(obs, null, 1),
      "Image ids: " + images.map((i) => i.id).join(", ") + ". Step ids: " + checklist.steps.map((s) => s.id).join(", ") + ".",
    ].join("\n\n");
  }

  // ---------------------------------------------------------------- grounding
  function norm(s) {
    return String(s || "")
      .toLowerCase()
      .replace(/[\u2018\u2019\u201c\u201d"'`]/g, "")
      .replace(/[●•]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function observationCorpus(o) {
    if (!o) return "";
    const kv = (o.key_values || []).map((k) => k.label + " " + k.value + " " + k.value);
    return norm([].concat(o.visible_text || [], kv, [o.summary || ""]).join(" \n "));
  }

  /** True if quote is (fuzzily) present in the image's transcribed text. */
  function quoteSupported(quote, obs) {
    const q = norm(quote);
    if (q.length < 2) return false;
    const corpus = observationCorpus(obs);
    if (corpus.includes(q)) return true;
    // tolerate small differences: >= 80% of quote tokens (len>1) present
    const toks = q.split(" ").filter((t) => t.length > 1);
    if (toks.length < 3) return false;
    const hit = toks.filter((t) => corpus.includes(t)).length;
    return hit / toks.length >= 0.8;
  }

  function naturalCompare(a, b) {
    return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  }

  /**
   * Turn model output + any manual reassignments into a validated report model.
   * images: [{id, name, order}]; observations: [{image_id,...}]; analysis: ANALYZE_SCHEMA object;
   * overrides: {imageId: stepId|"NONE"}; edits: {stepId: explanation}
   */
  function buildModel(input) {
    const checklist = input.checklist;
    const images = input.images || [];
    const analysis = input.analysis || {};
    const overrides = input.overrides || {};
    const edits = input.edits || {};
    const obsById = {};
    (input.observations || []).forEach((o) => { if (o && o.image_id && !obsById[o.image_id]) obsById[o.image_id] = o; });
    const stepIds = new Set(checklist.steps.map((s) => s.id));
    const imageIds = new Set(images.map((i) => i.id));
    const warnings = [];

    // 1. one match per image; unknown ids dropped; overrides win
    const assign = {};
    const conf = {};
    const reason = {};
    (analysis.matches || []).forEach((m) => {
      if (!m || !imageIds.has(m.image_id) || m.image_id in assign) return;
      const sid = String(m.step_id || "").toUpperCase().replace(/^STEP\s*/, "S");
      assign[m.image_id] = stepIds.has(sid) ? sid : "NONE";
      conf[m.image_id] = typeof m.confidence === "number" ? Math.max(0, Math.min(1, m.confidence)) : 0;
      reason[m.image_id] = m.reason || "";
    });
    images.forEach((img) => {
      if (!(img.id in assign)) { assign[img.id] = "NONE"; conf[img.id] = 0; reason[img.id] = "Not matched by the model."; }
      if (img.id in overrides) {
        const o = overrides[img.id];
        assign[img.id] = stepIds.has(o) ? o : "NONE";
        conf[img.id] = 1;
        reason[img.id] = "Assigned by you.";
      }
    });

    const aStep = {};
    (analysis.steps || []).forEach((s) => { if (s && stepIds.has(s.step_id) && !aStep[s.step_id]) aStep[s.step_id] = s; });

    // 2. per step
    let fig = 0;
    const steps = checklist.steps.map((st) => {
      const imgs = images
        .filter((i) => assign[i.id] === st.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || naturalCompare(a.name, b.name));
      let a = aStep[st.id] || { coverage: "none", explanation: "", evidence: [], gap: "" };
      let coverage = a.coverage;
      let explanation = (a.explanation || "").trim();
      const flags = [];
      const unverified = [];
      const verified = [];

      if (!imgs.length) {
        coverage = "none";
        explanation = "";
        warnings.push({ type: "missing", step_id: st.id, n: st.n, message: "Step " + st.n + ": no screenshot for \u201c" + shortStep(st.text) + "\u201d" });
      } else {
        const imgSet = new Set(imgs.map((i) => i.id));
        (a.evidence || []).forEach((e) => {
          if (!e || !e.quote) return;
          if (imgSet.has(e.image_id) && quoteSupported(e.quote, obsById[e.image_id])) verified.push(e);
          else unverified.push(e);
        });
        const manual = imgs.some((i) => overrides[i.id] !== undefined);
        if (!explanation || (!verified.length && !manual && !(st.id in edits))) {
          // Fall back to a sentence built only from the transcription itself.
          explanation = imgs
            .map((i) => (obsById[i.id] && obsById[i.id].summary ? obsById[i.id].summary : ""))
            .filter(Boolean)
            .join(" ");
          if (!explanation) explanation = "Screenshot attached for this step.";
          flags.push("auto_text");
        }
        if (coverage === "none") {
          coverage = "partial";
          a = { ...a, gap: manual ? "You assigned this screenshot by hand; check that it really shows this step." : "The model did not think this screenshot fully shows the step; please check it." };
        }
        if (coverage === "partial") {
          warnings.push({ type: "partial", step_id: st.id, n: st.n, message: "Step " + st.n + ": only partly shown" + (a.gap ? ": " + lowerFirst(a.gap.replace(/\.$/, "")) : "") + "." });
        }
        if (unverified.length) {
          flags.push("unverified");
          warnings.push({ type: "unverified", step_id: st.id, n: st.n, message: "Step " + st.n + ": " + unverified.length + " cited detail(s) could not be found in the screenshot text — please check the explanation." });
        }
        imgs.forEach((i) => {
          if (conf[i.id] < LOW_CONFIDENCE) {
            warnings.push({ type: "low_confidence", step_id: st.id, n: st.n, image_id: i.id, message: "Step " + st.n + ": \u201c" + i.name + "\u201d is an uncertain match (" + Math.round(conf[i.id] * 100) + "%). Confirm it belongs here." });
          }
          const o = obsById[i.id];
          if (o && o.legible === false) warnings.push({ type: "illegible", step_id: st.id, n: st.n, image_id: i.id, message: "Step " + st.n + ": \u201c" + i.name + "\u201d is hard to read; consider a clearer capture." });
        });
      }
      if (st.id in edits) { explanation = String(edits[st.id]).trim(); flags.push("edited"); }
      const figures = imgs.map((i) => {
        fig += 1;
        return { image_id: i.id, number: fig, caption: "Figure " + fig + ": " + captionFor(st, obsById[i.id], imgs.length > 1 ? imgs.indexOf(i) + 1 : 0) };
      });
      return { id: st.id, n: st.n, text: st.text, coverage, explanation, gap: imgs.length ? (a.gap || "") : "Screenshot needed: " + lowerFirst(shortStep(st.text, 120)) + ".", figures, flags, evidence: verified, unverified };
    });

    const unmatched = images.filter((i) => assign[i.id] === "NONE").map((i) => ({ image_id: i.id, name: i.name, reason: reason[i.id] }));
    unmatched.forEach((u) => warnings.push({ type: "unmatched", image_id: u.image_id, message: "\u201c" + u.name + "\u201d did not match any step and is left out of the report." }));

    const order = { missing: 0, partial: 1, unverified: 2, low_confidence: 3, illegible: 4, unmatched: 5 };
    warnings.sort((a, b) => (order[a.type] - order[b.type]) || ((a.n || 0) - (b.n || 0)));

    const covered = steps.filter((s) => s.coverage !== "none").length;
    return {
      title: (input.titleOverride || analysis.report_title || checklist.title || checklist.heading || "Lab Report").trim(),
      aim: (analysis.aim || checklist.aim || "").trim(),
      theory: (analysis.theory || "").trim(),
      conclusion: (analysis.conclusion || "").trim(),
      steps,
      unmatched,
      warnings,
      assign,
      confidence: conf,
      stats: { steps: steps.length, covered, missing: steps.length - covered, partial: steps.filter((s) => s.coverage === "partial").length, figures: fig, images: images.length },
    };
  }

  function lowerFirst(s) { return s ? s.charAt(0).toLowerCase() + s.slice(1) : s; }

  function captionFor(step, obs, idx) {
    const base = shortStep(step.text, 90);
    return base + (idx ? " (" + idx + ")" : "");
  }

  /** Validate parsed model JSON loosely against what the pipeline needs. Throws on unusable output. */
  function validateObserve(json, images) {
    if (!json || !Array.isArray(json.observations)) throw new Error("Model reply had no observations array.");
    const ids = new Set(images.map((i) => i.id));
    const out = json.observations.filter((o) => o && ids.has(o.image_id)).map((o) => ({
      image_id: o.image_id,
      screen_kind: o.screen_kind || "other",
      visible_text: Array.isArray(o.visible_text) ? o.visible_text.map(String).slice(0, 20) : [],
      summary: String(o.summary || ""),
      key_values: Array.isArray(o.key_values) ? o.key_values.filter((k) => k && k.label) : [],
      legible: o.legible !== false,
    }));
    return out;
  }

  function validateAnalysis(json) {
    if (!json || !Array.isArray(json.matches) || !Array.isArray(json.steps)) throw new Error("Model reply was missing matches or steps.");
    return json;
  }

  /** Parse model text that should be JSON (tolerates ```json fences). */
  function parseJsonLoose(text) {
    let t = String(text || "").trim();
    const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) t = fence[1].trim();
    const start = t.search(/[[{]/);
    if (start > 0) t = t.slice(start);
    return JSON.parse(t);
  }

  function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  }

  return {
    LOW_CONFIDENCE, parseChecklist, shortStep, OBSERVE_SCHEMA, ANALYZE_SCHEMA, EXTRACT_STEPS_SCHEMA,
    SYSTEM_OBSERVE, SYSTEM_ANALYZE, observePrompt, analyzePrompt, quoteSupported, buildModel,
    validateObserve, validateAnalysis, parseJsonLoose, chunk, naturalCompare, norm,
  };
});
