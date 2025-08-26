// /api/generate-fix.js – Edit ohne Maske, nur Prompt-Steuerung (Motiv ~30%, viel Hintergrund)
import sharp from "sharp";
import { FormData, File } from "formdata-node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const config = { api: { bodyParser: false } };

// ===== CORS =====
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "x-request-id,retry-after");
}

// ===== Helpers =====
async function readRawBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, boundary) {
  const CRLF = "\r\n";
  const delim = `--${boundary}`;
  const closeDelim = `--${boundary}--`;
  const body = buffer.toString("binary");
  const parts = body.split(delim).filter(p => p && p !== "--" && p !== closeDelim);
  const fields = {}, files = {};
  for (let rawPart of parts) {
    if (rawPart.startsWith(CRLF)) rawPart = rawPart.slice(CRLF.length);
    const sep = CRLF + CRLF;
    const idx = rawPart.indexOf(sep);
    if (idx === -1) continue;
    const rawHeaders = rawPart.slice(0, idx);
    let rawContent = rawPart.slice(idx + sep.length);
    if (rawContent.endsWith(CRLF)) rawContent = rawContent.slice(0, -CRLF.length);
    const headers = {};
    for (const line of rawHeaders.split(CRLF)) {
      const j = line.indexOf(":");
      if (j > -1) headers[line.slice(0, j).trim().toLowerCase()] = line.slice(j + 1).trim();
    }
    const cd = headers["content-disposition"] || "";
    const name = (cd.match(/name="([^"]+)"/i) || [])[1];
    const filename = (cd.match(/filename="([^"]+)"/i) || [])[1];
    const ctype = headers["content-type"] || "";
    if (!name) continue;
    if (filename) {
      files[name] = { filename, contentType: ctype || "application/octet-stream", buffer: Buffer.from(rawContent, "binary") };
    } else {
      fields[name] = Buffer.from(rawContent, "binary").toString("utf8");
    }
  }
  return { fields, files };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const withJitter = ms => Math.round(ms * (0.85 + Math.random() * 0.3));

function extractUrlOrDataUri(json) {
  const item = json?.data?.[0];
  if (!item) return null;
  if (item.url) return item.url;
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  return null;
}

async function fetchOpenAIWithRetry(form, styleName, { retries = 4, baseDelayMs = 1000 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.headers },
        body: form,
      });
      const txt = await resp.text();
      let json; try { json = JSON.parse(txt); } catch { json = null; }
      if (resp.ok) {
        const out = extractUrlOrDataUri(json);
        if (out) return out;
      }
      const retryAfter = parseFloat(resp.headers?.get?.("retry-after") || "0");
      const is5xx = resp.status >= 500 && resp.status <= 599;
      const serverErr = json?.error?.type === "server_error";
      if (attempt === retries || !(is5xx || serverErr)) {
        lastError = new Error(json?.error?.message || `HTTP ${resp.status}`);
        break;
      }
      const wait = Math.max(withJitter(baseDelayMs * Math.pow(2, attempt - 1)), retryAfter * 1000);
      await sleep(wait);
    } catch (err) {
      lastError = err;
      if (attempt === retries) break;
      const wait = withJitter(baseDelayMs * Math.pow(2, attempt - 1));
      await sleep(wait);
    }
  }
  throw lastError || new Error("OpenAI fehlgeschlagen");
}

// ===== Prompts – Motiv ~30 %, zentriert, viel negativer Raum, später gut croppbar =====
function buildPrompts(userText) {
  const comp = [
    "Composition: center the pet and leave generous negative space.",
    "The subject should cover about 20% of the frame (small in frame), with ~80% clean background.",
    "Ensure the whole head and silhouette are fully visible with comfortable top/bottom and side margins.",
    "Background must be coherent and smoothly extended from the original (no hard borders, no frames).",
    "Design the background to work in both portrait and landscape crops later; avoid elements that break when rotated.",
    "Do not zoom in; do not tightly crop; no added borders or picture frames."
  ].join(" ");

  const guardrails = [
    "This is the same real pet; preserve exact identity, anatomy and markings.",
    "Keep proportions and facial structure unchanged; no cartoonification; artifact-free.",
    comp
  ].join(" ");

  const nat = [
    "High-end studio portrait retouch, premium magazine quality.",
    "Soft diffused key light with subtle rim; refined micro-contrast; elegant neutral backdrop with smooth falloff.",
    guardrails,
    userText ? `If text is provided, integrate it small and tasteful: "${userText}".` : ""
  ].join(" ");

  const bw = [
    "Fine-art black and white conversion (true grayscale).",
    "Deep blacks, controlled highlights, rich midtones; delicate film grain; crisp whiskers and eyes.",
    guardrails,
    userText ? `If text is provided, render it subtle and monochrome: "${userText}".` : ""
  ].join(" ");

  const neon = [
    "Neon pop-art styling while preserving the exact pet identity and silhouette.",
    "Cyan, magenta and orange rim-light accents; smooth neon gradients with gentle halation on a dark backdrop.",
    guardrails,
    userText ? `Add matching neon typography, very small and tasteful: "${userText}".` : ""
  ].join(" ");

  return { natural: nat, "schwarzweiß": bw, neon };
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null, userText = "", requestedStyles = null;

    // Zielgröße (OpenAI erlaubt 1024 zuverlässig)
    const SIZE = 1024;

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart (no boundary)" });
      const { fields, files } = parseMultipart(await readRawBody(req), m[1]);
      const f = files["file"]; if (!f?.buffer) return res.status(400).json({ error: "No file uploaded" });
      sourceBuffer = f.buffer;
      userText = (fields["custom_text"] || fields["text"] || "").toString();
      if (fields["styles"]) { try { const s = JSON.parse(fields["styles"]); if (Array.isArray(s)) requestedStyles = s; } catch {} }
    } else if (ctype.includes("application/json")) {
      const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/,"");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");
      userText = body.userText || "";
      if (Array.isArray(body.styles)) requestedStyles = body.styles;
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // Input auf 1024x1024 normieren (contain, keine Beschneidung)
    const inputPng = await sharp(sourceBuffer)
      .resize(SIZE, SIZE, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
      .png()
      .toBuffer();

    // Ohne Maske/Outpainting: wir steuern alles über den Prompt
    const imageForEdit = inputPng;

    const prompts = buildPrompts(userText);

    // ⚠️ TEMPORÄR: Nur NEON generieren, um Credits zu sparen.
    // Für Livebetrieb wieder DEFAULT_STYLES = ['natural','schwarzweiß','neon'] setzen.
    const DEFAULT_STYLES = ['neon'];
    const ALLOWED = ['natural','schwarzweiß','neon'];
    const styles = (requestedStyles && requestedStyles.length)
      ? requestedStyles.filter(s => ALLOWED.includes(s))
      : DEFAULT_STYLES;

    const previews = {};
    const failed = [];

    for (const style of styles) {
      await sleep(250 + Math.round(Math.random()*400));

      const form = new FormData();
      form.set("model", "gpt-image-1");
      form.set("image", new File([imageForEdit], "image.png", { type: "image/png" }));
      // keine Maske → das Modell darf das ganze Bild bearbeiten
      form.set("prompt", prompts[style] || "");
      form.set("n", "1");
      form.set("size", "1024x1024");

      try {
        const outUrl = await fetchOpenAIWithRetry(form, style, { retries: 4, baseDelayMs: 1000 });
        previews[style] = outUrl;
      } catch (e) {
        console.error(`❌ Stil '${style}' fehlgeschlagen:`, String(e));
        failed.push(style);
      }
    }

    if (Object.keys(previews).length === 0) {
      return res.status(502).json({ success: false, error: "Alle Stile fehlgeschlagen.", failed });
    }
    return res.status(200).json({ success: true, previews, failed });
  } catch (err) {
    console.error("generate-fix.js error:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}
