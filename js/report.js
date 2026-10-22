/* LabPilot report builder: report model -> .docx (via the docx library, client-side). */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.LabReport = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const DETAIL_FIELDS = [
    ["name", "Student name"], ["prn", "PRN"], ["roll", "Roll no."], ["division", "Class / Division"],
    ["batch", "Batch"], ["subject", "Subject"], ["experiment", "Experiment no."], ["institute", "Institute"], ["date", "Date"],
  ];
  const MAX_W = 600; // px at 96 dpi ~ 6.25 in, fits A4 with 1 in margins

  function fit(w, h, maxW, maxH) {
    maxW = maxW || MAX_W; maxH = maxH || 520;
    let s = Math.min(1, maxW / w, maxH / h);
    return { width: Math.round(w * s), height: Math.round(h * s) };
  }

  /** Plain list of the report's sections; used by the DOCX renderer and tested directly. */
  function outline(model, details, options) {
    options = options || {};
    const out = [{ kind: "title", text: model.title }];
    const rows = DETAIL_FIELDS.filter(([k]) => details && String(details[k] || "").trim()).map(([k, label]) => [label, String(details[k]).trim()]);
    if (rows.length) out.push({ kind: "details", rows });
    if (model.aim) out.push({ kind: "section", heading: "Aim", text: model.aim });
    if (model.theory) out.push({ kind: "section", heading: "Theory", text: model.theory });
    out.push({ kind: "heading", text: "Procedure and Observations" });
    model.steps.forEach((s) => {
      out.push({ kind: "step", n: s.n, text: s.text, explanation: s.explanation, coverage: s.coverage, gap: s.gap, figures: s.figures });
    });
    if (model.conclusion) out.push({ kind: "section", heading: "Conclusion", text: model.conclusion });
    if (options.includeWarnings !== false && model.warnings.length) {
      out.push({ kind: "warnings", items: model.warnings.filter((w) => w.type !== "unmatched" || options.includeUnmatched !== false).map((w) => w.message) });
    }
    return out;
  }

  /**
   * Build a docx Document.
   * docx: the docx library namespace. getImage(image_id) -> {data:Uint8Array|ArrayBuffer, width, height, type:'png'|'jpg'}
   */
  function buildDocx(docx, model, details, getImage, options) {
    const { Document, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun,
      AlignmentType, BorderStyle, ShadingType, Footer, PageNumber } = docx;
    const items = outline(model, details, options);
    const children = [];
    const P = (text, o) => new Paragraph({ spacing: { after: 120, line: 300 }, ...(o || {}), children: [new TextRun({ text: text || "", ...((o && o.run) || {}) })] });
    const cellBorder = { style: BorderStyle.SINGLE, size: 4, color: "9AA5B1" };
    const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder };

    items.forEach((it) => {
      if (it.kind === "title") {
        children.push(new Paragraph({ heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: it.text, bold: true })] }));
      } else if (it.kind === "details") {
        children.push(new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: it.rows.map(([k, v]) => new TableRow({ children: [
            new TableCell({ borders, width: { size: 32, type: WidthType.PERCENTAGE }, shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEF2F7" }, children: [new Paragraph({ spacing: { before: 60, after: 60 }, children: [new TextRun({ text: k, bold: true })] })] }),
            new TableCell({ borders, width: { size: 68, type: WidthType.PERCENTAGE }, children: [new Paragraph({ spacing: { before: 60, after: 60 }, children: [new TextRun(v)] })] }),
          ] })),
        }));
        children.push(new Paragraph({ text: "" }));
      } else if (it.kind === "section") {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, children: [new TextRun(it.heading)] }));
        String(it.text).split(/\n{2,}/).forEach((para) => children.push(P(para.trim(), { alignment: AlignmentType.JUSTIFIED })));
      } else if (it.kind === "heading") {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 }, children: [new TextRun(it.text)] }));
      } else if (it.kind === "step") {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 80 }, keepNext: true, children: [new TextRun("Step " + it.n + ": " + it.text)] }));
        if (it.coverage === "none") {
          children.push(new Paragraph({
            shading: { type: ShadingType.CLEAR, color: "auto", fill: "FFF4E5" },
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: "E8590C", space: 6 } },
            spacing: { after: 120 },
            children: [new TextRun({ text: "Missing evidence: ", bold: true, color: "B54708" }), new TextRun({ text: it.gap || "No screenshot was provided for this step.", color: "B54708" })],
          }));
          return;
        }
        if (it.explanation) children.push(P(it.explanation, { alignment: AlignmentType.JUSTIFIED }));
        it.figures.forEach((f) => {
          const img = getImage(f.image_id);
          if (img && img.data) {
            const size = fit(img.width, img.height);
            children.push(new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 80, after: 40 }, children: [new ImageRun({ type: img.type === "jpg" ? "jpg" : "png", data: img.data, transformation: size })] }));
          }
          children.push(new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 160 }, children: [new TextRun({ text: f.caption, italics: true, size: 20, color: "444444" })] }));
        });
        if (it.coverage === "partial" && it.gap) {
          children.push(new Paragraph({ spacing: { after: 120 }, children: [new TextRun({ text: "Note: ", bold: true, color: "B54708" }), new TextRun({ text: it.gap, color: "B54708" })] }));
        }
      } else if (it.kind === "warnings") {
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, spacing: { after: 120 }, children: [new TextRun("Missing Evidence and Review Notes")] }));
        children.push(P("Generated by LabPilot. Resolve these before submitting, then delete this section.", { run: { italics: true, color: "666666" } }));
        it.items.forEach((m) => children.push(new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: [new TextRun(m)] })));
      }
    });

    return new Document({
      creator: "LabPilot",
      title: model.title,
      description: "Lab report assembled with LabPilot",
      styles: {
        default: { document: { run: { font: "Calibri", size: 23 } } },
        paragraphStyles: [
          { id: "Title", name: "Title", basedOn: "Normal", next: "Normal", run: { font: "Calibri", size: 40, bold: true, color: "1F2A44" } },
          { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 30, bold: true, color: "1F3A8A" } },
          { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: "Calibri", size: 25, bold: true, color: "1F2A44" } },
        ],
      },
      numbering: undefined,
      sections: [{
        properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 18, color: "777777" })] })] }) },
        children,
      }],
    });
  }

  function fileName(model, details) {
    const who = details && details.name ? details.name.trim().replace(/\s+/g, "_") + "_" : "";
    const t = (model.title || "Lab_Report").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "_").slice(0, 60);
    return who + t + ".docx";
  }

  return { DETAIL_FIELDS, outline, buildDocx, fit, fileName };
});
