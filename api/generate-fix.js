// /api/generate-fix.js — Identity-safe Neon via masked edits (face/torso protected, soft rim zone)
// Version: PFPX-2025-09d
import sharp from "sharp";
import { FormData, File } from "formdata-node";

export const config = { api: { bodyParser: false } };
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERSION = "PFPX-2025-09d";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "x-pfpx-version");
}

async function readRawBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, boundary) {
  const CRLF = "\r\n";
  const delim = `--${boundary}`;
  const close = `--${boundary}--`;
  const body = buffer.toString("binary");
  const parts = body.split(delim).filter(p => p && p !== "--" && p !== close);

  const fields = {}, files = {};
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

/** Motiv kleiner + Headroom oben (ohne Tier zu verändern) */
async function placeOnCanvas(inputBuffer, size, { composeMargin = 0.42, headroomTopPct = 0.16 } = {}) {
  const padX = Math.round(size * Math.max(0, Math.min(composeMargin, 0.49)));
  const basePad = padX;
  const shiftDown = Math.round(size * Math.max(0, Math.min(headroomTopPct, 0.3)));
  const padTop = basePad + shiftDown;
  const padBottom = Math.max(0, basePad - shiftDown);

  const innerW = size - 2 * padX;
  const innerH = size - padTop - padBottom;
  const subjectSize = Math.min(innerW, innerH);

  const subject = await sharp(inputBuffer)
    .resize(subjectSize, subjectSize, { fit: "contain", background: { r:0,g:0,b:0,alpha:0 } })
    .png()
    .toBuffer();

  const canvas = await sharp({
    create: { width: size, height: size, channels: 4, background: { r:0,g:0,b:0,alpha:0 } }
  }).composite([{ input: subject, left: padX, top: padTop }]).png().toBuffer();

  return { canvas, padX, padTop, innerW, innerH };
}

/** Weiche, elliptische Schutzmaske:
 *  - Voller Schutz (weiß) im Kern (Gesicht/Brust).
 *  - Weicher Schutzring (niedrigere Opazität) für subtile Farbsaum-Bearbeitung.
 *  - Außen transparent => darf editiert werden (Hintergrund/Neon).
 */
async function buildSoftMask(size, { padX, padTop, innerW, innerH }, {
  faceScaleX = 0.58,   // Deckungsgrad in X über dem inneren Platz
  faceScaleY = 0.70,   // Deckungsgrad in Y
  ringOpacity = 0.55,  // Schutzring-Opazität (0..1)
  blurPx = 28          // Weichzeichnung der Maske
} = {}) {
  const cx = size / 2;
  const cy = padTop + innerH / 2;
  const rx = (innerW * faceScaleX) / 2;
  const ry = (innerH * faceScaleY) / 2;

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
      <defs>
        <filter id="f" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="${blurPx}" />
        </filter>
      </defs>
      <!-- Hintergrund transparent (editierbar) -->
      <rect width="100%" height="100%" fill="rgba(0,0,0,0)"/>
      <!-- Schutzring (teilweise Schutz, erlaubt leichte Rim-Lights) -->
      <ellipse cx="${cx}" cy="${cy}" rx="${rx * 1.15}" ry="${ry * 1.15}" fill="rgba(255,255,255,${ringOpacity})" filter="url(#f)"/>
      <!-- Voll geschützter Kern -->
      <ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="rgba(255,255,255,1)"/>
    </svg>
  `;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

/** Prompt nur für Stil (Neon); Identitätsschutzhinweise kommen über die Maske */
function buildNeonPrompt() {
  return [
    "Erzeuge einen fotorealistischen Studiolook mit starkem, aber diffusem Neon-Glow-Hintergrund: ",
    "links kräftiges Cyan/Teal, rechts sattes Magenta/Violett, weicher Verlauf, ",
    "feiner atmosphärischer Dunst/Schimmer, dezente großflächige Bokeh/Dust-Partikel, kein Text/Logo/Objekte. ",
    "Additive Rim-Lights entlang der Fellkanten (Cyan links, Magenta rechts), subtil und realistisch, ",
    "keine harte globale Umfärbung der Mitteltöne des Tiers. ",
    "Komposition: Motiv mittig, nicht heranzoomen; ausreichend Negativraum für 16:9-Landscape-Crops."
  ].join("");
}

async function callOpenAIEdit(imagePng, maskPng) {
  const form = new FormData();
  form.set("model", "gpt-image-1");
  form.set("image", new File([imagePng], "image.png", { type: "image/png" }));
  form.set("mask",  new File([maskPng],  "mask.png",  { type: "image/png" }));
  form.set("prompt", buildNeonPrompt());
  form.set("n", "1");
  form.set("size", "1024x1024");

  const r = await fetch("https://api.openai.com/v1/images/edits", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.headers },
    body: form
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);

  const item = j?.data?.[0];
  if (!item) throw new Error("OpenAI returned no image");
  if (item.b64_json) return Buffer.from(item.b64_json, "base64");
  if (item.url) {
    const rr = await fetch(item.url);
    return Buffer.from(await rr.arrayBuffer());
  }
  throw new Error("Unexpected OpenAI response");
}

/** leichte Midtone-Aufhellung (vermeidet “zu dunkel/golden”) */
async function mildLift(buf) {
  return await sharp(buf).modulate({ brightness: 1.06, saturation: 1.02 }).png().toBuffer();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const SIZE = 1024;

    // --- Defaults (per Request übersteuerbar) ---
    let compose_margin = 0.42;      // Motiv kleiner => Landscape-sicher
    let headroom_top_pct = 0.16;    // mehr Luft oben
    let faceScaleX = 0.58, faceScaleY = 0.70; // Schutzellipse
    let ringOpacity = 0.55, blurPx = 28;      // weicher Rand

    // --- Payload parsen ---
    const ct = (req.headers["content-type"] || "").toLowerCase();
    let src = null;

    if (ct.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ct);
      if (!m) return res.status(400).json({ error: "Bad multipart" });
      const { fields, files } = parseMultipart(await readRawBody(req), m[1]);
      const f = files["file"]; if (!f?.buffer) return res.status(400).json({ error: "No file uploaded" });
      src = f.buffer;

      if (fields.compose_margin)      compose_margin = Math.max(0.30, Math.min(0.48, parseFloat(fields.compose_margin) || compose_margin));
      if (fields.headroom_top_pct)    headroom_top_pct = Math.max(0, Math.min(0.28, parseFloat(fields.headroom_top_pct) || headroom_top_pct));
      if (fields.mask_face_scale_x)   faceScaleX = Math.max(0.40, Math.min(0.85, parseFloat(fields.mask_face_scale_x) || faceScaleX));
      if (fields.mask_face_scale_y)   faceScaleY = Math.max(0.50, Math.min(0.95, parseFloat(fields.mask_face_scale_y) || faceScaleY));
      if (fields.mask_ring_opacity)   ringOpacity = Math.max(0, Math.min(1, parseFloat(fields.mask_ring_opacity) || ringOpacity));
      if (fields.mask_blur_px)        blurPx = Math.max(6, Math.min(64, parseFloat(fields.mask_blur_px) || blurPx));
    } else if (ct.includes("application/json")) {
      const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/,"");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      src = Buffer.from(b64, "base64");

      if (body.compose_margin != null)    compose_margin   = Math.max(0.30, Math.min(0.48, parseFloat(body.compose_margin) || compose_margin));
      if (body.headroom_top_pct != null)  headroom_top_pct = Math.max(0,    Math.min(0.28, parseFloat(body.headroom_top_pct) || headroom_top_pct));
      if (body.mask_face_scale_x != null) faceScaleX       = Math.max(0.40, Math.min(0.85, parseFloat(body.mask_face_scale_x) || faceScaleX));
      if (body.mask_face_scale_y != null) faceScaleY       = Math.max(0.50, Math.min(0.95, parseFloat(body.mask_face_scale_y) || faceScaleY));
      if (body.mask_ring_opacity != null) ringOpacity      = Math.max(0,    Math.min(1,    parseFloat(body.mask_ring_opacity) || ringOpacity));
      if (body.mask_blur_px != null)      blurPx           = Math.max(6,    Math.min(64,   parseFloat(body.mask_blur_px) || blurPx));
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // 1) Motiv kleiner + Headroom
    const placed = await placeOnCanvas(src, SIZE, { composeMargin: compose_margin, headroomTopPct: headroom_top_pct });

    // 2) Schutzmaske (Gesicht + oberer Torso) mit weicher Kante
    const mask = await buildSoftMask(SIZE, placed, {
      faceScaleX, faceScaleY, ringOpacity, blurPx
    });

    // 3) Edit-Call an OpenAI (Hintergrund + Ränder werden neu gerendert)
    let out = await callOpenAIEdit(placed.canvas, mask);

    // 4) leichte Midtone-Lift (optional)
    out = await mildLift(out);

    res.setHeader("x-pfpx-version", VERSION);
    return res.status(200).json({
      success: true,
      previews: { neon: `data:image/png;base64,${out.toString("base64")}` },
      compose_margin,
      headroom_top_pct,
      mask: { faceScaleX, faceScaleY, ringOpacity, blurPx },
      version: VERSION
    });
  } catch (err) {
    console.error("generate-fix:", err);
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
}
