// /api/generate-fix.js — Background-only Neon edit (single pass) with identity lock
// Version: PFPX-2025-09a
import sharp from "sharp";
import { FormData, File } from "formdata-node";

export const config = { api: { bodyParser: false } };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERSION = "PFPX-2025-09a";

// ============= CORS ==================
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "x-pfpx-version,x-pfpx-style-final"
  );
}

// ============= Utils =================
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// ============= Canvas / Mask =================
// Wir bauen ein 1024x1024-Canvas; das Original wird zentriert kleiner eingesetzt.
// (m ~ 0.34 => viel Negativraum, landscape-sicher)
async function makeOutpaintCanvas(inputBuffer, targetSize, marginPct) {
  const m = Math.max(0, Math.min(marginPct ?? 0.34, 0.49));
  const subjectSize = Math.round(targetSize * (1 - 2 * m));
  const pad = Math.round(targetSize * m);

  const subject = await sharp(inputBuffer)
    .resize(subjectSize, subjectSize, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  const canvas = await sharp({
    create: {
      width: targetSize,
      height: targetSize,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{ input: subject, left: pad, top: pad }])
    .png()
    .toBuffer();

  return { canvas, pad, subjectSize };
}

// Elliptische Masken (innen SCHWARZ = schützen; außen WEISS = editierbar).
// optional feather am Rand (Alpha-Kante), 0 = harte Kante.
async function makeEllipseMaskPNG(size, pad, featherPx = 0) {
  const innerW = size - 2 * pad;
  const innerH = size - 2 * pad;

  const rx = innerW / 2;
  const ry = innerH / 2;

  const cx = size / 2;
  const cy = size / 2;

  // Hart + optional Feather über zweite Ellipse mit halbtransparenter Kante
  const feather = Math.max(0, Math.floor(featherPx));
  const svg = `
  <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
    <!-- Grundfläche: WEISS (editierbar) -->
    <rect width="100%" height="100%" fill="white"/>
    <!-- Schutz: SCHWARZ -->
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
      <!-- Feather-Ring: von schwarz nach weiß (macht den Übergang weicher) -->
      <ellipse cx="${cx}" cy="${cy}" rx="${rx + feather}" ry="${ry + feather}" fill="url(#g)"/>
      `
        : ""
    }
  </svg>`;

  return await sharp(Buffer.from(svg)).png().toBuffer();
}

// ============= Prompts =================
function buildPrompts() {
  // Querformat-tauglich: bewusst klein + viel Negativraum
  const compCommon =
    "Komposition: streng mittig, komplette Kopfform sichtbar, nicht heranzoomen. " +
    "Motiv ≤ 32–36% der Bildbreite und ≤ 35–40% der Bildhöhe; rundum 35–45% Negativraum. " +
    "Muss als 16:9-Landscape-Crop funktionieren (seitlich ausreichend Luft). " +
    "Keine engen Beschnitte, keine Rahmen, keine schräge Perspektive.";

  // Half-Portrait
  const compBust =
    "Framing: Half-Portrait (Brust bis Kopf). Oberer Brustbereich sichtbar; " +
    "kein Head-only, keine Pfoten/Beine/Unterkörper, kein Ganzkörper. " +
    "Kopf/Brust vorn klar, Hintergrund weich.";

  // Identität bleibt – wir bearbeiten NUR den Bereich außerhalb der Maske
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

  // Neon-Hintergrund (nur außen bearbeiten!)
  const neonBg =
    "Hintergrund NUR außerhalb der Maske: kräftiger, aber diffuser Neon-Glow von tiefem Indigo (links) zu Violett–Magenta (rechts). " +
    "Feiner atmosphärischer Dunst/Schimmer, weiche Glow-Höfe, dezente großflächige Bokeh/Dust-Partikel. " +
    "Keine harten Lichtstrahlen, keine Laser/Godrays, keine Spotlights, keine zusätzlichen Objekte.";

  // Rim-Lights: nur als Lichtschein aus dem Hintergrund gedacht
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

  const neonNeg =
    negCommon + ", hard godrays, laser beams, spotlight rays, posterized";

  return {
    neon: { prompt: neonPrompt, negative: neonNeg },
  };
}

// ============= Handler =================
export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const SIZE = 1024;
    const COMPOSE_MARGIN_DEFAULT = 0.34;  // kleineres Motiv → landscape-safe
    const MASK_FEATHER_PX = 0;            // 0 = harte Kante; 8–16 = weicher

    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null;
    let style = "neon";
    let compose_margin = COMPOSE_MARGIN_DEFAULT;

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
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // 1) Canvas bauen (klein + viel Rand)
    const { canvas, pad } = await makeOutpaintCanvas(
      sourceBuffer,
      SIZE,
      compose_margin
    );

    // 2) Ellipsen-Maske erzeugen (innen schwarz = schützen)
    const maskPng = await makeEllipseMaskPNG(SIZE, pad, MASK_FEATHER_PX);

    // 3) Prompt holen (nur Neon hier aktiv)
    const { neon } = buildPrompts();
    const prompt = neon.prompt + ` Negative: ${neon.negative}`;

    // 4) 1× Edit-Call – NUR Hintergrund wird erzeugt
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
      version: VERSION,
    });
  } catch (err) {
    console.error("generate-fix error:", err);
    return res
      .status(500)
      .json({ success: false, error: String(err?.message || err) });
  }
}
