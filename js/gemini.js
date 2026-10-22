/* LabPilot Gemini client: browser-side REST calls with a bring-your-own key.
 * Two transports, both documented by Google (checked 22 Oct 2026):
 *   - Interactions API  POST https://generativelanguage.googleapis.com/v1beta/interactions   (recommended)
 *   - generateContent   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent (legacy, still supported)
 * Structured JSON output via a JSON Schema, bounded retries with backoff, and readable errors. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./core.js"));
  else root.LabGemini = factory(root.LabCore);
})(typeof self !== "undefined" ? self : this, function (Core) {
  "use strict";

  const BASE = "https://generativelanguage.googleapis.com/v1beta";
  const MODELS = [
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash (recommended)" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite (fastest, cheapest)" },
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon (most capable, slower)" },
    { id: "gemini-flash-latest", label: "gemini-flash-latest (alias)" },
  ];
  const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

  class GeminiError extends Error {
    constructor(message, info) { super(message); this.name = "GeminiError"; Object.assign(this, info || {}); }
  }

  function friendly(status, body) {
    const msg = (body && body.error && body.error.message) || "";
    if (status === 400 && /api key/i.test(msg)) return "That API key was rejected. Check it in Google AI Studio and paste it again.";
    if (status === 400) return "The request was rejected (400): " + (msg || "bad request") + ". Try another model in Settings.";
    if (status === 401 || status === 403) return "The key is not allowed to use this model (" + status + "). " + (msg || "Check the key's project and API access.");
    if (status === 404) return "Model not found (404). Pick a different model in Settings.";
    if (status === 429) return "Rate limit or quota reached (429). Wait a minute, or switch to a lighter model.";
    if (status >= 500) return "Gemini had a server error (" + status + "). Please retry in a moment.";
    return "Gemini error " + status + (msg ? ": " + msg : "");
  }

  function buildRequest(api, opts) {
    const { model, system, parts, schema } = opts;
    if (api === "generateContent") {
      return {
        url: BASE + "/models/" + encodeURIComponent(model) + ":generateContent",
        body: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: parts.map((p) => (p.text !== undefined ? { text: p.text } : { inline_data: { mime_type: p.mime, data: p.data } })) }],
          generationConfig: { responseMimeType: "application/json", responseJsonSchema: schema, temperature: 0.2 },
        },
      };
    }
    return {
      url: BASE + "/interactions",
      body: {
        model,
        system_instruction: system,
        input: parts.map((p) => (p.text !== undefined ? { type: "text", text: p.text } : { type: "image", data: p.data, mime_type: p.mime })),
        response_format: { type: "text", mime_type: "application/json", schema },
        store: false,
      },
    };
  }

  function extractText(api, json) {
    if (api === "generateContent") {
      const c = json && json.candidates && json.candidates[0];
      if (!c) throw new GeminiError("Gemini returned no answer" + (json && json.promptFeedback && json.promptFeedback.blockReason ? " (blocked: " + json.promptFeedback.blockReason + ")" : "") + ".", { retryable: true });
      return ((c.content && c.content.parts) || []).map((p) => p.text || "").join("");
    }
    if (json && typeof json.output_text === "string") return json.output_text;
    const steps = (json && (json.steps || json.outputs)) || [];
    const texts = [];
    steps.forEach((s) => {
      if (s.type && s.type !== "model_output" && s.type !== "text") return;
      (s.content || [s]).forEach((c) => { if (c && c.type === "text" && c.text) texts.push(c.text); });
    });
    if (!texts.length) throw new GeminiError("Gemini returned an empty answer" + (json && json.status ? " (status: " + json.status + ")" : "") + ".", { retryable: true });
    return texts.join("");
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Call Gemini and return parsed JSON. Retries network errors, 408/429/5xx and unparseable JSON. */
  async function callJson(opts) {
    const fetchImpl = opts.fetchImpl || (typeof fetch !== "undefined" ? fetch.bind(globalThis) : null);
    const api = opts.api || "interactions";
    const maxRetries = opts.maxRetries ?? 3;
    const baseDelay = opts.baseDelayMs ?? 1500;
    const { url, body } = buildRequest(api, opts);
    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const wait = lastErr && lastErr.retryAfterMs ? lastErr.retryAfterMs : baseDelay * Math.pow(2, attempt - 1) + Math.random() * 400;
        opts.onStatus && opts.onStatus("Retrying (" + attempt + "/" + maxRetries + ") after: " + lastErr.message);
        await sleep(Math.min(wait, 20000));
      }
      const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs || 120000) : null;
      let res;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
          body: JSON.stringify(body),
          signal: ctrl ? ctrl.signal : undefined,
        });
      } catch (e) {
        if (timer) clearTimeout(timer);
        const aborted = e && e.name === "AbortError";
        lastErr = new GeminiError(aborted ? "The request timed out." : "Network error reaching Gemini (offline, blocked, or CORS).", { retryable: true, network: !aborted, cause: e });
        continue;
      }
      if (timer) clearTimeout(timer);
      let json = null;
      try { json = await res.json(); } catch (_) { json = null; }
      if (!res.ok) {
        const ra = res.headers && res.headers.get && res.headers.get("retry-after");
        lastErr = new GeminiError(friendly(res.status, json), { status: res.status, retryable: RETRY_STATUS.has(res.status), retryAfterMs: ra ? Number(ra) * 1000 : 0 });
        if (!lastErr.retryable) throw lastErr;
        continue;
      }
      try {
        const text = extractText(api, json);
        return Core.parseJsonLoose(text);
      } catch (e) {
        lastErr = e instanceof GeminiError ? e : new GeminiError("Gemini's reply was not valid JSON.", { retryable: true, cause: e });
        continue;
      }
    }
    throw lastErr;
  }

  /** Stage 1: transcribe screenshots in small batches. images: [{id,name,mime,data(base64)}] */
  async function observe(images, cfg) {
    const batches = Core.chunk(images, cfg.batchSize || 5);
    const all = [];
    for (let b = 0; b < batches.length; b++) {
      const batch = batches[b];
      cfg.onStatus && cfg.onStatus("Reading screenshots " + (b * (cfg.batchSize || 5) + 1) + "–" + (b * (cfg.batchSize || 5) + batch.length) + " of " + images.length + "…");
      const parts = [{ text: Core.observePrompt(batch) }];
      batch.forEach((img) => { parts.push({ text: "Image id " + img.id + " (file: " + img.name + "):" }); parts.push({ mime: img.mime, data: img.data }); });
      const json = await callJson({ ...cfg, system: Core.SYSTEM_OBSERVE, parts, schema: Core.OBSERVE_SCHEMA });
      const obs = Core.validateObserve(json, batch);
      batch.forEach((img) => {
        if (!obs.find((o) => o.image_id === img.id)) obs.push({ image_id: img.id, screen_kind: "other", visible_text: [], summary: "", key_values: [], legible: false });
      });
      all.push(...obs);
    }
    return all;
  }

  /** Stage 2: text-only matching + writing from observations. */
  async function analyze(checklist, observations, images, cfg) {
    cfg.onStatus && cfg.onStatus("Matching screenshots to " + checklist.steps.length + " steps and writing the report…");
    const json = await callJson({ ...cfg, system: Core.SYSTEM_ANALYZE, parts: [{ text: Core.analyzePrompt(checklist, observations, images) }], schema: Core.ANALYZE_SCHEMA });
    return Core.validateAnalysis(json);
  }

  /** Fallback when the checklist has no recognisable numbering. */
  async function extractSteps(text, cfg) {
    cfg.onStatus && cfg.onStatus("Finding the steps in your assignment…");
    const json = await callJson({
      ...cfg,
      system: "Split a lab assignment into the ordered list of steps a student must perform and screenshot. Use the assignment's own wording. Do not add steps.",
      parts: [{ text: String(text).slice(0, 30000) }],
      schema: Core.EXTRACT_STEPS_SCHEMA,
    });
    return {
      heading: json.title || "",
      title: json.title || "",
      aim: json.aim || "",
      steps: (json.steps || []).filter(Boolean).map((t, i) => ({ id: "S" + (i + 1), n: i + 1, text: String(t).trim() })),
    };
  }

  return { MODELS, BASE, buildRequest, extractText, callJson, observe, analyze, extractSteps, GeminiError };
});
