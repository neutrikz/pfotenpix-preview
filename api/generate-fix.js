// /api/generate-fix.js – Outpainting + Single-Style + Diagnose (forced style supported)
// Version: PFPX 2025-08c
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

// ===== Prompts =====
function buildPrompts() {
  const comp =
    "Komposition: Motiv strikt mittig und vollständig sichtbar. Das Tier belegt höchstens 20–25% der Bildbreite und -höhe; lasse etwa 40% negativen Raum auf jeder Seite. Nicht heranzoomen; kein enger Beschnitt; keine Rahmen. Hintergrund nahtlos erweitern. Für spätere Crops geeignet.";
  const identity =
    "Gleiches reales Haustier; Identität, Fellzeichnung und Anatomie exakt beibehalten. Keine Accessoires, keine Cartoonisierung. Schnurrhaare, Augen, Nase und Fellstruktur scharf und natürlich.";
  const quality =
    "Drucktaugliche Studioqualität, saubere Kanten, fotorealistisch, sRGB, sanfte lokale Tonwertsteuerung.";

  return {
    "schwarzweiß": [
      "Edles Fine-Art-Schwarzweiß-Porträt: echte Neutralität, tiefe Schwarztöne, fein abgestufte Mitteltöne, kontrollierte Lichter.",
      "Feines analoges Korn, Mikro-Kontrast um Augen/Nase/Maul; hochwertiges, weiches Licht, dezente Vignette (nicht aufs Tier).",
      identity, comp, quality
    ].join(" "),
    "neon": [
      "Neon-Pop-Look mit subtilen Rim-Lights in Cyan, Magenta und Orange auf dunklem Verlauf.",
      "Weiche Neon-Verläufe, leichte Halation, hohe Klarheit an Augen/Schnurrhaaren, moderne Studioanmutung.",
      identity, comp, quality
    ].join(" "),
    "steampunk": [
      "Warmer Steampunk-Look: Messing/Kupfer/Dunkelholz-Palette; industrielles Bokeh nur im Hintergrund, unscharf.",
      "Warmes Wolfram-Licht, dezenter Dunst; kein Kitsch, keine Requisiten am Tier; Fokus bleibt auf dem Tier.",
      identity, comp, quality
    ].join(" "),
    "cinematic": [
      "Filmischer Look mit sanfter Teal/Orange-Gradierung, feines Filmkorn, dezente anamorphe Bokeh-Lichter.",
      "Kontrast filmisch aber natürlich; Fellfarben glaubwürdig, Augen lebendig, leichte Vignette.",
      identity, comp, quality
    ].join(" "),
    "pastell": [
      "Minimaler Pastell-Look: matte, cremige Hintergrundverläufe (Sage/Sand/Blush) mit sehr weichem, diffusem Licht.",
      "Zurückhaltende Sättigung, luftige Helligkeit, elegante helle Studiowirkung.",
      identity, comp, quality
    ].join(" "),
    "vintage": [
      "Hochwertiger Vintage-Look: subtil warmer Elfenbein-/Sepia-Ton, feines analoges Korn, leichte Halation.",
      "Hauch von Papier-/Druckcharakter nur im Hintergrund, sanfte Vignette, zeitlos und geschmackvoll.",
      identity, comp, quality
    ].join(" "),
    "highkey": [
      "Helles High-Key-Porträt auf fast weißem Hintergrund, breite weiche Lichtquellen, sehr sanfte Schatten.",
      "Keine ausgefressenen Highlights; klare Konturen, lebendige Augen; sauber, modern, luftig.",
      identity, comp, quality
    ].join(" "),
    "lowkey": [
      "Dramatisches Low-Key-Porträt auf tiefem Graphit/Schwarz, gerichtete Lichtführung (Edge-/Rembrandt-Licht).",
      "Tiefe Schwarztöne MIT Zeichnung, sanfte Glanzlichter an Fellkanten; stimmungsvoll ohne Absaufen.",
      identity, comp, quality
    ].join(" "),
    "natural": [
      "Neutraler Studio-Look mit sanfter Lichtführung, natürliche Farben, sauberer Hintergrundverlauf.",
      identity, comp, quality
    ].join(" "),
  };
}

// ===== Stil-Normalisierung =====
const ALLOWED = ["schwarzweiß","neon","steampunk","cinematic","pastell","vintage","highkey","lowkey","natural"];
function normalizeStyle(s) {
  if (!s || typeof s !== "string") return null;
  let v = s.trim().toLowerCase();
  if (v === "schwarz-weiss" || v === "schwarzweiss" || v === "schwarz weiss" || v === "schwarz-weiß") v = "schwarzweiß";
  if (v === "high-key" || v === "high key") v = "highkey";
  if (v === "low-key"  || v === "low key")  v = "lowkey";
  return v;
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  const DIAG = {}; // Diagnose

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null;
    let composeMargin = null;

    // ---- Stil-Inputs sammeln (Body + Header + Query) ----
    let rawStylesField = null;       // originaler Body-String (falls vorhanden)
    let requestedStyles = null;      // Array aus Body
    let forcedStyleHeader = null;    // X-PFPX-Style
    let forcedStyleQuery  = null;    // ?style=

    // Query lesen
    try {
      const url = new URL(req.url, 'http://localhost');
      forcedStyleQuery = url.searchParams.get('style') || null;
      // Optional: ?styles=['...'] oder comma
      const stylesQP = url.searchParams.get('styles');
      if (!forcedStyleQuery && stylesQP) {
        try {
          const arr = JSON.parse(stylesQP);
          if (Array.isArray(arr) && arr[0]) forcedStyleQuery = String(arr[0]);
        } catch {
          const first = String(stylesQP).split(',')[0] || '';
          if (first) forcedStyleQuery = first;
        }
      }
    } catch {}

    // Header lesen
    forcedStyleHeader = (req.headers['x-pfpx-style'] || req.headers['x-pfpxstyle'] || '').toString() || null;

    // Body lesen
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

    // ---- Single-Style erzwingen (Priorität: Header > Query > Body[0]) ----
    let forced = forcedStyleHeader || forcedStyleQuery || null;
    DIAG.request_style_header = forcedStyleHeader || null;
    DIAG.request_style_query  = forcedStyleQuery  || null;

    // Wenn Body-Stile vorhanden, nehmen wir nur den ersten (Single-Style Produkt-Logik)
    if (!forced && Array.isArray(requestedStyles) && requestedStyles.length) {
      forced = String(requestedStyles[0]);
    }

    // Normalisieren
    let normalized = [];
    if (Array.isArray(requestedStyles) && requestedStyles.length) {
      normalized = requestedStyles.map(normalizeStyle).filter(Boolean);
    }
    // erzwungenen Stil vorrangig setzen
    let filtered = [];
    if (forced) {
      const nf = normalizeStyle(forced);
      if (nf && ALLOWED.includes(nf)) {
        filtered = [nf];
      }
    }
    // falls noch leer, ggf. aus Body-normalisiert nehmen
    if (filtered.length === 0 && normalized.length) {
      filtered = normalized.filter(s => ALLOWED.includes(s));
      if (filtered.length) filtered = [filtered[0]]; // Single-Style
    }

    // Fallback
    DIAG.request_styles_array = normalized;
    if (filtered.length === 0) {
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

    // Outpaint-Canvas
    const subjectSize = Math.round(SIZE * (1 - 2 * Math.max(0, Math.min(margin, 0.49))));
    const pad = Math.round(SIZE * Math.max(0, Math.min(margin, 0.49)));
    const subjectPng = await sharp(inputPng)
      .resize(subjectSize, subjectSize, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
      .png().toBuffer();
    const imageForEdit = await sharp({
      create: {
        width: SIZE, height: SIZE, channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 }
      }
    }).composite([{ input: subjectPng, left: pad, top: pad }]).png().toBuffer();

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
        previews[style] = outUrl; // 🔐 Key = gewünschter Stil
      } catch (e) {
        console.error(`❌ Stil '${style}' fehlgeschlagen:`, String(e));
        failed.push(style);
      }
    }

    DIAG.upstream_previews_keys = Object.keys(previews);
    DIAG.upstream_failed = failed;

    if (Object.keys(previews).length === 0) {
      return res.status(502).json({ success: false, error: "Alle Stile fehlgeschlagen.", diag: DIAG });
    }

    return res.status(200).json({
      success: true,
      previews,
      failed,
      compose_margin: margin,
      diag: DIAG,
      version: "PFPX-2025-08c"
    });
  } catch (err) {
    console.error("generate-fix.js error:", err);
    return res.status(500).json({ error: "Interner Serverfehler", diag: DIAG || null });
  }
}
