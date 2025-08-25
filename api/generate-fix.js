// /api/generate-fix.js – Edits mit Outpainting + Stil, optionaler Kompositionsrand
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
  const parts = body
    .split(delim)
    .filter((p) => p && p !== "--" && p !== closeDelim);
  const fields = {},
    files = {};
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
      if (j > -1)
        headers[line.slice(0, j).trim().toLowerCase()] = line
          .slice(j + 1)
          .trim();
    }
    const cd = headers["content-disposition"] || "";
    const name = (cd.match(/name="([^"]+)"/i) || [])[1];
    const filename = (cd.match(/filename="([^"]+)"/i) || [])[1];
    const ctype = headers["content-type"] || "";
    if (!name) continue;
    if (filename) {
      files[name] = {
        filename,
        contentType: ctype || "application/octet-stream",
        buffer: Buffer.from(rawContent, "binary"),
      };
    } else {
      fields[name] = Buffer.from(rawContent, "binary").toString("utf8");
    }
  }
  return { fields, files };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withJitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3));

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
      const reqId =
        resp.headers?.get?.("x-request-id") ||
        resp.headers?.get?.("x-requestid") ||
        "";
      const txt = await resp.text();
      let json;
      try {
        json = JSON.parse(txt);
      } catch {
        json = null;
      }
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
      const wait = Math.max(
        withJitter(baseDelayMs * Math.pow(2, attempt - 1)),
        retryAfter * 1000
      );
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

// ===== Prompts (mit Kompositionshinweis) =====
function buildPrompts(userText) {
  const guardrails = [
    "This is the same real pet; preserve the exact species and identity.",
    "Keep anatomy and facial proportions unchanged; no cartoonification.",
    "Ultra-detailed, artifact-free; suitable for fine-art printing.",
    "Composition: subject centered with generous negative space; subject occupies about 70% of the frame; extend and complete the surrounding background seamlessly into the margins."
  ].join(" ");

  const nat = [
    "High-end studio portrait retouch, premium magazine quality.",
    "Soft diffused key light with subtle rim; refined micro-contrast in fur; elegant neutral backdrop with smooth falloff.",
    "No HDR look, no plastic skin.",
    guardrails,
    userText ? `If text is provided, integrate it tastefully and small: "${userText}".` : ""
  ].join(" ");

  const bw = [
    "Fine-art black and white conversion (true grayscale).",
    "Deep blacks, controlled highlights, rich midtones; delicate film grain; crisp whiskers and eyes; dramatic directional lighting.",
    "No color tints.",
    guardrails,
    userText ? `If text is provided, render in monochrome, subtle: "${userText}".` : ""
  ].join(" ");

  const neon = [
    "Neon pop-art overlay while preserving the exact pet identity and silhouette.",
    "Cyan, magenta and orange rim-light strokes following fur contours; smooth neon gradients with gentle halation and glow on a dark background.",
    guardrails,
    userText ? `Add matching neon typography, small and tasteful: "${userText}".` : ""
  ].join(" ");

  return { natural: nat, "schwarzweiß": bw, neon };
}

// ===== Outpainting-Canvas (Motiv kleiner + transparente Ränder) =====
async function makeOutpaintCanvas(inputBuffer, targetSize, marginPct) {
  // marginPct je Seite (0.00–0.30); Motivgröße = 1 - 2*margin
  const m = Math.max(0, Math.min(marginPct || 0, 0.30));
  const subjectSize = Math.round(targetSize * (1 - 2 * m));
  const pad = Math.round(targetSize * m);

  // Motiv verkleinern (transparenter Hintergrund)
  const subjectPng = await sharp(inputBuffer)
    .resize(subjectSize, subjectSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // Leere Canvas + zentriert einbetten
  const canvas = await sharp({
    create: {
      width: targetSize,
      height: targetSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
    .composite([{ input: subjectPng, left: pad, top: pad }])
    .png()
    .toBuffer();

  return canvas; // Transparente Ränder → werden von OpenAI outgepaintet
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null,
      userText = "",
      requestedStyles = null,
      composeMargin = null;

    // Standardwerte
    const SIZE = 1024;
    const COMPOSE_MARGIN_DEFAULT = 0.12; // 12% je Seite ≈ Motiv 76% – passe hier an (z.B. 0.10)

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart (no boundary)" });
      const { fields, files } = parseMultipart(await readRawBody(req), m[1]);
      const f = files["file"];
      if (!f?.buffer) return res.status(400).json({ error: "No file uploaded" });
      sourceBuffer = f.buffer;
      userText = (fields["custom_text"] || fields["text"] || "").toString();
      if (fields["styles"]) {
        try {
          const s = JSON.parse(fields["styles"]);
          if (Array.isArray(s)) requestedStyles = s;
        } catch {}
      }
      if (fields["compose_margin"]) {
        const v = parseFloat(fields["compose_margin"]);
        if (Number.isFinite(v)) composeMargin = v;
      }
    } else if (ctype.includes("application/json")) {
      const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");
      userText = body.userText || "";
      if (Array.isArray(body.styles)) requestedStyles = body.styles;
      if (body.compose_margin != null) {
        const v = parseFloat(body.compose_margin);
        if (Number.isFinite(v)) composeMargin = v;
      }
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // Input auf 1024x1024 normieren (ohne zu beschneiden)
    const inputPng = await sharp(sourceBuffer)
      .resize(SIZE, SIZE, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // Outpainting-Canvas vorbereiten (Motiv kleiner + transparente Ränder)
    const margin = composeMargin == null ? COMPOSE_MARGIN_DEFAULT : composeMargin;
    const imageForEdit = margin > 0 ? await makeOutpaintCanvas(inputPng, SIZE, margin) : inputPng;

    const prompts = buildPrompts(userText);
    const allStyles = ["natural", "schwarzweiß", "neon"];
    const styles = requestedStyles && requestedStyles.length
      ? requestedStyles.filter((s) => allStyles.includes(s))
      : allStyles;

    const previews = {};
    const failed = [];

    for (const style of styles) {
      await sleep(250 + Math.round(Math.random() * 400)); // kleiner Cooldown

      const form = new FormData();
      form.set("model", "gpt-image-1");
      // Wichtig: PNG mit transparenter Randzone → OpenAI füllt nur die Ränder
      form.set("image", new File([imageForEdit], "image.png", { type: "image/png" }));
      // Keine Maske übergeben → transparente Pixel sind die Edit-Zone
      form.set("prompt", prompts[style] || "");
      form.set("n", "1");
      form.set("size", "1024x1024"); // Konto-abhängig; 1024 ist überall erlaubt

      try {
        const outUrl = await fetchOpenAIWithRetry(form, style, { retries: 4, baseDelayMs: 1000 });
        previews[style] = outUrl; // http-URL ODER data:URL
      } catch (e) {
        console.error(`❌ Stil '${style}' fehlgeschlagen:`, String(e));
        failed.push(style);
      }
    }

    if (Object.keys(previews).length === 0) {
      return res.status(502).json({ success: false, error: "Alle Stile fehlgeschlagen.", failed });
    }
    return res.status(200).json({ success: true, previews, failed, compose_margin: margin });
  } catch (err) {
    console.error("generate-fix.js error:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}
