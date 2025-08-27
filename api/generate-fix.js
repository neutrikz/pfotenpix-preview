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
// ===== Prompts =====
function buildPrompts() {
  // Fixe, strikte Komposition (für alle Styles gleich)
  const comp =
    "Komposition: Motiv streng mittig und vollständig sichtbar. Das Tier belegt höchstens 20–25% der Bildbreite und -höhe; lasse ca. 40% negativen Raum auf jeder Seite. Nicht heranzoomen; kein enger Beschnitt; keine Rahmen. Hintergrund nahtlos erweitern. Für spätere Crops geeignet.";

  // Baseline: Wiedererkennbarkeit + Kunstwerk-Charakter (ohne Masken)
  const identity =
    "Wiedererkennbarkeit: dasselbe reale Haustier wie auf der Vorlage. Fellfarbe und -zeichnung mit charakteristischen Abzeichen in den MITTELTÖNEN erkennbar belassen; Augenfarbe/-form, Nase, Schnauze, Ohren und Schnurrhaare bleiben natürlich. Keine Accessoires, keine Typografie/Logos, keine neuen Vordergrundobjekte.";
  const art =
    "Kunstwerk-Charakter: deutliche Farbstimmung, Glow/Halation und lokale Kontraste sind willkommen. Stil-Effekte wirken vor allem in Lichtern/Schatten; Mitteltöne nicht hart umfärben.";

  const quality =
    "Drucktaugliche Studioqualität, fotorealistische Details, sRGB, saubere Kanten, sanfte lokale Tonwertsteuerung.";

  return {
    // ——— NEON (stark überzeichnet, Cyan/Magenta) ———
    neon: [
      "Galerie-tauglicher Neon-Look: sehr kräftige, additive Rim-Lights — links intensives Cyan/Türkis, rechts sattes Magenta/Pink; optional ein warmer Orange-Kicker in den Highlights.",
      "Additives Licht (Screen/Lighten): Konturen dürfen stark glühen, aber Mitteltöne der Fell-Albedo bleiben lesbar; weiße Brust bleibt weiß/creme. Halation/Glow sichtbar, feiner atmosphärischer Dunst.",
      "Dunkler Indigo→Violett-Hintergrundverlauf, dezent texturiert, ohne harte Strukturen. Augen klar mit farbigen Catchlights; Schnurrhaare und Fellkanten sehr scharf, kein Oversoften.",
      identity, art, comp, quality
    ].join(" "),

    // Die übrigen Stile – frisch, aber moderat künstlerisch
    cinematic: [
      "Deutlich filmischer Look: spürbare Teal/Orange-Gradierung, feines Filmkorn, leichte anamorphe Bokeh-Lichter im Hintergrund, sanfter Bloom auf Highlights.",
      "Schwärzen tief mit Zeichnung, leichte Vignette. Fellmuster natürlich; keine harte globale Umfärbung der Mitteltöne.",
      identity, art, comp, quality
    ].join(" "),

    lowkey: [
      "Dramatisches Low-Key-Studio auf tiefem Graphit/Schwarz mit gerichteter Edge-/Rembrandt-Lichtführung.",
      "Motiv klar heller als der Hintergrund: Gesicht und Brust deutlich lesbar, sanfte Glanzlichter an Fellkanten, dezenter Bloom; keine Silhouette, nichts säuft ab.",
      identity, art, comp, quality
    ].join(" "),

    highkey: [
      "Strahlendes High-Key-Porträt: fast weißer Hintergrund, große weiche Lichtquellen, sehr sanfte Schatten, leichter Glow.",
      "Airy und modern; Konturen sauber, Augen lebendig, Fellzeichnung klar.",
      identity, art, comp, quality
    ].join(" "),

    pastell: [
      "Eleganter Pastell-Look: matte, cremige Hintergrundverläufe (Sage/Sand/Blush) mit diffusem, weichem Licht.",
      "Leichte painterly-Textur im Hintergrund erlaubt; Motiv bleibt natürlich scharf in Gesicht/Augen.",
      identity, art, comp, quality
    ].join(" "),

    vintage: [
      "Zeitloser Vintage-Look: zarter Elfenbein-/leichter Sepia-Ton, feines analoges Grain, behutsame Halation.",
      "Hintergrund darf Papier-/Fasercharakter andeuten; Fellfarben des Tiers in den Mitteltönen glaubwürdig.",
      identity, art, comp, quality
    ].join(" "),

    steampunk: [
      "Warmer Steampunk-Tonwert mit Messing/Kupfer-Palette im HINTERGRUND (unscharfes industrielles Bokeh).",
      "Warmes Wolfram-Keylight + kühleres Rim; stilisiert aber ohne harte Umfärbung der Mitteltöne am Fell.",
      identity, art, comp, quality
    ].join(" "),

    natural: [
      "Edler Neutral-Studio-Look: ausgewogene Farben, sanfter Verlaufshintergrund, subtile Klarheit.",
      "Leichte Vignette/Glow für Tiefe, insgesamt realistisch und ruhig.",
      identity, art, comp, quality
    ].join(" "),
  };
}




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
