// /api/generate-fix.js – Stabil (ohne Maske/Replicate), verfeinerte Stil-Prompts + Retries

import sharp from "sharp";
import { FormData, File } from "formdata-node"; // ⬅️ File nutzen für Upload-Parts

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PFPX_SECRET = "pixpixpix";

export const config = {
  api: { bodyParser: false }, // wichtig für multipart
};

// ---- Utils ----
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

  const fields = {};
  const files = {};

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
const withJitter = (ms) => Math.round(ms * (0.85 + Math.random() * 0.3)); // ±15%

async function fetchOpenAIWithRetry(form, styleName, { retries = 3, baseDelayMs = 900 } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`🟦 [${styleName}] OpenAI-Call Versuch ${attempt}/${retries}`);
      const resp = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.headers },
        body: form,
      });

      const reqId = resp.headers?.get?.("x-request-id") || resp.headers?.get?.("x-requestid") || "";
      const text = await resp.text();
      let json;
      try { json = JSON.parse(text); } catch { json = null; }

      // Erfolgsfall
      if (resp.ok && json?.data?.[0]?.url) {
        console.log(`🟩 [${styleName}] Erfolg (Versuch ${attempt})${reqId ? " – reqId: " + reqId : ""}`);
        return json.data[0].url;
      }

      // Fehler klassifizieren
      const is5xx = resp.status >= 500 && resp.status <= 599;
      const isServerErrPayload = json?.error?.type === "server_error";
      const shouldRetry = is5xx || isServerErrPayload;

      console.warn(`🟨 [${styleName}] Fehler (Versuch ${attempt})${reqId ? " – reqId: " + reqId : ""}`, {
        status: resp.status,
        body: json || text,
      });

      if (!shouldRetry || attempt === retries) {
        // Kein Retry mehr → harten Fehler zurückreichen
        const msg =
          json?.error?.message ||
          `OpenAI-Fehler (HTTP ${resp.status}) nach ${attempt} Versuch(en).`;
        lastError = new Error(msg);
        break;
      }

      // Backoff
      const delay = withJitter(baseDelayMs * Math.pow(2, attempt - 1));
      console.log(`⏳ [${styleName}] Retry in ${delay}ms …`);
      await sleep(delay);

    } catch (err) {
      // Netzwerk-/Fetch-Fehler → retrybar
      lastError = err;
      console.warn(`🟨 [${styleName}] Netzwerk-/Fetch-Error (Versuch ${attempt}):`, String(err));
      if (attempt === retries) break;
      const delay = withJitter(baseDelayMs * Math.pow(2, attempt - 1));
      console.log(`⏳ [${styleName}] Retry in ${delay}ms …`);
      await sleep(delay);
    }
  }
  throw lastError || new Error("Unbekannter Fehler bei OpenAI-Request");
}

// ---- Handler ----
export default async function handler(req, res) {
  console.log("✅ generate-fix.js gestartet (ohne Maske + Retries)");

  if (req.method !== "POST") return res.status(405).end();

  if (req.headers["x-pfpx-secret"] !== PFPX_SECRET) {
    console.warn("❌ Sicherheits-Token falsch oder fehlt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    console.log("ℹ️ Content-Type:", ctype);

    let sourceBuffer = null; // Bilddaten
    let userText = "";       // optionaler Prompt-Text

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart request (no boundary)" });
      const boundary = m[1];

      const raw = await readRawBody(req);
      const { fields, files } = parseMultipart(raw, boundary);

      const file = files["file"];
      if (!file || !file.buffer) {
        console.warn("❌ multipart: Feld 'file' fehlt");
        return res.status(400).json({ error: "No file uploaded" });
      }
      sourceBuffer = file.buffer;
      userText = (fields["custom_text"] || fields["text"] || "").toString();
      console.log("📥 Bild empfangen (multipart)");
    } else if (ctype.includes("application/json")) {
      const raw = await readRawBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8")); } catch { /* noop */ }
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");
      userText = body.userText || "";
      console.log("📥 Bild empfangen (JSON)");
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // --- 1) Eingabebild auf 1024x1024 PNG bringen (transparentes Padding statt Crop) ---
    const inputPng = await sharp(sourceBuffer)
      .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // --- 2) Stil-Prompts (Transformation des Tieres, Identität bewahren) ---
    const baseGuardrails = [
      "transform the entire animal subject (fur texture, lighting, color/grading), not only the background",
      "preserve identity, anatomy, proportions, and pose; keep facial features and whiskers intact",
      "keep eyes sharp with natural catchlights; no extra limbs, no distortions, no accessories unless present",
      "clean, elegant background that complements the style (no busy scene replacement)",
      "high-resolution detail; gallery-grade quality; avoid artifacts and posterization",
    ].join(". ") + ".";

    const promptNatural = [
      "Create a premium studio portrait of the pet with a realistic, high-end look",
      "soft diffused key light plus gentle rim light, refined micro-contrast on fur",
      "subtle color grading, tasteful retouch, true-to-life colors, elegant neutral backdrop",
      baseGuardrails,
    ].join(". ") + (userText ? ` Include the following text subtly in the artwork: "${userText}".` : "");

    const promptBW = [
      "Convert into a fine-art black-and-white portrait (full grayscale)",
      "deep rich blacks, bright yet controlled highlights, silver-gelatin print character",
      "high local contrast with delicate detail in the fur, subtle film grain, dramatic directional lighting",
      baseGuardrails,
    ].join(". ") + (userText ? ` Include the following text subtly in the artwork: "${userText}".` : "");

    const promptNeon = [
      "Transform the pet into a bold neon pop-art portrait",
      "vibrant saturated hues, cyan/magenta rim lights, tasteful contour glow around edges",
      "stylized fur strokes with smooth gradients and gentle halation; modern poster-worthy finish",
      "keep the subject clearly recognizable with crisp facial features",
      baseGuardrails,
    ].join(". ") + (userText ? ` Integrate the following text in a matching neon typography style: "${userText}".` : "");

    const styles = [
      { name: "natural",     prompt: promptNatural },
      { name: "schwarzweiß", prompt: promptBW },
      { name: "neon",        prompt: promptNeon },
    ];

    // --- 3) OpenAI Images Edits (ohne Maske → gesamtes Bild wird stilisiert) mit Retries ---
    const previews = {}; // { stilName: url }

    for (const style of styles) {
      console.log(`🎨 Sende an OpenAI (Stil: ${style.name})`);

      const form = new FormData();
      form.set("image", new File([inputPng], "image.png", { type: "image/png" }));
      form.set("prompt", style.prompt);
      form.set("n", "1");
      form.set("size", "1024x1024");
      form.set("response_format", "url");

      try {
        const url = await fetchOpenAIWithRetry(form, style.name, { retries: 3, baseDelayMs: 900 });
        previews[style.name] = url;
        console.log(`✅ Stil '${style.name}' erfolgreich generiert`);
      } catch (err) {
        console.error(`❌ OpenAI-Fehler bei Stil '${style.name}' nach Retries:`, String(err));
        return res
          .status(502)
          .json({ error: `OpenAI konnte den Stil '${style.name}' nach mehreren Versuchen nicht generieren.` });
      }
    }

    console.log("✅ Alle Varianten generiert");
    return res.status(200).json({ success: true, previews });

  } catch (err) {
    console.error("❌ Unerwarteter Fehler in generate-fix.js:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}
