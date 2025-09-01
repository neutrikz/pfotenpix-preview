// /api/generate-fix.js — Background-only Neon edit (single pass) with identity lock
// Version: PFPX-2025-09b (headroom + slight brighten)
import sharp from "sharp";
import { FormData, File } from "formdata-node";

export const config = { api: { bodyParser: false } };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERSION = "PFPX-2025-09b";

// ================= CORS =================
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "x-pfpx-version,x-pfpx-style-final"
  );
}

// ================= Utils ================
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
  for (let raw of parts) {
    if (raw.startsWith(CRLF)) raw = raw.slice(CRLF.length);
    const sep = CRLF + CRLF;
    const i = raw.indexOf(sep);
    if (i === -1) continue;
    const rawHeaders = raw.slice(0, i);
    let rawContent = raw.slice(i + sep.length);
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

function extractUrlOrDataUri(json) {
  const item = json?.data?.[0];
  if (!item) return null;
  if (item.url) return item.url;
  if (item.b64_json) return `data:image/png;base64,${item.b64_json}`;
  return null;
}

async function fetchOpenAIEdits(form) {
  const resp = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.headers },
    body: form,
  });
  const txt = await resp.text();
  let json;
  try {
    json = JSON.parse(txt);
  } catch {
    json = null;
  }
  if (!resp.ok) {
    const msg = json?.error?.message || `HTTP ${resp.status}`;
    throw new Error(msg);
  }
  const out = extractUrlOrDataUri(json);
  if (!out) throw new Error("OpenAI edit returned no image.");
  return out;
}

// ============ Canvas + Maske ============
// Rückt das Motiv etwas nach unten (mehr Luft oben) und hellt es leicht auf.
async function makeOutpaintCanvasAndMask(inputBuffer, targetSize, opts = {}) {
  const {
    marginPct = 0.36,       // Motiv kleiner → landscape-tauglich
    headroomTopPct = 0.08,  // zusätzliche Luft oben (verschiebt Motiv nach unten)
    brighten = 0.08,        // Motiv minimal heller (0.00–0.15 sinnvoll)
    maskFeatherPx = 8       // weicher Maskenrand (für minimalen Rim-Glow)
  } = opts;

  const size = targetSize;
  const m = Math.max(0, Math.min(marginPct, 0.49));

  // Grund-Pads (links/rechts symmetrisch):
  const padX = Math.round(size * m);

  // Headroom: wir erhöhen den oberen Pad und verringern den unteren
  const shift = Math.round(size * headroomTopPct);
  const padTop = Math.max(0, Math.round(size * m) + shift);
  const padBottom = Math.max(0, Math.round(size * m) - shift);

  // Motiv-Größe (bezogen auf die kleinere nutzbare Innenfläche)
  const innerW = size - 2 * padX;
  const innerH = size - padTop - padBottom;
  const subjectSize = Math.min(innerW, innerH);

  // Motiv minimal aufhellen, ohne Farben stark zu verändern
  const subject = await sharp(inputBuffer)
    .resize(subjectSize, subjectSize, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .modulate({ brightness: 1 + brighten, saturation: 1.0 })
    .png()
    .toBuffer();

  // Canvas + Compositing
  const canvas = await sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: subject, left: padX, top: padTop }])
    .png()
    .toBuffer();

  // Ellipsen-Maske: innen SCHWARZ (geschützt), außen WEISS (editierbar)
  const rx = innerW / 2;
  const ry = innerH / 2;
  const cx = size / 2;
  const cy = padTop + innerH / 2;

  const feather = Math.max(0, Math.floor(maskFeatherPx));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <rect width="100%" height="100%" fill="white"/>
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="black"/>
      ${
        feather > 0
          ? `
        <defs>
          <radialGradient id="g" cx="50%" cy="50%" r="50%">
            <stop offset="80%" stop-color="black" stop-opacity="1"/>
            <stop offset="100%" stop-color="white" stop-opacity="1"/>
          </radialGradient>
        </defs>
        <ellipse cx="${cx}" cy="${cy}" rx="${rx + feather}" ry="${ry + feather}" fill="url(#g)"/>
        `
          : ""
      }
    </svg>`;

  const maskPng = await sharp(Buffer.from(svg)).png().toBuffer();

  return { canvas, maskPng, padX, padTop, padBottom, subjectSize };
}

// =============== Prompts ===============
function buildPrompts() {
  const compCommon =
    "Komposition: streng mittig, komplette Kopfform sichtbar, nicht heranzoomen. " +
    "Motiv ≤ 32–36% der Bildbreite und ≤ 35–40% der Bildhöhe; rundum 35–45% Negativraum. " +
    "Muss als 16:9-Landscape-Crop funktionieren (seitlich ausreichend Luft). " +
    "Keine engen Beschnitte, keine Rahmen, keine schräge Perspektive.";

  const compBust =
    "Framing: Half-Portrait (Brust bis Kopf). Oberer Brustbereich sichtbar; " +
    "kein Head-only, keine Pfoten/Beine/Unterkörper, kein Ganzkörper. " +
    "Kopf/Brust vorn klar, Hintergrund weich.";

  const identity =
    "WICHTIG: Bereiche innerhalb der Schutzmaske bleiben 1:1 erhalten; keine Veränderung am Tier. " +
    "Wiedererkennbarkeit absolut: Gesichtsproportionen, Augenabstand/-form, Ohren-Set, Schädelbreite, Nasenform/-länge, " +
    "Fellfarbe/-zeichnung und Abzeichen exakt wie im Original.";

  const quality =
    "Studioqualität, sRGB, fein detaillierte Fellstruktur und Schnurrhaare, saubere Kanten, " +
    "sanfte lokale Tonwertsteuerung, kein Wachslook, kein Oversoften.";

  const negCommon =
    "full body, whole body, legs, paws, lower body, lying, " +
    "tight framing, tight crop, extreme close-up, macro portrait, face-only, head-only, " +
    "fill frame, full-bleed, zoomed in, fisheye, wide distortion, caricature, anime, " +
    "3d render, painting, watercolor, oil paint, lowres, jpeg artifacts, " +
    "blurry, noise, banding, wrong breed, wrong coat color, wrong markings";

  const neonBg =
    "Hintergrund NUR außerhalb der Maske: kräftiger, aber diffuser Neon-Glow von tiefem Indigo (links) zu Violett–Magenta (rechts). " +
    "Feiner atmosphärischer Dunst/Schimmer, weiche Glow-Höfe, dezente großflächige Bokeh/Dust-Partikel. " +
    "Keine harten Lichtstrahlen, keine Laser/Godrays, keine Spotlights, keine zusätzlichen Objekte.";

  const neonLight =
    "Lichtwirkung: deutliche additive Rim-Lights (links Cyan/Teal, rechts Magenta/Pink) als Hintergrundlicht; " +
    "die Farbe darf knapp an die Kontur anliegen, ohne das Innere des Tiers zu übermalen.";

  const neonPrompt = [
    "Galerie-taugliches Neon-Portrait: Hintergrund modern, farbig, diffus – das Tier bleibt unverändert (geschützt durch Maske).",
    neonLight,
    neonBg,
    identity,
    compCommon,
    compBust,
    quality,
    "Bearbeite ausschließlich die freigegebenen (hellen) Maskenflächen."
  ].join(" ");

  const neonNeg = negCommon + ", hard godrays, laser beams, spotlight rays, posterized";

  return { neon: { prompt: neonPrompt, negative: neonNeg } };
}

// ============== Handler ================
export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const SIZE = 1024;

    // Default-Parameter (hier die gewünschten Änderungen):
    const DEFAULTS = {
      marginPct: 0.36,        // kleineres Motiv → besser croppbar (Landscape)
      headroomTopPct: 0.08,   // mehr Luft über dem Kopf
      brighten: 0.08,         // Motiv etwas heller
      maskFeatherPx: 8        // weiche Kante für sanften Rim-Glow
    };

    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null;
    let style = "neon";
    // optional overrides:
    let compose_margin = DEFAULTS.marginPct;
    let headroomTopPct = DEFAULTS.headroomTopPct;
    let brighten = DEFAULTS.brighten;

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart (no boundary)" });
      const { fields, files } = parseMultipart(await readRawBody(req), m[1]);
      const f = files["file"];
      if (!f?.buffer) return res.status(400).json({ error: "No file uploaded" });
      sourceBuffer = f.buffer;
      if (fields["style"]) style = String(fields["style"]).toLowerCase() || "neon";
      if (fields["compose_margin"]) {
        const v = parseFloat(fields["compose_margin"]);
        if (Number.isFinite(v)) compose_margin = v;
      }
      if (fields["headroom_top_pct"]) {
        const v = parseFloat(fields["headroom_top_pct"]);
        if (Number.isFinite(v)) headroomTopPct = v;
      }
      if (fields["brighten"]) {
        const v = parseFloat(fields["brighten"]);
        if (Number.isFinite(v)) brighten = v;
      }
    } else if (ctype.includes("application/json")) {
      const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");
      if (body.style) style = String(body.style).toLowerCase() || "neon";
      if (body.compose_margin != null) {
        const v = parseFloat(body.compose_margin);
        if (Number.isFinite(v)) compose_margin = v;
      }
      if (body.headroom_top_pct != null) {
        const v = parseFloat(body.headroom_top_pct);
        if (Number.isFinite(v)) headroomTopPct = v;
      }
      if (body.brighten != null) {
        const v = parseFloat(body.brighten);
        if (Number.isFinite(v)) brighten = v;
      }
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // 1) Canvas + Maske
    const { canvas, maskPng } = await makeOutpaintCanvasAndMask(sourceBuffer, SIZE, {
      marginPct: compose_margin,
      headroomTopPct,
      brighten,
      maskFeatherPx: DEFAULTS.maskFeatherPx
    });

    // 2) Prompt (nur Neon aktiv)
    const { neon } = buildPrompts();
    const prompt = neon.prompt + ` Negative: ${neon.negative}`;

    // 3) Ein einziger Edit-Call (Hintergrund)
    const form = new FormData();
    form.set("model", "gpt-image-1");
    form.set("image", new File([canvas], "image.png", { type: "image/png" }));
    form.set("mask", new File([maskPng], "mask.png", { type: "image/png" }));
    form.set("prompt", prompt);
    form.set("n", "1");
    form.set("size", "1024x1024");

    const outUrl = await fetchOpenAIEdits(form);

    res.setHeader("x-pfpx-version", VERSION);
    res.setHeader("x-pfpx-style-final", style);
    return res.status(200).json({
      success: true,
      previews: { [style]: outUrl },
      compose_margin,
      headroom_top_pct: headroomTopPct,
      brighten,
      version: VERSION
    });
  } catch (err) {
    console.error("generate-fix error:", err);
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
}
