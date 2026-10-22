/* LabPilot ingest: read assignment files (DOCX/PDF/TXT) and prepare screenshots in the browser. */
(function (root) {
  "use strict";
  const MAX_SIDE = 1600;

  async function readAssignment(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".docx")) {
      if (!root.mammoth) throw new Error("DOCX reader failed to load.");
      const res = await root.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return res.value;
    }
    if (name.endsWith(".pdf") || file.type === "application/pdf") {
      const pdfjs = await import(new URL("vendor/pdf.min.mjs", location.href).href);
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("vendor/pdf.worker.min.mjs", location.href).href;
      const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      const out = [];
      for (let p = 1; p <= Math.min(doc.numPages, 30); p++) {
        const tc = await (await doc.getPage(p)).getTextContent();
        let line = "";
        tc.items.forEach((it) => { line += it.str; if (it.hasEOL) { out.push(line); line = ""; } });
        if (line) out.push(line);
      }
      return out.join("\n");
    }
    if (name.endsWith(".doc")) throw new Error("Old .doc files aren't supported. Save it as .docx or PDF, or paste the text.");
    return await file.text();
  }

  function toBase64(bytes) {
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  }

  /** Downscale to <= MAX_SIDE, keep PNG for crisp text unless it is huge. */
  async function prepareImage(blob, name) {
    const bmp = await createImageBitmap(blob);
    const s = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();
    let mime = "image/png";
    let out = await new Promise((r) => canvas.toBlob(r, mime));
    if (out.size > 1.5 * 1024 * 1024) { mime = "image/jpeg"; out = await new Promise((r) => canvas.toBlob(r, mime, 0.9)); }
    const bytes = new Uint8Array(await out.arrayBuffer());
    return { name, mime, type: mime === "image/png" ? "png" : "jpg", width: w, height: h, bytes, data: toBase64(bytes), url: URL.createObjectURL(out) };
  }

  root.LabIngest = { readAssignment, prepareImage, toBase64 };
})(typeof self !== "undefined" ? self : this);
