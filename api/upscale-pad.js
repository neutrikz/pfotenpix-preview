// /api/upscale-pad.js – Upscale + Pad + „Bildfarb-Rand“ (blurred edge)
// POST JSON: { url: "https://...", dataurl?: "data:image/..." }
// Query: ?ratio=3:4|21x30|1:1  & matte=0.12  & bg=blur|color-#ffffff  & blur=30  & fmt=png|jpeg  & max=4096
// Antwort: Bild (image/png oder image/jpeg)

import sharp from "sharp";

export const config = { api: { bodyParser: false } };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function clamp(n, lo, hi) { return Math.min(Math.max(Number(n), lo), hi); }

function parseRatio(raw) {
  if (!raw) return 1; // 1:1
  const s = String(raw).trim()
    .replace(/[×x/]/gi, ":")   // 21×30, 21x30, 21/30 => 21:30
    .replace(/\s*cm\b/gi, "")  // " cm" entfernen
    .replace(/[^\d:.\-]/g, "");
  const [a, b] = s.split(":").map(Number);
  if (!a || !b) return 1;
  return Math.max(0.05, Math.min(20, a / b));
}

function isHttp(u) { return /^https?:\/\//i.test(u || ""); }
function isData(u) { return /^data:image\//i.test(u || ""); }

async function readRawBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks);
}

function bufFromDataURL(u) {
  const m = /^data:image\/[a-z0-9+.-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(u || "");
  return m ? Buffer.from(m[1], "base64") : null;
}

// Hotlink-sicher laden (ähnlich wie preview-proxy)
async function fetchUpstream(u) {
  if (isData(u)) {
    const b = bufFromDataURL(u);
    if (!b) throw new Error("Bad data URL");
    return b;
  }
  if (!isHttp(u)) throw new Error("URL must be http(s) or data:");
  const url = new URL(u);
  const headers = {
    "user-agent": "pfpx-upscale/1.0 (+https://pfotenpix.de)",
    "accept": "image/*,*/*;q=0.8",
    "referer": url.origin + "/",
    "accept-language": "de,en;q=0.9",
  };
  let r = await fetch(u, { headers, redirect: "follow", cache: "no-store" });
  if (!r.ok) {
    // zweiter Versuch mit fixer Referer-Domain
    r = await fetch(u, { headers: { ...headers, referer: "https://pfotenpix.de/" }, redirect: "follow", cache: "no-store" });
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`upstream ${r.status} ${r.statusText} :: ${txt.slice(0, 180)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Method not allowed" });

  try {
    // ---- Query-Parameter lesen ----
    const ratio     = parseRatio(req.query.ratio || "1:1");
    const matte     = clamp(req.query.matte ?? 0.12, 0, 0.49);    // innerer Rand (pro Seite)
    const bgParam   = String(req.query.bg || "blur").toLowerCase(); // "blur" oder "color-#rrggbb"
    const blurSigma = clamp(req.query.blur ?? 30, 0, 200);
    const fmt       = (String(req.query.fmt || "png").toLowerCase() === "jpeg") ? "jpeg" : "png";
    const maxEdge   = clamp(req.query.max ?? 4096, 512, 8192);

    // ---- Body lesen ----
    const ct = String(req.headers["content-type"] || "").toLowerCase();
    let srcBuf = null;
    if (ct.includes("application/json")) {
      const json = JSON.parse((await readRawBody(req)).toString("utf8") || "{}");
      if (json.dataurl) {
        srcBuf = bufFromDataURL(json.dataurl);
        if (!srcBuf) throw new Error("Invalid dataurl");
      } else if (json.url) {
        srcBuf = await fetchUpstream(json.url);
      } else {
        throw new Error("Body must contain {url} or {dataurl}");
      }
    } else {
      throw new Error("Content-Type must be application/json");
    }

    // ---- Ausgangsbild lesen ----
    const src = sharp(srcBuf, { failOn:"none" });
    const meta = await src.metadata();
    if (!(meta.width && meta.height)) throw new Error("Cannot read image");

    // ---- Zielgröße aus Seitenverhältnis + maxEdge bestimmen ----
    const targetW = ratio >= 1 ? maxEdge : Math.round(maxEdge * ratio);
    const targetH = ratio >= 1 ? Math.round(maxEdge / ratio) : maxEdge;

    // ---- Hintergrund: geblurrte Kanten ----
    const bgCover = await sharp(srcBuf)
      .resize({ width: targetW, height: targetH, fit: "cover" })
      .blur(blurSigma || 0.3) // minimaler Blur, sonst Banding
      .toBuffer();

    // Alternative: feste Farbe color-#rrggbb
    let base = sharp(bgCover);
    if (bgParam.startsWith("color-")) {
      const hex = bgParam.slice(6);
      const col = /^#?[0-9a-f]{6}$/i.test(hex) ? (hex.startsWith("#") ? hex : "#"+hex) : "#000000";
      const solid = await sharp({
        create: { width: targetW, height: targetH, channels: 3, background: col }
      }).png().toBuffer();
      base = sharp(solid);
    }

    // ---- Contentfläche (Innenmaß) berechnen ----
    const innerW = Math.max(1, Math.floor(targetW * (1 - matte * 2)));
    const innerH = Math.max(1, Math.floor(targetH * (1 - matte * 2)));

    // Bild in die Contentfläche einpassen (Seitenverhältnis des Originals bleibt)
    const contentBuf = await sharp(srcBuf)
      .resize({ width: innerW, height: innerH, fit: "inside", kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
      .toBuffer();

    const cMeta = await sharp(contentBuf).metadata();
    const left = Math.floor((targetW - (cMeta.width  || innerW)) / 2);
    const top  = Math.floor((targetH - (cMeta.height || innerH)) / 2);

    // ---- Compositing ----
    let out = base.composite([{ input: contentBuf, left, top }]);
    if (fmt === "jpeg") {
      res.setHeader("Content-Type", "image/jpeg");
      out = out.jpeg({ quality: 95, chromaSubsampling: "4:4:4" });
    } else {
      res.setHeader("Content-Type", "image/png");
      out = out.png({ compressionLevel: 9 });
    }

    const buf = await out.toBuffer();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(buf);

  } catch (err) {
    console.error("upscale-pad error:", err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(500).send(JSON.stringify({ error: "upscale failure", detail: String(err?.message || err).slice(0, 300) }));
  }
}
