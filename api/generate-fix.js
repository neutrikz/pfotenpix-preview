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

/* =======================================================================
   PFPX – Prompt-Baustein (Drop-in für generate-fix, 1-Pass)
   Fokus:
   - Stärkere Wiedererkennbarkeit (Landmark/Pattern-Lock)
   - Kräftigerer NEON-Hintergrund ohne Fell-Midtöne zu verfärben
   - Croppbar für Hoch und Quer (viel Negativraum)
   ======================================================================= */

/* ---------- Negatives (unterbinden Cartoon/Drift/Recolor) ---------- */
const PFPX_NEG = [
  // Stil / Render
  "cartoon, anime, comic, 3D render, vector art, painting, sketch, lineart",
  // Uncanny / Material
  "plastic, waxy, porcelain, doll-like, uncanny valley, oversoften, airbrush",
  // Geometrie / Breed-Drift / Augen
  "breed change, skull reshaped, wrong muzzle, altered blaze stripe, wrong mask pattern",
  "altered inter-ocular distance, large eyes, baby-doll eyes, closer eyes, extra eyes",
  "misplaced nose, asymmetric eyes, deformed pupils",
  // Recolor / Tonwerte
  "global midtone recolor, coat recolor, color wash over midtones, blown highlights, crushed blacks",
  // Komposition / Artefakte
  "tight crop, macro close-up, cut ears, cut whiskers, frame, border, caption, text, logo, watermark",
  "blur, motion blur, smear, smudge, ringing, over-sharpen halos, heavy noise"
].join(", ");

/* ---------- Stil-Prompts: konservativ, mit hartem Landmark-/Pattern-Lock ---------- */
function buildPrompts() {
  // Komposition mit viel Luft (für Hoch & Quer)
  const comp =
    "Composition: subject perfectly centered and fully visible; " +
    "animal occupies ~16–22% of frame width and height; " +
    "keep ~40–55% negative space on left and right, and ~20–30% headroom/footroom; " +
    "no tight crop or borders; extend background seamlessly for future crops; " +
    "neutral, stable pose (front or slight 3/4), no leaning.";

  // Landmark-Lock (verhindert andere Gesichtsgeometrie/Augenabstand)
  const identity =
    "Identity lock: reproduce the exact animal from the photo. " +
    "Preserve face landmarks 1:1 — skull silhouette, ear base width and ear tip angle, " +
    "muzzle length/width ratio, nasal bridge and nose leather shape/position, " +
    "inter-ocular distance and adult eye size (do not enlarge), " +
    "forehead wrinkle & blaze stripe topology, cheek mask edges and whisker pads.";

  // Fell/Pattern-Lock (Brust/Beine/Masken dürfen NICHT umgefärbt werden)
  const coat =
    "Coat fidelity: keep midtone albedo and all characteristic markings and white patches " +
    "(chest wedge, legs, blaze/mask) exactly as in the photo. " +
    "Apply style primarily to highlights and shadows; do not recolor midtones.";

  const quality =
    "Photorealistic studio detail, crisp whiskers and fur edges, clean sRGB, " +
    "gentle local tone mapping, subtle clarity, no excessive sharpening.";

  return {
    /* ---------------------- NEON (verstärkt) ---------------------- */
    neon: [
      "Premium neon portrait: dual additive rim lights — strong cyan/turquoise from camera-left " +
        "and saturated magenta/pink from camera-right; optional warm orange kicker only in speculars.",
      // **Hintergrund deutlich stärker**, Fell-Midtöne neutral halten
      "Background neon boost: highly luminous indigo→violet gradient with saturated cyan/magenta haze, " +
        "soft radial glow, subtle volumetric fog and faint bokeh light streaks; " +
        "background glow intensity high; edge glow ++; " +
        "do not push neon into midtones of the coat.",
      "Additive lighting (screen/lighten) with halation along contours; " +
        "clear eyes with coloured catchlights; no global midtone colour shift on the subject.",
      identity, coat, comp, quality
    ].join(" "),

    cinematic: [
      "Cinematic grade: restrained teal/orange, fine grain, soft highlight bloom; deep but detailed blacks; slight vignette.",
      identity, coat, comp, quality
    ].join(" "),

    lowkey: [
      "Dramatic low-key studio on graphite/near-black with controlled Rembrandt/edge lighting; " +
      "face and chest readable, no silhouette.",
      identity, coat, comp, quality
    ].join(" "),

    highkey: [
      "Bright airy high-key portrait with large soft sources and near-white background; gentle glow.",
      identity, coat, comp, quality
    ].join(" "),

    pastell: [
      "Elegant pastel look: matte creamy gradients (sage/sand/blush) with soft diffuse light; painterly texture only in background.",
      identity, coat, comp, quality
    ].join(" "),

    vintage: [
      "Timeless vintage: subtle ivory/soft sepia, fine analog grain, restrained halation; background paper/fiber hint allowed.",
      identity, coat, comp, quality
    ].join(" "),

    steampunk: [
      "Warm steampunk tone: brass/copper palette mainly in the background (soft industrial bokeh); " +
      "warm tungsten key plus cooler rim.",
      identity, coat, comp, quality
    ].join(" "),

    natural: [
      "Refined neutral studio look: balanced colour, soft backdrop gradient, light vignette for depth.",
      identity, coat, comp, quality
    ].join(" "),
  };
}

/**
 * 1-Pass Pipeline (auch NEON): Du rufst weiter nur EIN Render auf.
 * Erwartet deine Render-Funktion:
 *   render({ image, prompt, negative, strength, cfg, seed, width, height })
 */
async function runPipeline(image, style, seed, render) {
  const PROMPTS = buildPrompts();

  // Portrait 3:4 mit sehr viel Luft -> Hoch & Quer sicher croppbar
  const WIDTH  = 1024;
  const HEIGHT = 1365;

  // Standard-Werte: Landmark-freundlich
  let strength = 0.30;  // 0.28–0.32: je niedriger, desto ID-treuer
  let cfg      = 2.7;   // 2.5–2.9: kleiner = weniger globaler Stil-Drift

  if (style === 'neon') {
    // NEON kräftiger Hintergrund, aber weiterhin ID-schonend
    strength = 0.30;    // genug Glow ohne Geometrie-Shift
    cfg      = 2.75;    // etwas mehr Look, Fell-Midtöne bleiben stabil
  }

  const prompt = PROMPTS[style] || PROMPTS.natural;

  const out = await render({
    image,
    prompt,
    negative: PFPX_NEG,
    strength,
    cfg,
    seed,
    width: WIDTH,
    height: HEIGHT
  });

  return out?.image ?? out;
}

/* ===== Exports (ESM & CJS) ===== */
export { PFPX_NEG, buildPrompts, runPipeline };
try { if (typeof module !== "undefined") module.exports = { PFPX_NEG, buildPrompts, runPipeline }; } catch {}






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
