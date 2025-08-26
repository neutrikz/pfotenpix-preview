// /api/generate-fix.js – Outpainting-Canvas (transparente Ränder) + strenger Kompositions-Prompt
// Version: PFPX 2025-08 – Single-Style Rendering mit 8 DE-Stilen (inkl. Legacy 'natural'-Fallback)
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

// ===== Outpainting-Canvas: Motiv verkleinern + transparente Ränder =====
async function makeOutpaintCanvas(inputBuffer, targetSize, marginPct) {
  // marginPct = Anteil je Seite (0.00–0.49). Motivbreite = 1 - 2*marginPct
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

  return canvas; // Transparente Randzonen → Modell outpaintet Hintergrund
}

// ===== Prompts – 8 Stile (DE), streng: Motiv max. 20–25 %, viel negativer Raum =====
function buildPrompts() {
  const comp =
    "Komposition: Motiv strikt mittig und vollständig sichtbar. " +
    "Das Tier belegt höchstens 20–25% der Bildbreite und -höhe; lasse etwa 40% negativen Raum auf jeder Seite. " +
    "Nicht heranzoomen; kein enger Beschnitt; keine Rahmen oder Bordüren. " +
    "Hintergrund nahtlos und kohärent aus der Originalszene heraus erweitern (Outpainting ohne harte Kanten). " +
    "Das Bild soll auch nachträgliche Hoch- oder Querformat-Crops gut verkraften.";

  const identity =
    "Gleiches reales Haustier; Identität, Fellzeichnung und Anatomie exakt beibehalten. " +
    "Proportionen und Gesichtsstruktur unverändert; keine Accessoires hinzufügen; keine Cartoonisierung. " +
    "Keine zusätzlichen Gliedmaßen oder Merkmale; keine Texte oder Logos. " +
    "Schnurrhaare, Augen, Nase und Fellstruktur scharf und natürlich, ohne Artefakte.";

  const quality =
    "Drucktaugliche Studioqualität, saubere Kanten, feines natürliches Bokeh, fotorealistisch, sRGB. " +
    "Sanfte lokale Tonwertsteuerung (Dodge & Burn) nur zur Betonung der natürlichen Details.";

  return {
    // 1) Schwarzweiß – extrem edel
    "schwarzweiß": [
      "Edles Fine-Art-Schwarzweiß-Porträt mit echter Neutralität (keine Farbstiche).",
      "Tiefe, samtige Schwarztöne mit klarer Zeichnung; fein abgestufte Mitteltöne und kontrollierte, nicht ausgefressene Lichter.",
      "Sehr feines analoges Korn; mikrofeine Kontrastakzente um Augen, Nase und Maul; weiches, hochwertiges Licht mit sanftem Verlauf.",
      "Leichte, geschmackvolle Vignette zur Motivführung – niemals auf dem Tier blockierend.",
      identity, comp, quality
    ].join(" "),

    // 2) Neon – Pop-Rimlight, edel
    "neon": [
      "Neon-Pop-Look mit subtilen Rim-Lights in Cyan, Magenta und Orange auf dunklem, sanft verlaufendem Hintergrund.",
      "Weiche Neon-Verläufe mit leichter Halation; Reflexe dezent, ohne das Fell unnatürlich einzufärben.",
      "Hohe Klarheit an Augen und Schnurrhaaren; edle, moderne Studioanmutung.",
      identity, comp, quality
    ].join(" "),

    // 3) Steampunk – warmes Messing, ohne Props
    "steampunk": [
      "Warmer Steampunk-Look: tonale Palette aus Messing, Kupfer und dunklem Holz; ein Hauch von industriellem Bokeh (Zahnräder/Ornamente) nur im Hintergrund, unscharf.",
      "Warmes Wolfram-Licht, dezente Rauch-/Dunststimmung; kein Kitsch, keine Requisiten am Tier.",
      "Fokus bleibt auf dem Tier; Hintergrund nur als stimmige Bühne.",
      identity, comp, quality
    ].join(" "),

    // 4) Cinematic – filmischer Look (Deutsch)
    "cinematic": [
      "Filmischer Porträt-Look mit sanfter Teal-/Orange-Gradierung: kühle Schatten, warme Highlights, sehr feines Filmkorn.",
      "Zarte anamorph wirkende Bokeh-Lichter im Hintergrund; minimaler Lens-Bloom; dezente Vignette zur Motivführung.",
      "Kontrastkurve filmisch, aber natürlich – Fellfarben glaubwürdig, Augen lebendig.",
      identity, comp, quality
    ].join(" "),

    // 5) Pastell – minimal, matt, airy
    "pastell": [
      "Minimalistischer Pastell-Look: matte, cremige Hintergrundverläufe (Sage/Sand/Blush) mit sehr weichem, diffusen Licht.",
      "Zurückhaltende Sättigung, luftige Helligkeit; sanfte Schatten, keine harten Kanten.",
      "Elegante, helle Studiowirkung ohne Plastik- oder Kaugummi-Effekt.",
      identity, comp, quality
    ].join(" "),

    // 6) Vintage – dezent, hochwertig
    "vintage": [
      "Hochwertiger Vintage-Look: subtil warmer Elfenbein-/Sepia-Ton, feines analoges Korn, sehr leichte Halation an Spitzlichtern.",
      "Hauch von Papier-/Druckcharakter nur im Hintergrund (dezent, niemals auf dem Tier); sanfte Vignette.",
      "Zeitlos, geschmackvoll – keine künstlichen Kratzer oder stark gealterten Artefakte.",
      identity, comp, quality
    ].join(" "),

    // 7) Highkey – hell, klar, ohne Clipping
    "highkey": [
      "Helles High-Key-Porträt auf beinahe weißem Hintergrund, breite weiche Lichtquellen, sehr sanfte Schatten.",
      "Keine ausgefressenen Highlights – Zeichnung in hellen Fellpartien bewahren; klare Konturen, lebendige Augen.",
      "Sauber, modern, luftig; trotzdem feine Mikrostruktur im Fell erhalten.",
      identity, comp, quality
    ].join(" "),

    // 8) Lowkey – tief, dramatisch, mit Zeichnung
    "lowkey": [
      "Dramatisches Low-Key-Porträt auf tiefem Graphit-/Schwarz-Hintergrund mit gerichteter Lichtführung (Rembrandt-/Edge-Light-Charakter).",
      "Tiefe Schwarztöne mit Zeichnung, sanfte Glanzlichter auf Fellkanten, deutliches aber elegantes Licht-/Schatten-Modelling.",
      "Stimmungsvoll, ohne das Tier im Schwarz versinken zu lassen.",
      identity, comp, quality
    ].join(" "),

    // Legacy-Fallback (nicht im Dropdown): neutraler Studio-Look
    "natural": [
      "Neutraler Studio-Look mit sanfter Lichtführung, natürliche Farben, präzise, saubere Darstellung.",
      "Eleganter, unaufdringlicher Hintergrund mit sanftem Verlauf.",
      identity, comp, quality
    ].join(" "),
  };
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null, requestedStyles = null, composeMargin = null;

    // Zielgröße (OpenAI erlaubt 1024 zuverlässig)
    const SIZE = 1024;
    // Default: 40% Rand je Seite → Motivbreite ~20%
    const COMPOSE_MARGIN_DEFAULT = 0.40;

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart (no boundary)" });
      const { fields, files } = parseMultipart(await readRawBody(req), m[1]);
      const f = files["file"]; if (!f?.buffer) return res.status(400).json({ error: "No file uploaded" });
      sourceBuffer = f.buffer;
      // single-style: client sendet ["<stil>"]
      if (fields["styles"]) { try { const s = JSON.parse(fields["styles"]); if (Array.isArray(s)) requestedStyles = s; } catch {} }
      if (fields["compose_margin"] != null) {
        const v = parseFloat(fields["compose_margin"]);
        if (Number.isFinite(v)) composeMargin = v;
      }
      // custom_text wird ignoriert (Feld entfernt), bleibt abwärtskompatibel
    } else if (ctype.includes("application/json")) {
      const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/,"");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");
      if (Array.isArray(body.styles)) requestedStyles = body.styles;
      if (body.compose_margin != null) {
        const v = parseFloat(body.compose_margin);
        if (Number.isFinite(v)) composeMargin = v;
      }
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // Input auf 1024x1024 normieren (contain, keine Beschneidung)
    const inputPng = await sharp(sourceBuffer)
      .resize(SIZE, SIZE, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
      .png()
      .toBuffer();

    // Outpainting-Canvas mit transparenten Randzonen (erzwingt viel Hintergrund)
    const margin = composeMargin == null ? COMPOSE_MARGIN_DEFAULT : composeMargin;
    const imageForEdit = await makeOutpaintCanvas(inputPng, SIZE, margin);

    // Prompts
    const prompts = buildPrompts();

    // Nur EIN Stil rendern (wie im Frontend gewählt). Fallback = 'neon' (sparsam).
    const ALLOWED = ["schwarzweiß","neon","steampunk","cinematic","pastell","vintage","highkey","lowkey","natural"]; // natural = legacy
    const DEFAULT_STYLES = ["neon"];
    const styles = (requestedStyles && requestedStyles.length)
      ? requestedStyles.filter(s => ALLOWED.includes(s))
      : DEFAULT_STYLES;

    const previews = {};
    const failed = [];

    for (const style of styles) {
      await sleep(200 + Math.round(Math.random()*300));

      const form = new FormData();
      form.set("model", "gpt-image-1");
      // keine Maske senden; die transparenten Flächen dienen effektiv als Outpaint-Bereich
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

    if (Object.keys(previews).length === 0) {
      return res.status(502).json({ success: false, error: "Alle Stile fehlgeschlagen.", failed, compose_margin: margin });
    }
    return res.status(200).json({ success: true, previews, failed, compose_margin: margin });
  } catch (err) {
    console.error("generate-fix.js error:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}
