# DevSpot Build Mode: submission copy (ready to paste)

**Challenge:** The Wildcard Challenge

## Project title
LabPilot

## Tagline (one line)
Screenshots in, submission-ready lab report out. Every claim backed by a screenshot.

## Short description (≈50 words)
LabPilot turns a lab checklist and a messy folder of screenshots into a formatted DOCX report. Gemini vision reads each screenshot and matches it to its step. LabPilot flags steps with no proof ("Step 12: no screenshot of the S3 website endpoint") and writes explanations grounded only in what the screenshots show. It runs fully in the browser with your own key.

## Full description

**The problem.** I'm a second-year AI & Data Science student at Vishwakarma University, Pune. Every week I do a lab like "launch an EC2 instance, open ports 22 and 80, SSH in, install Apache, host a site on S3", and screenshot every step. Then I spend longer than the lab itself working out which `Screenshot (47).png` proves which step, writing explanations and captions, and formatting it all in Word. Sometimes I only discover a missing screenshot after the AWS resources are already deleted. I did exactly this by hand for my cloud computing lab this month, and LabPilot is the tool I wanted.

**What it does.**
1. **Upload.** Add the assignment (paste it, or upload a DOCX or PDF) and all your screenshots in any order.
2. **Review.** LabPilot shows every step with its matched screenshot, a match confidence, an explanation and the exact quotes from the screenshot that back it. Steps with no evidence, or only partial evidence, are flagged at the top. Unrelated images are left out instead of being forced in. You can move any screenshot to another step and edit any text.
3. **Download.** You get a formatted DOCX with a student details table, aim, theory, every step with numbered figures and captions, a conclusion, and an optional "Missing Evidence and Review Notes" page.

**How it stays honest (the interesting part).**
- **Stage 1: see.** Gemini vision only transcribes each screenshot: verbatim visible text, a literal summary and key values. It is told never to guess anything cropped or blurred.
- **Stage 2: write.** A separate, text-only Gemini call matches images to steps and writes the explanations. It never sees the pixels, only the transcripts, and it must cite exact quotes.
- **Grounding gate.** LabPilot then checks deterministically, in the browser, that every quote really appears in the transcript of a screenshot assigned to that step. Unsupported claims are flagged and replaced with a literal description. A step with no screenshot can never get an explanation, whatever the model says.

**Tech.**
- A static web app (vanilla JS, no backend) deployable to GitHub Pages.
- Google Gemini over REST with a bring-your-own key, stored in sessionStorage only. Default model `gemini-3.8-flash`, selectable. Uses the Interactions API with `store: false`, with a generateContent fallback.
- Structured JSON output via JSON Schema, batching, exponential-backoff retries and readable errors.
- DOCX built client-side with the docx library. DOCX and PDF input are read with mammoth and pdf.js.
- 21 unit tests and 27 headless-Chromium checks. The browser checks include the full live flow with Gemini responses intercepted.

**Try it in one click.** Demo Mode loads a sample AWS EC2 + S3 lab with 11 labelled sample screenshots. Two steps are missing, two are partial, and one image is unrelated. It uses precomputed sample AI output, so you can run the whole flow and download the DOCX with no key.

**Impact.** Every engineering student writes screenshot-based lab reports, often weekly. LabPilot cuts the formatting grind and catches missing evidence while you can still retake the screenshot. It never fabricates outputs.

## Links
- **Demo:** https://armstrong24.github.io/labpilot/  ← confirm after enabling Pages
- **Source repo:** https://github.com/Armstrong24/labpilot  ← confirm after pushing
- **Demo video:** (upload `labpilot-demo.mp4` to YouTube as Unlisted, or attach it directly, and paste the link)
- **README:** in the repo root

## Tags / tech
JavaScript, Google Gemini API, Computer Vision, Education, Productivity, GitHub Pages, docx

## Team
Arnav Kale (solo). GitHub: @Armstrong24. SY B.Tech AI & Data Science, Vishwakarma University, Pune.

## Disclosure (if the form asks)
Built during the event window with AI coding assistance, which the rules allow. The demo screenshots are generated mock images labelled "SAMPLE". Demo Mode uses precomputed sample output in the same schema the live Gemini pipeline returns.
