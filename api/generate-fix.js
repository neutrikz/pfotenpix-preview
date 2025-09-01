// /api/generate-fix.js – Outpainting mit Schutz-Maske (Landscape-safe) + Single-Style + Diagnose-Header
// Version: PFPX-2025-09a
import sharp from "sharp";
import { FormData, File } from "formdata-node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const config = { api: { bodyParser: false } };
const VERSION = "PFPX-2025-09a";

/* ===================== CORS ===================== */
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "x-request-id,retry-after,x-pfpx-version,x-pfpx-style-header,x-pfpx-style-query,x-pfpx-style-final,x-pfpx-styles-array"
  );
}

/* =========== Diagnose-Header Setter ============ */
function setDiagHeaders(res, { styleHeader, styleQuery, normalized, finalStyle, version }) {
  try {
    res.setHeader("x-pfpx-version", String(version || VERSION));
    res.setHeader("x-pfpx-style-header", String(styleHeader || ""));
    res.setHeader("x-pfpx-style-query", String(styleQuery || ""));
    res.setHeader("x-pfpx-style-final", String(finalStyle || ""));
    res.setHeader("x-pfpx-styles-array", JSON.stringify(normalized || []));
  } catch (_) {}
}

/* =================== Helpers =================== */
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

/* ============== Outpainting + Maske ============== */
/**
 * Baut das quadratische Canvas **und** eine passende **Maske**:
 * - Hintergrund TRANSPARENT in der Maske ⇒ darf editiert werden (Neon/Glow)
 * - Motiv OPÁK (weiß) ⇒ bleibt unverändert (Größe/Identität)
 * - Zusatz: schmaler transparenter Ring um das Motiv (rimPct) für Rimlights
 */
async function makeOutpaintCanvas(inputBuffer, targetSize, marginPct, rimPct = 0.05) {
  const m   = Math.max(0, Math.min(marginPct ?? 0.0, 0.49));  // z.B. 0.46..0.48
  const rim = Math.max(0.0, Math.min(rimPct, 0.15));          // z.B. 0.05..0.09

  const subjectSize = Math.round(targetSize * (1 - 2 * m));
  const pad         = Math.round(targetSize * m);

  // Motiv verkleinern
  const subjectPng = await sharp(inputBuffer)
    .resize(subjectSize, subjectSize, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
    .png()
    .toBuffer();

  const blank = {
    create: { width: targetSize, height: targetSize, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
  };

  // 1) Bild (Motiv auf Bühne)
  const imagePng = await sharp(blank)
    .composite([{ input: subjectPng, left: pad, top: pad }])
    .png()
    .toBuffer();

  // 2) Maske: weißer (OPAK) Block = geschützt; Hintergrund bleibt transparent = editierbar
  const ring = Math.round(targetSize * rim);
  const protectedBlock = await sharp({
    create: {
      width:  subjectSize + ring * 2,
      height: subjectSize + ring * 2,
      channels: 4,
      background: { r:255, g:255, b:255, alpha:1 }  // OPAK = BEHALTEN
    }
  }).png().toBuffer();

  const maskPng = await sharp(blank)
    .composite([{ input: protectedBlock, left: Math.max(0, pad - ring), top: Math.max(0, pad - ring) }])
    .png()
    .toBuffer();

  return { imagePng, maskPng };
}

/* ============== Prompts (Landscape-safe) ============== */
/**
 * Prompt-Bausteine (Half-Portrait + Landscape-safe + stärkerer Neon-Glow/Rimlights)
 */
function buildPrompts() {
  // Querformat-tauglich + Größen-Limits (bewusst kleiner)
  const compCommon =
    "Komposition: streng mittig, komplette Kopfform sichtbar, nicht heranzoomen. " +
    "Motiv ≤ 38–42% der Bildbreite und ≤ 42–45% der Bildhöhe; rundum 30–40% Negativraum. " +
    "Muss auch als 16:9-Landscape-Crop funktionieren (seitlich ausreichend Luft). " +
    "Keine engen Beschnitte, keine Rahmen, keine schräge Perspektive.";

  // Half-Portrait klar erzwingen
  const compBust =
    "Framing: Half-Portrait (Brust bis Kopf). Oberer Brustbereich sichtbar; " +
    "kein Head-only, keine Pfoten/Beine/Unterkörper, kein Ganzkörper, kein liegendes Vollformat. " +
    "Kopf und Brust vorn klar, Hintergrund weich.";

  // Wiedererkennbarkeit / Identität
  const identity =
    "Wiedererkennbarkeit: dasselbe reale Tier wie auf der Vorlage. " +
    "Gesichtsproportionen exakt: Augenabstand/-form, Ohren-Set/Neigung, Schädelbreite, Nasenform/-länge. " +
    "Fellfarbe/-zeichnung nach Mitteltönen; charakteristische Abzeichen/Maske/Stirnfalten/helle Bereiche originalgetreu. " +
    "Nichts erfinden, nichts weglassen; keine Accessoires, keine Typografie, keine zusätzlichen Objekte.";

  const quality =
    "Studioqualität, sRGB, fein detaillierte Fellstruktur und Schnurrhaare, saubere Kanten, " +
    "sanfte lokale Tonwertsteuerung, kein Wachslook, kein Oversoften.";

  // Negativliste – Anti-Zoom/Anti-Closeup
  const negCommon =
    "full body, whole body, legs, paws, lower body, lying, " +
    "tight framing, tight crop, close crop, extreme close-up, macro portrait, face-only, head-only, " +
    "fill frame, full-bleed, zoomed in, enlarged face, fisheye, wide distortion, caricature, chibi, anime, " +
    "3d render, painting, oversaturated, posterized, watercolor, oil paint, lowres, jpeg artifacts, " +
    "blurry, noise, banding, wrong breed, wrong coat color, wrong markings, mismatched eye spacing, " +
    "asymmetric face, deformed anatomy, duplicate nose, extra ears";

  // NEON – stärkerer, aber diffuser Glow + kräftigere Rimlights
  const neonBg =
    "Hintergrund: ausgeprägter, aber diffuser Neon-Glow-Verlauf von tiefem Indigo (links) zu Violett–Magenta (rechts). " +
    "Feiner Dunst/atmosphärischer Schimmer, weiche Bloom-Höfe, dezente, großflächige Bokeh/Dust-Partikel. " +
    "Keine harten Lichtstrahlen, keine Laser/Godrays, keine Spotlights, keine Props.";

  const neonLight =
    "Licht: kräftige additive Rim-Lights – links intensives Cyan/Teal, rechts sattes Magenta/Pink; " +
    "optional ein ganz leichter warmer Orange-Kicker in den Highlights. " +
    "Neonwirkung v. a. an Fellkanten/Schattensäumen; Mitteltöne/Fell-Albedo erkennbar (weiße/creme Bereiche bleiben neutral).";

  const neonPrompt = [
    "Galerie-taugliches Neon-Portrait desselben Tieres, fotorealistisch, Brust bis Kopf.",
    neonLight,
    neonBg,
    identity,
    compCommon,
    compBust,
    quality,
  ].join(" ");

  const neonNeg = negCommon + ", hard godrays, laser beams, spotlight rays, high-contrast poster look";

  // Weitere Stile
  const cinematic = [
    "Filmischer Look mit sanfter Teal/Orange-Gradierung, feinem Filmkorn, " +
      "zarten anamorphischen Bokeh-Lichtern im Hintergrund, leichter Bloom.",
    "Schwärzen tief mit Zeichnung; Fellmuster natürlich; Mitteltöne nicht hart umfärben.",
    identity, compCommon, compBust, quality,
  ].join(" ");

  const lowkey = [
    "Dramatisches Low-Key-Studio auf tiefem Graphit/Schwarz mit gerichteter Edge/Rembrandt-Lichtführung.",
    "Motiv klar heller als Hintergrund; Gesicht/Brust deutlich lesbar; dezenter Bloom; nichts säuft ab.",
    identity, compCommon, compBust, quality,
  ].join(" ");

  const highkey = [
    "Strahlendes High-Key-Portrait: fast weißer Hintergrund, große weiche Lichtquellen, sehr sanfte Schatten, leichter Glow.",
    "Airy und modern; Konturen sauber, Augen lebendig, Fellzeichnung klar.",
    identity, compCommon, compBust, quality,
  ].join(" ");

  const pastell = [
    "Eleganter Pastell-Look: matte, cremige Hintergrundverläufe (Sage/Sand/Blush) mit diffusem weichem Licht.",
    "Leichte painterly-Textur im Hintergrund erlaubt; Gesicht/Augen natürlich scharf.",
    identity, compCommon, compBust, quality,
  ].join(" ");

  const vintage = [
    "Zeitloser Vintage-Look: zarter Elfenbein-/leichter Sepia-Ton, feines analoges Grain, behutsame Halation.",
    "Hintergrund darf Papier-/Fasercharakter andeuten; Fellfarben in Mitteltönen glaubwürdig.",
    identity, compCommon, compBust, quality,
  ].join(" ");

  const steampunk = [
    "Warmer Steampunk-Tonwert mit Messing/Kupfer-Palette im unscharfen Hintergrund-Bokeh (nur als Stimmung).",
    "Warmes Wolfram-Keylight + kühleres Rim; Mitteltöne am Fell nicht hart umfärben.",
    identity, compCommon, compBust, quality,
  ].join(" ");

  const natural = [
    "Edler Neutral-Studio-Look: ausgewogene Farben, sanfter Verlaufshintergrund, subtile Klarheit.",
    "Leichte Vignette/Glow für Tiefe, insgesamt ruhig und realistisch.",
    identity, compCommon, compBust, quality,
  ].join(" ");

  return {
    neon:      { prompt: neonPrompt, negative: neonNeg },
    cinematic: { prompt: cinematic,  negative: negCommon },
    lowkey:    { prompt: lowkey,     negative: negCommon },
    highkey:   { prompt: highkey,    negative: negCommon },
    pastell:   { prompt: pastell,    negative: negCommon },
    vintage:   { prompt: vintage,    negative: negCommon },
    steampunk: { prompt: steampunk,  negative: negCommon },
    natural:   { prompt: natural,    negative: negCommon },
  };
}

/* ============ Stil-Normalisierung ============ */
const ALLOWED = ["neon","steampunk","cinematic","pastell","vintage","highkey","lowkey","natural"];
function normalizeStyle(s) {
  if (!s || typeof s !== "string") return null;
  let v = s.trim().toLowerCase();
  if (v === "high-key" || v === "high key") v = "highkey";
  if (v === "low-key"  || v === "low key")  v = "lowkey";
  return v;
}

/* ===================== Handler ===================== */
export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  const DIAG = {};
  const styleHeaderRaw = Array.isArray(req.headers["x-pfpx-style"])
    ? req.headers["x-pfpx-style"][0]
    : (req.headers["x-pfpx-style"] || req.headers["x-style"] || "");
  let styleQueryRaw = "";
  try {
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

    let rawStylesField = null;
    let requestedStyles = null;

    const SIZE = 1024;
    const COMPOSE_MARGIN_DEFAULT = 0.46; // bewusst klein (Landscape-safe)

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

    // Diagnose
    DIAG.request_styles_sent_raw = rawStylesField ?? null;

    if ((!requestedStyles || !requestedStyles.length) && styleHeaderRaw) {
      requestedStyles = [ String(styleHeaderRaw) ];
      rawStylesField = String(styleHeaderRaw);
    }
    if ((!requestedStyles || !requestedStyles.length) && styleQueryRaw) {
      requestedStyles = [ String(styleQueryRaw) ];
      rawStylesField = String(styleQueryRaw);
    }

    let normalized = Array.isArray(requestedStyles) ? requestedStyles.map(normalizeStyle).filter(Boolean) : [];
    normalized = Array.from(new Set(normalized));
    let filtered = normalized.filter(s => ALLOWED.includes(s));

    DIAG.request_styles_array = normalized;
    DIAG.style_header = styleHeaderRaw || "";
    DIAG.style_query  = styleQueryRaw  || "";

    if (filtered.length === 0) {
      filtered = ["neon"];
      DIAG.fallback_used = true;
    }

    // Bild vorbereiten (quadratisches PNG)
    const inputPng = await sharp(sourceBuffer)
      .resize(SIZE, SIZE, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
      .png()
      .toBuffer();

    const margin = composeMargin == null ? COMPOSE_MARGIN_DEFAULT : composeMargin;
    DIAG.compose_margin = margin;

    // >>> NEU: Canvas + MASKE (Motiv geschützt, Hintergrund editierbar)
    // rimPct gibt einen schmalen editierbaren Ring für Rimlights (0.05–0.09)
    const { imagePng, maskPng } = await makeOutpaintCanvas(inputPng, SIZE, margin, 0.07);

    const stylesDef = buildPrompts();

    const previews = {};
    const failed = [];
    for (const style of filtered) {
      await sleep(150 + Math.round(Math.random()*300));

      const def = stylesDef[style] || stylesDef["natural"];
      const promptText = def?.prompt ? (def.prompt + (def.negative ? ` Vermeide: ${def.negative}` : "")) : "";

      const form = new FormData();
      form.set("model", "gpt-image-1");
      form.set("image", new File([imagePng], "image.png", { type: "image/png" }));
      form.set("mask",  new File([maskPng],  "mask.png",  { type: "image/png" })); // <- entscheidend
      form.set("prompt", promptText);
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
