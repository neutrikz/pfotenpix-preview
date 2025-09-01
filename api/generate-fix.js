// /api/generate-fix.js – Outpainting + Single-Style + Diagnose-Header (Patch A)
// Version: PFPX-2025-08c
import sharp from "sharp";
import { FormData, File } from "formdata-node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const config = { api: { bodyParser: false } };
const VERSION = "PFPX-2025-08c";

// ===== CORS =====
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "x-request-id,retry-after,x-pfpx-version,x-pfpx-style-header,x-pfpx-style-query,x-pfpx-style-final,x-pfpx-styles-array");
}

// ===== Diagnose-Header Setter (NEU) =====
function setDiagHeaders(res, { styleHeader, styleQuery, normalized, finalStyle, version }) {
  try {
    res.setHeader("x-pfpx-version", String(version || VERSION));
    res.setHeader("x-pfpx-style-header", String(styleHeader || ""));
    res.setHeader("x-pfpx-style-query", String(styleQuery || ""));
    res.setHeader("x-pfpx-style-final", String(finalStyle || ""));
    res.setHeader("x-pfpx-styles-array", JSON.stringify(normalized || []));
  } catch (_) {}
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

// ===== Outpainting-Canvas =====
async function makeOutpaintCanvas(inputBuffer, targetSize, marginPct) {
  const m = Math.max(0, Math.min(marginPct ?? 0, 0.49));
  const subjectSize = Math.round(targetSize * (1 - 2 * m));
  const pad = Math.round(targetSize * m);

  const subjectPng = await sharp(inputBuffer)
    .resize(subjectSize, subjectSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

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

  return canvas;
}




/* ============================================================
 * PFPX – Prompt & Pipeline v3
 *  - NEON: Zoom-out/Outpaint-Pass -> Neon-Style-Pass
 *  - Mehr Wiedererkennbarkeit (Augenabstand, Fellmittelton)
 *  - universell für Hoch/Quer (mehr negativer Raum)
 * ============================================================ */

/* ---------- Gemeinsame Negativ-Keywords ---------- */
const NEGATIVE_PROMPT = [
  // Framing/Fit
  'close-up, extreme close-up, tight crop, head-only crop, zoomed in, cropped ears, cropped chin, cut off head',
  // Anatomie/Artefakte
  'mutated, extra limbs, fused limbs, deformed, duplicate features, asymmetrical face',
  // Stil-Fehler
  'posterized, plastic skin, over-smooth, excessive sharpening, watercolor, line-art, cartoon',
  // Licht/Text
  'hard specular hotspot, blown highlights, heavy motion blur, strong banding, text, logo, watermark'
].join(', ');

/* ---------- Prompt-Bausteine ---------- */
function buildPrompts () {
  // Komposition: bewusst "kleiner" – für universelle Crops
  const comp =
    'Composition: full head incl. both ears and shoulders clearly visible. Subject occupies only ~18–22% of the frame; leave generous empty margins (≈40–45% negative space) on all sides. No tight crop, no zoom. Seamless extended background.';

  // Identität/Landmarken – Fellmitteltöne lesen lassen
  const identity =
    'Identity: exactly the same real pet as the reference. Preserve eye shape and distance, muzzle width, nose, ear shape, whisker pads and mask pattern. Keep fur midtones and markings readable; do not recolor the midtone albedo.';

  const quality =
    'Studio-grade, print-ready detail, crisp edges, clean sRGB tonality, subtle local contrast; no heavy NR or oversharpen.';

  // *** NEON (2-pass: erst neutraler Zoom-out, danach Neon-Licht) ***
  const neon_prepass =
    'Neutral zoom-out framing pass. Keep natural fur colors and markings, add only a soft, neutral gradient background (indigo to deep violet) with mild bloom; no strong colored rims yet.';

  const neon_style =
    'Gallery neon look: strong additive rim lights – left cyan/turquoise, right magenta/pink, optional warm orange kicker on highlights. Use additive/screen glow mostly on edges; keep midtone albedo of fur readable. Clear eyes with colored catchlights, razor-sharp whiskers/fur edges. Soft halation and faint atmospheric haze.';

  return {
    neon: {
      // Wir liefern beide Sätze – Prepass + Stilpass
      pre: [identity, comp, quality, neon_prepass].join(' '),
      style: [identity, comp, quality, neon_style].join(' ')
    },

    // Ein-Pass-Stile (falls du weitere nutzt)
    cinematic: [
      'Cinematic grading with gentle teal/orange split, fine film grain, mild bloom and anamorphic bokeh in the background.',
      'Deep blacks with detail, slight vignette; natural fur pattern; keep midtones neutral.',
      identity, comp, quality
    ].join(' '),

    lowkey: [
      'Dramatic low-key studio on graphite/black with directional Rembrandt/edge lighting. Face and chest clearly readable; no silhouettes.',
      identity, comp, quality
    ].join(' '),

    highkey: [
      'Bright high-key portrait on near-white background, very soft shadowing, airy modern feel, light glow.',
      identity, comp, quality
    ].join(' '),

    pastell: [
      'Elegant pastel look: matte, creamy background gradients (sage/sand/blush) with diffuse soft light. Slight painterly background texture allowed.',
      identity, comp, quality
    ].join(' '),

    vintage: [
      'Timeless ivory/soft sepia toning with fine analog grain and gentle halation. Background may hint subtle paper/fiber texture.',
      identity, comp, quality
    ].join(' '),

    steampunk: [
      'Warm brass/copper palette in the background (defocused industrial bokeh). Warm tungsten key + cooler rim; avoid recoloring fur midtones.',
      identity, comp, quality
    ].join(' '),

    natural: [
      'Refined neutral studio look: balanced color, soft gradient background, subtle clarity; realistic and calm.',
      identity, comp, quality
    ].join(' ')
  };
}

/* ---------- Render-Parameter (je Stil) ---------- */
const STYLE_PARAMS = {
  // Zwei-Pass NEON
  neon: {
    // Pass A: Zoom-out/Outpaint (etwas höhere Strength, neutral)
    pre:   { strength: 0.52, cfg: 3.0, width: 1024, height: 1365 },
    // Pass B: Stil – geringer, damit Landmarken bleiben
    style: { strength: 0.38, cfg: 3.2, width: 1024, height: 1365 }
  },

  // Default für 1-Pass Stile (falls du sie so renderst)
  default: { strength: 0.42, cfg: 3.0, width: 1024, height: 1365 }
};

/* ============================================================
 * Pipeline-Runner
 * - `render` ist dein bestehender interner Render-Call:
 *      async render({ image, prompt, negative, strength, cfg, seed, width, height })
 *   und gibt { image } oder { url } zurück.
 * ============================================================ */
async function runPipeline (imageBufferOrUrl, style, seed, render) {
  const PROMPTS = buildPrompts();

  if (style === 'neon') {
    const p = STYLE_PARAMS.neon;

    // Pass A – neutraler Zoom-out (Outpaint über Prompt)
    const passA = await render({
      image:   imageBufferOrUrl,
      prompt:  PROMPTS.neon.pre,
      negative: NEGATIVE_PROMPT,
      strength: p.pre.strength,
      cfg:      p.pre.cfg,
      seed,
      width:    p.pre.width,
      height:   p.pre.height
    });

    const imgA = passA.image || passA.url || passA; // defensive

    // Pass B – Neon-Stil auf das Ergebnis von A
    const passB = await render({
      image:   imgA,
      prompt:  PROMPTS.neon.style,
      negative: NEGATIVE_PROMPT,
      strength: p.style.strength,
      cfg:      p.style.cfg,
      seed,
      width:    p.style.width,
      height:   p.style.height
    });

    return passB.image || passB.url || passB;
  }

  // 1-Pass Fallback für übrige Stile
  const pp = STYLE_PARAMS.default;
  const prompt =
    typeof PROMPTS[style] === 'string'
      ? PROMPTS[style]
      : (PROMPTS.natural || ''); // safety

  const out = await render({
    image:   imageBufferOrUrl,
    prompt,
    negative: NEGATIVE_PROMPT,
    strength: pp.strength,
    cfg:      pp.cfg,
    seed,
    width:    pp.width,
    height:   pp.height
  });

  return out.image || out.url || out;
}

/* ============================================================
 * >>> So bindest du es ein:
 *  - In deiner bestehenden Handler-Funktion:
 *
 *    const finalImg = await runPipeline(uploadedImage, style, seed, render);
 *
 *  - `render` bleibt deine vorhandene Funktion, die den
 *    eigentlichen Model-Call macht (Stable Diffusion / SDXL / etc.).
 *  - Rückgabe (`finalImg`) ist wie bisher: reiche sie in deinen
 *    Storage/Response-Pfad weiter.
 * ============================================================ */






// ===== Stil-Normalisierung =====
const ALLOWED = ["neon","steampunk","cinematic","pastell","vintage","highkey","lowkey","natural"];
function normalizeStyle(s) {
  if (!s || typeof s !== "string") return null;
  let v = s.trim().toLowerCase();
  // Synonyme / Schreibvarianten
  if (v === "high-key" || v === "high key") v = "highkey";
  if (v === "low-key"  || v === "low key")  v = "lowkey";
  return v;
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  const DIAG = {}; // sammelt Diagnose-Daten
  // --- Diagnose: eingehende Header/Query (NEU) ---
  const styleHeaderRaw = Array.isArray(req.headers["x-pfpx-style"])
    ? req.headers["x-pfpx-style"][0]
    : (req.headers["x-pfpx-style"] || req.headers["x-style"] || "");
  let styleQueryRaw = "";
  try {
    // Next.js gibt req.query; Fallback: URL parsen
    if (req.query && typeof req.query.style !== "undefined") {
      styleQueryRaw = Array.isArray(req.query.style) ? req.query.style[0] : String(req.query.style || "");
    } else if (req.url) {
      const u = new URL(req.url, "http://localhost");
      styleQueryRaw = u.searchParams.get("style") || "";
    }
  } catch (_) {}

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null;
    let composeMargin = null;

    // Roh-Stil-Eingaben (für Diagnose)
    let rawStylesField = null;      // exakt erhaltene Zeichenkette (z. B. '["vintage"]' oder 'vintage')
    let requestedStyles = null;     // Array (evtl. vor Normalisierung)

    // Zielgröße
    const SIZE = 1024;
    const COMPOSE_MARGIN_DEFAULT = 0.40;

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart (no boundary)" });
      const { fields, files } = parseMultipart(await readRawBody(req), m[1]);
      const f = files["file"]; if (!f?.buffer) return res.status(400).json({ error: "No file uploaded" });
      sourceBuffer = f.buffer;

      if (fields["styles"] != null) {
        rawStylesField = fields["styles"];
        try { const t = JSON.parse(fields["styles"]); if (Array.isArray(t)) requestedStyles = t; } catch {}
      } else if (fields["style"] != null) {
        rawStylesField = fields["style"];
        requestedStyles = [ String(fields["style"]) ];
      }

      if (fields["compose_margin"] != null) {
        const v = parseFloat(fields["compose_margin"]);
        if (Number.isFinite(v)) composeMargin = v;
      }
    } else if (ctype.includes("application/json")) {
      const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/,"");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");

      if (Array.isArray(body.styles)) { rawStylesField = JSON.stringify(body.styles); requestedStyles = body.styles; }
      else if (typeof body.style === "string") { rawStylesField = body.style; requestedStyles = [ body.style ]; }

      if (body.compose_margin != null) {
        const v = parseFloat(body.compose_margin);
        if (Number.isFinite(v)) composeMargin = v;
      }
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // Diagnose: Rohdaten
    DIAG.request_styles_sent_raw = rawStylesField ?? null;

    // Fallback: Wenn kein Stil im Body kam, nutze ggf. Header oder Query NUR für Diagnose/Tests
    if ((!requestedStyles || !requestedStyles.length) && styleHeaderRaw) {
      requestedStyles = [ String(styleHeaderRaw) ];
      rawStylesField = String(styleHeaderRaw);
    }
    if ((!requestedStyles || !requestedStyles.length) && styleQueryRaw) {
      requestedStyles = [ String(styleQueryRaw) ];
      rawStylesField = String(styleQueryRaw);
    }

    // Normalisieren + validieren
    let normalized = Array.isArray(requestedStyles) ? requestedStyles.map(normalizeStyle).filter(Boolean) : [];
    // Duplikate raus
    normalized = Array.from(new Set(normalized));
    // Nur erlaubte
    let filtered = normalized.filter(s => ALLOWED.includes(s));

    // Diagnose
    DIAG.request_styles_array = normalized;
    DIAG.style_header = styleHeaderRaw || "";
    DIAG.style_query  = styleQueryRaw  || "";

    if (filtered.length === 0) {
      // Kein gültiger Stil → Neon als Fallback (wie bisher)
      filtered = ["neon"];
      DIAG.fallback_used = true;
    }

    // Bild vorbereiten
    const inputPng = await sharp(sourceBuffer)
      .resize(SIZE, SIZE, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
      .png()
      .toBuffer();

    const margin = composeMargin == null ? COMPOSE_MARGIN_DEFAULT : composeMargin;
    DIAG.compose_margin = margin;

    const imageForEdit = await makeOutpaintCanvas(inputPng, SIZE, margin);

    const prompts = buildPrompts();

    const previews = {};
    const failed = [];
    for (const style of filtered) {
      await sleep(150 + Math.round(Math.random()*300));

      const form = new FormData();
      form.set("model", "gpt-image-1");
      form.set("image", new File([imageForEdit], "image.png", { type: "image/png" }));
      form.set("prompt", prompts[style] || prompts["natural"] || "");
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

    // Diagnose: welche Keys kamen zurück
    DIAG.upstream_previews_keys = Object.keys(previews);
    DIAG.upstream_failed = failed;
    DIAG.version = VERSION;
    DIAG.endpoint = req.url || "";

    const finalStyle = (filtered && filtered[0]) || "";

    if (Object.keys(previews).length === 0) {
      setDiagHeaders(res, {
        styleHeader: styleHeaderRaw,
        styleQuery:  styleQueryRaw,
        normalized,
        finalStyle,
        version: VERSION
      });
      return res.status(502).json({ success: false, error: "Alle Stile fehlgeschlagen.", diag: DIAG });
    }

    setDiagHeaders(res, {
      styleHeader: styleHeaderRaw,
      styleQuery:  styleQueryRaw,
      normalized,
      finalStyle,
      version: VERSION
    });

    return res.status(200).json({
      success: true,
      previews,
      failed,
      compose_margin: margin,
      diag: DIAG,
      version: VERSION
    });
  } catch (err) {
    console.error("generate-fix.js error:", err);
    // Versuche auch im Fehlerfall Header mitzugeben
    try {
      setDiagHeaders(res, {
        styleHeader: styleHeaderRaw,
        styleQuery:  styleQueryRaw,
        normalized: [],
        finalStyle: "",
        version: VERSION
      });
    } catch(_) {}
    return res.status(500).json({ error: "Interner Serverfehler", diag: DIAG || null, version: VERSION });
  }
}
