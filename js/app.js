/* LabPilot UI controller. */
(function () {
  "use strict";
  const Core = window.LabCore, G = window.LabGemini, R = window.LabReport, I = window.LabIngest;
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const state = {
    demo: false,
    checklist: { heading: "", title: "", aim: "", steps: [] },
    images: [],          // {id,name,order,mime,type,width,height,bytes,data,url}
    observations: [],
    analysis: null,
    overrides: {},
    edits: {},
    details: {},
    model: null,
    nextId: 1,
  };

  // ------------------------------------------------------------ settings
  const settings = {
    get key() { return sessionStorage.getItem("labpilot.key") || ""; },
    set key(v) { v ? sessionStorage.setItem("labpilot.key", v) : sessionStorage.removeItem("labpilot.key"); },
    get model() { return localStorage.getItem("labpilot.modelCustom") || localStorage.getItem("labpilot.model") || G.MODELS[0].id; },
    get api() { return localStorage.getItem("labpilot.api") || "interactions"; },
  };
  function initSettings() {
    const sel = $("#modelSel");
    sel.innerHTML = G.MODELS.map((m) => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
    $("#openSettings").onclick = openSettings;
    $("#saveSettings").onclick = () => {
      settings.key = $("#apiKey").value.trim();
      localStorage.setItem("labpilot.model", sel.value);
      const c = $("#modelCustom").value.trim();
      c ? localStorage.setItem("labpilot.modelCustom", c) : localStorage.removeItem("labpilot.modelCustom");
      localStorage.setItem("labpilot.api", $("#apiSel").value);
      toast(settings.key ? "Saved. Using " + settings.model + "." : "Saved (no key set).");
    };
    $("#clearKey").onclick = () => { settings.key = ""; $("#apiKey").value = ""; toast("Key removed from this tab."); };
  }
  function openSettings() {
    $("#apiKey").value = settings.key;
    $("#modelSel").value = localStorage.getItem("labpilot.model") || G.MODELS[0].id;
    $("#modelCustom").value = localStorage.getItem("labpilot.modelCustom") || "";
    $("#apiSel").value = settings.api;
    $("#settings").showModal();
  }

  // ------------------------------------------------------------ navigation
  function go(n) {
    [1, 2, 3].forEach((k) => { $("#panel" + k).hidden = k !== n; });
    document.querySelectorAll("#stepper li").forEach((li) => {
      const k = Number(li.dataset.step);
      li.classList.toggle("active", k === n);
      li.classList.toggle("done", k < n);
    });
    $("#hero").hidden = n !== 1;
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  // ------------------------------------------------------------ step 1
  function initUpload() {
    wireDrop($("#docDrop"), $("#docInput"), async (files) => {
      const f = files[0];
      if (!f) return;
      try {
        setStatus("Reading " + f.name + "…");
        const text = await I.readAssignment(f);
        $("#checklistText").value = text.trim();
        reparse();
      } catch (e) { showErr(1, e.message || String(e)); setStatus("Could not read that file."); }
    });
    wireDrop($("#imgDrop"), $("#imgInput"), addImages);
    $("#checklistText").addEventListener("input", debounce(reparse, 250));
    const form = $("#detailsForm");
    form.innerHTML = R.DETAIL_FIELDS.map(([k, label]) => `<label>${esc(label)}<input type="text" data-k="${k}" /></label>`).join("");
    form.addEventListener("input", (e) => { if (e.target.dataset.k) state.details[e.target.dataset.k] = e.target.value; });
    $("#analyzeBtn").onclick = analyze;
    $("#tryDemo").onclick = runDemo;
  }
  function wireDrop(zone, input, cb) {
    input.addEventListener("change", () => { cb([...input.files]); input.value = ""; });
    ["dragenter", "dragover"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
    zone.addEventListener("drop", (e) => cb([...e.dataTransfer.files]));
  }
  function setStatus(t, ok) { const el = $("#parseStatus"); el.textContent = t; el.classList.toggle("ok", !!ok); }
  function reparse() {
    state.checklist = Core.parseChecklist($("#checklistText").value);
    const n = state.checklist.steps.length;
    if (n) setStatus("✓ Found " + n + " steps" + (state.checklist.title ? " · " + state.checklist.title : ""), true);
    else if ($("#checklistText").value.trim()) setStatus("No numbered steps found. Gemini will split the text into steps for you.");
    else setStatus("No steps found yet.");
  }
  async function addImages(files) {
    const imgs = files.filter((f) => /^image\//.test(f.type));
    if (!imgs.length) return;
    for (const f of imgs) {
      try {
        const p = await I.prepareImage(f, f.name);
        state.images.push({ ...p, id: "IMG" + state.nextId++, order: state.images.length });
      } catch (e) { showErr(1, "Couldn't read " + f.name + ": " + (e.message || e)); }
    }
    renderThumbs();
  }
  function renderThumbs() {
    $("#shotCount").textContent = state.images.length + (state.images.length === 1 ? " image" : " images");
    $("#thumbs").innerHTML = state.images.map((im) => `<div class="thumb"><img src="${im.url}" alt="${esc(im.name)}" /><button class="x" data-rm="${im.id}" title="Remove">×</button><span class="nm">${esc(im.name)}</span></div>`).join("");
    $("#thumbs").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { state.images = state.images.filter((i) => i.id !== b.dataset.rm); renderThumbs(); }));
  }
  function showErr(n, msg) { const el = $("#err" + n); if (!el) return toast(msg); el.textContent = msg; el.hidden = !msg; }

  // ------------------------------------------------------------ analysis
  async function analyze() {
    showErr(1, "");
    const text = $("#checklistText").value.trim();
    if (!text) return showErr(1, "Add the assignment first: drop a file or paste the steps.");
    if (!state.images.length) return showErr(1, "Add at least one screenshot.");
    if (!settings.key) { showErr(1, "Add your Gemini API key in Settings first, or try the demo, which needs no key."); openSettings(); return; }
    state.demo = false; $("#modePill").hidden = true; $("#demoNote").hidden = true;
    const cfg = { apiKey: settings.key, model: settings.model, api: settings.api, onStatus: (t) => log(t) };
    overlay(true, "Analyzing with " + settings.model);
    try {
      if (state.checklist.steps.length < 2) {
        state.checklist = await G.extractSteps(text, cfg);
        if (state.checklist.steps.length < 1) throw new Error("Couldn't find any steps in the assignment.");
      }
      state.observations = await G.observe(state.images, cfg);
      state.analysis = await G.analyze(state.checklist, state.observations, state.images, cfg);
      state.overrides = {}; state.edits = {};
      log("Checking every claim against the screenshot text…");
      rebuild();
      overlay(false);
      go(2);
    } catch (e) {
      overlay(false);
      let msg = e.message || String(e);
      if (e.network && settings.api === "interactions") msg += " Tip: switch the API to generateContent in Settings and try again.";
      showErr(1, msg);
    }
  }

  async function runDemo() {
    showErr(1, "");
    overlay(true, "Loading the demo");
    try {
      log("Loading sample checklist and 11 sample screenshots…");
      const [txt, demo] = await Promise.all([fetch("demo/checklist.txt").then(ok).then((r) => r.text()), fetch("demo/demo-result.json").then(ok).then((r) => r.json())]);
      $("#checklistText").value = txt.trim();
      reparse();
      state.images = [];
      state.nextId = 1;
      for (const im of demo.images) {
        const blob = await fetch("demo/screenshots/" + encodeURIComponent(im.file)).then(ok).then((r) => r.blob());
        const p = await I.prepareImage(blob, im.file);
        state.images.push({ ...p, id: im.id, order: state.images.length });
        state.nextId++;
      }
      renderThumbs();
      log("Using precomputed sample AI output (no API call)…");
      state.observations = demo.observations;
      state.analysis = demo.analysis;
      state.details = { ...demo.details };
      document.querySelectorAll("#detailsForm input").forEach((i) => (i.value = state.details[i.dataset.k] || ""));
      state.overrides = {}; state.edits = {};
      state.demo = true;
      $("#modePill").hidden = false; $("#demoNote").hidden = false;
      rebuild();
      await new Promise((r) => setTimeout(r, 400));
      overlay(false);
      go(2);
    } catch (e) {
      overlay(false);
      showErr(1, "Demo files didn't load (" + (e.message || e) + "). If you opened index.html from disk, serve the folder instead, e.g. python3 -m http.server.");
    }
  }
  const ok = (r) => { if (!r.ok) throw new Error("HTTP " + r.status + " for " + r.url); return r; };

  function rebuild() {
    state.model = Core.buildModel({ checklist: state.checklist, images: state.images, observations: state.observations, analysis: state.analysis, overrides: state.overrides, edits: state.edits });
    renderReview();
  }

  // ------------------------------------------------------------ step 2
  function renderReview() {
    const m = state.model, st = m.stats;
    const unused = m.unmatched.length;
    $("#summary").innerHTML =
      `<span class="chip"><b>${st.steps}</b>steps</span>` +
      `<span class="chip ok"><b>${st.covered - st.partial}</b>fully shown</span>` +
      (st.partial ? `<span class="chip warn"><b>${st.partial}</b>partly shown</span>` : "") +
      (st.missing ? `<span class="chip bad"><b>${st.missing}</b>missing a screenshot</span>` : "") +
      (unused ? `<span class="chip"><b>${unused}</b>unused image${unused > 1 ? "s" : ""}</span>` : "") +
      `<span class="chip"><b>${st.figures}</b>figures</span>`;
    const w = m.warnings;
    $("#warnCard").hidden = !w.length;
    $("#warnCard").innerHTML = `<div class="card-head"><h2>⚠ Fix before you submit</h2><span class="muted small">${w.length} item${w.length === 1 ? "" : "s"}</span></div><ul>${w.map((x) => `<li class="${x.type}">${esc(x.message)}</li>`).join("")}</ul>`;

    const stepOpts = (sel) => `<option value="NONE"${sel === "NONE" ? " selected" : ""}>Not used</option>` + state.checklist.steps.map((s) => `<option value="${s.id}"${sel === s.id ? " selected" : ""}>Step ${s.n}</option>`).join("");
    const figHtml = (f) => {
      const im = state.images.find((i) => i.id === f.image_id);
      const c = m.confidence[f.image_id] ?? 0;
      return `<div class="fig"><img src="${im.url}" alt="${esc(f.caption)}" data-zoom="${im.id}" /><div class="meta"><span class="muted">${esc(im.name)}</span><span>Match <span class="conf ${c < Core.LOW_CONFIDENCE ? "low" : ""}">${Math.round(c * 100)}%</span></span><select data-move="${im.id}" aria-label="Move image">${stepOpts(m.assign[im.id])}</select></div></div>`;
    };
    $("#stepsList").innerHTML = m.steps.map((s) => {
      const label = s.coverage === "full" ? "Shown" : s.coverage === "partial" ? "Partly shown" : "Missing";
      const flags = s.flags.map((f) => `<span class="flag ${f}">${{ auto_text: "text built from screenshot only", unverified: "check the explanation", edited: "edited by you" }[f] || f}</span>`).join("");
      const body = s.coverage === "none"
        ? `<div class="missing-box">📷 ${esc(s.gap)} <span class="muted small">Add it on the Upload screen, or move an image here from another step.</span></div>`
        : `<div class="step-body"><div class="figs">${s.figures.map(figHtml).join("")}</div><div><textarea data-edit="${s.id}" rows="5" aria-label="Explanation for step ${s.n}">${esc(s.explanation)}</textarea>${s.evidence.length ? `<div class="ev"><span class="ev-l">✓ Found in screenshot:</span> ${s.evidence.slice(0, 4).map((e) => `<q>${esc(e.quote)}</q>`).join(" ")}</div>` : ""}${s.gap ? `<div class="gap">⚠ ${esc(s.gap)}</div>` : ""}${flags}</div></div>`;
      return `<article class="step ${s.coverage}" id="step-${s.id}"><div class="step-head"><span class="step-n">${s.n}</span><span class="step-title">${esc(s.text)}</span><span class="badge ${s.coverage}">${label}</span></div>${body}</article>`;
    }).join("");

    const uc = $("#unmatchedCard");
    uc.hidden = !m.unmatched.length;
    uc.innerHTML = `<div class="card-head"><h2>Images not used in the report</h2><span class="muted small">assign one to a step if it belongs</span></div><div class="unmatched-list">${m.unmatched.map((u) => {
      const im = state.images.find((i) => i.id === u.image_id);
      return `<div class="fig"><img src="${im.url}" alt="${esc(im.name)}" data-zoom="${im.id}" /><div class="meta"><span class="muted">${esc(im.name)}</span><span>${esc(u.reason)}</span><select data-move="${im.id}">${stepOpts("NONE")}</select></div></div>`;
    }).join("")}</div>`;

    $("#theoryText").value = m.theory;
    $("#conclusionText").value = m.conclusion;

    document.querySelectorAll("[data-move]").forEach((s) => (s.onchange = () => { state.overrides[s.dataset.move] = s.value; rebuild(); toast("Moved. Report updated."); }));
    document.querySelectorAll("[data-edit]").forEach((t) => (t.oninput = debounce(() => { state.edits[t.dataset.edit] = t.value; }, 200)));
    document.querySelectorAll("[data-zoom]").forEach((img) => (img.onclick = () => zoom(img.src)));
  }

  // ------------------------------------------------------------ step 3
  function currentModel() {
    // Apply any pending text edits before building.
    document.querySelectorAll("[data-edit]").forEach((t) => { if (t.value !== undefined) state.edits[t.dataset.edit] = t.value; });
    const base = Core.buildModel({ checklist: state.checklist, images: state.images, observations: state.observations, analysis: state.analysis, overrides: state.overrides, edits: pruneEdits() });
    base.theory = $("#theoryText").value.trim();
    base.conclusion = $("#conclusionText").value.trim();
    return base;
  }
  function pruneEdits() {
    // keep only edits that differ from the generated text, so flags stay meaningful
    const out = {};
    const gen = Core.buildModel({ checklist: state.checklist, images: state.images, observations: state.observations, analysis: state.analysis, overrides: state.overrides });
    Object.entries(state.edits).forEach(([k, v]) => { const s = gen.steps.find((x) => x.id === k); if (s && s.explanation.trim() !== String(v).trim()) out[k] = v; });
    return out;
  }
  function renderPreview() {
    const m = currentModel();
    state.model = m;
    const o = R.outline(m, state.details, { includeWarnings: $("#optWarnings").checked });
    $("#dlMeta").textContent = m.stats.steps + " steps · " + m.stats.figures + " figures · " + m.warnings.length + " notes";
    $("#preview").innerHTML = o.map((it) => {
      if (it.kind === "title") return `<h1>${esc(it.text)}</h1>`;
      if (it.kind === "details") return `<table>${it.rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}</table>`;
      if (it.kind === "section") return `<h2>${esc(it.heading)}</h2>${it.text.split(/\n{2,}/).map((p) => `<p>${esc(p)}</p>`).join("")}`;
      if (it.kind === "heading") return `<h2>${esc(it.text)}</h2>`;
      if (it.kind === "step") {
        if (it.coverage === "none") return `<h3>Step ${it.n}: ${esc(it.text)}</h3><p class="miss"><b>Missing evidence:</b> ${esc(it.gap)}</p>`;
        return `<h3>Step ${it.n}: ${esc(it.text)}</h3><p>${esc(it.explanation)}</p>` + it.figures.map((f) => { const im = state.images.find((i) => i.id === f.image_id); return `<img src="${im.url}" alt="" /><div class="cap">${esc(f.caption)}</div>`; }).join("") + (it.coverage === "partial" && it.gap ? `<p class="miss"><b>Note:</b> ${esc(it.gap)}</p>` : "");
      }
      if (it.kind === "warnings") return `<h2>Missing Evidence and Review Notes</h2><ul>${it.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`;
      return "";
    }).join("");
  }
  async function download() {
    const btn = $("#downloadBtn");
    btn.disabled = true; btn.textContent = "Building DOCX…";
    try {
      const m = currentModel();
      const getImage = (id) => { const im = state.images.find((i) => i.id === id); return im && { data: im.bytes, width: im.width, height: im.height, type: im.type }; };
      const doc = R.buildDocx(window.docx, m, state.details, getImage, { includeWarnings: $("#optWarnings").checked });
      const blob = await window.docx.Packer.toBlob(doc);
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = R.fileName(m, state.details);
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast("Downloaded " + a.download);
    } catch (e) {
      toast("Couldn't build the DOCX: " + (e.message || e));
    } finally {
      btn.disabled = false; btn.textContent = "⬇ Download DOCX";
    }
  }

  // ------------------------------------------------------------ helpers
  function overlay(on, title) { $("#overlay").hidden = !on; if (on) { $("#ovTitle").textContent = title || "Working…"; $("#ovLog").innerHTML = ""; } }
  function log(t) { const li = document.createElement("li"); li.textContent = t; $("#ovLog").appendChild(li); }
  let tt;
  function toast(t) { const el = $("#toast"); el.textContent = t; el.hidden = false; clearTimeout(tt); tt = setTimeout(() => (el.hidden = true), 2600); }
  function debounce(fn, ms) { let h; return (...a) => { clearTimeout(h); h = setTimeout(() => fn(...a), ms); }; }
  function zoom(src) { const d = document.createElement("div"); d.className = "lightbox"; d.innerHTML = `<img src="${src}" alt="" />`; d.onclick = () => d.remove(); document.body.appendChild(d); }

  function init() {
    initSettings();
    initUpload();
    $("#back1").onclick = () => go(1);
    $("#toStep3").onclick = () => { renderPreview(); go(3); };
    $("#back2").onclick = () => { renderReview(); go(2); };
    $("#optWarnings").onchange = renderPreview;
    $("#downloadBtn").onclick = download;
    $("#startOver").onclick = () => { if (confirm("Clear everything and start over?")) location.reload(); };
    document.querySelectorAll("#stepper li").forEach((li) => (li.onclick = () => {
      const k = Number(li.dataset.step);
      if (k === 1) go(1);
      else if (state.model && k === 2) { renderReview(); go(2); }
      else if (state.model && k === 3) { renderPreview(); go(3); }
    }));
    if (new URLSearchParams(location.search).has("demo")) runDemo();
    window.LabPilotState = state; // handy for debugging / headless checks
  }
  document.addEventListener("DOMContentLoaded", init);
})();
