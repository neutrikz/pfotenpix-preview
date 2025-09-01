// /api/generate-fix.js — PFPX background-generation + subject-preserve compositing
// Version: PFPX-2025-09c (identity-safe, extra headroom, landscape-safe)
import sharp from "sharp";
import { FormData, File } from "formdata-node";

export const config = { api: { bodyParser: false } };

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERSION = "PFPX-2025-09c";

// ============== CORS ==============
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Expose-Headers", "x-pfpx-version,x-pfpx-style-final");
}

// ============== Utils ==============
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

async function fetchJson(url, opts) {
  const r = await fetch(url, opts);
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (!r.ok) throw new Error(j?.error?.message || `HTTP ${r.status}`);
  return j;
}

async function fetchArrayBuffer(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// ============== Subject canvas (no modification!) ==============
// Positioniert das Motiv auf transparentem Canvas, ohne es zu verändern.
// marginPct: macht das Motiv kleiner → Landscape-freundlich
// headroomTopPct: mehr Luft oben (Motiv nach unten schieben)
async function makeSubjectCanvas(inputBuffer, targetSize, {
  marginPct = 0.40,
  headroomTopPct = 0.12
} = {}) {
  const size = targetSize;
  const padX = Math.round(size * Math.max(0, Math.min(marginPct, 0.49)));
  const basePad = Math.round(size * Math.max(0, Math.min(marginPct, 0.49)));

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

  // Für einfache optionale Glows: grobe Ellipse (wird nicht an OpenAI gesendet)
  const ellipse = { cx: size/2, cy: padTop + innerH/2, rx: innerW/2, ry: innerH/2 };

  return { canvas, ellipse };
}

// ============== Prompt: Hintergrund NUR (ohne Subjekt) ==============
function buildBackgroundPrompt() {
  return [
    "Erzeuge einen fotorealistischen Studio-Hintergrund OHNE Motiv: ",
    "kräftiger, aber diffuser Neon-Glow-Verlauf von tiefem Indigo (links) zu Violett–Magenta (rechts), ",
    "feiner atmosphärischer Dunst/Schimmer, weiche Glow-Höfe, dezente großflächige Bokeh/Dust-Partikel. ",
    "Keine Strahlen/Laser/Godrays, keine Objekte, kein Boden, kein Text. ",
    "Auflösung 1024x1024."
  ].join("");
}

// ============== OpenAI: Background generation ==============
async function generateBackground() {
  const j = await fetchJson("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: "gpt-image-1",
      prompt: buildBackgroundPrompt(),
      size: "1024x1024",
      n: 1
    })
  });

  const item = j?.data?.[0];
  if (!item) throw new Error("No image from OpenAI");
  if (item.b64_json) {
    return Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    return await fetchArrayBuffer(item.url);
  }
  throw new Error("Unexpected OpenAI response");
}

// ============== Handler ==============
export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try {
    const SIZE = 1024;

    // Defaults (können via Felder übersteuert werden)
    let marginPct = 0.40;        // kleiner → mehr Negativraum, Landscape-safe
    let headroomTopPct = 0.12;   // mehr Luft oben

    // Input lesen
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    let sourceBuffer = null;
    let style = "neon"; // nur für Kompatibilität mit Frontend

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart (no boundary)" });
      const { fields, files } = parseMultipart(await readRawBody(req), m[1]);
      const f = files["file"]; if (!f?.buffer) return res.status(400).json({ error: "No file uploaded" });
      sourceBuffer = f.buffer;

      if (fields["style"]) style = String(fields["style"]).toLowerCase() || "neon";
      if (fields["compose_margin"]) {
        const v = parseFloat(fields["compose_margin"]);
        if (Number.isFinite(v)) marginPct = v;
      }
      if (fields["headroom_top_pct"]) {
        const v = parseFloat(fields["headroom_top_pct"]);
        if (Number.isFinite(v)) headroomTopPct = v;
      }
    } else if (ctype.includes("application/json")) {
      const body = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/,"");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");

      if (body.style) style = String(body.style).toLowerCase() || "neon";
      if (body.compose_margin != null) {
        const v = parseFloat(body.compose_margin);
        if (Number.isFinite(v)) marginPct = v;
      }
      if (body.headroom_top_pct != null) {
        const v = parseFloat(body.headroom_top_pct);
        if (Number.isFinite(v)) headroomTopPct = v;
      }
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // 1) Subjekt-Canvas vorbereiten (OHNE Bearbeitung des Tiers)
    const { canvas: subjectPng } = await makeSubjectCanvas(sourceBuffer, SIZE, {
      marginPct,
      headroomTopPct
    });

    // 2) Neon-Hintergrund generieren (rein KI, ohne Motiv)
    const bgPng = await generateBackground();

    // 3) Compositing: Hintergrund + Original-Motiv
    //    (Optional könnte man hier noch additive Außen-Glows per SVG hinzufügen.)
    const final = await sharp(bgPng)
      .composite([{ input: subjectPng, left: 0, top: 0 }])
      .png()
      .toBuffer();

    // Data-URL zurückgeben (vom Frontend direkt anzeigbar)
    const dataUrl = `data:image/png;base64,${final.toString("base64")}`;

    res.setHeader("x-pfpx-version", VERSION);
    res.setHeader("x-pfpx-style-final", style);
    return res.status(200).json({
      success: true,
      previews: { [style]: dataUrl },
      compose_margin: marginPct,
      headroom_top_pct: headroomTopPct,
      version: VERSION
    });
  } catch (err) {
    console.error("generate-fix error:", err);
    return res.status(500).json({ success: false, error: String(err?.message || err) });
  }
}
