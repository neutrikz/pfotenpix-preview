// /api/upscale.js – 6K-Upscale (6000 px lange Kante), Lanczos3, keine Ränder/Matte/Blur
// POST JSON: { url?: string, data?: "data:image/...;base64,...", max?: number, fmt?: "jpeg"|"png"|"webp" }
// Antwort: Binäres Bild (default JPEG)

import sharp from "sharp";

export const config = { api: { bodyParser: false } };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}

async function readBodyAsString(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks).toString("utf8");
}

function dataUrlToBuffer(str) {
  const m = /^data:(.+?);base64,(.+)$/i.exec(str || "");
  if (!m) return null;
  return Buffer.from(m[2], "base64");
}

async function fetchBuffer(u) {
  const ua = "pfpx-upscale/2.1 (+https://pfotenpix.de)";
  const url = new URL(u);
  const r = await fetch(u, {
    headers: {
      "user-agent": ua,
      accept: "image/*,*/*;q=0.8",
      referer: url.origin + "/",
    },
    redirect: "follow",
    cache: "no-store",
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`Upstream ${r.status}: ${t.slice(0, 300)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "POST only" });

  try {
    const raw = await readBodyAsString(req);
    let body = {};
    try { body = JSON.parse(raw || "{}"); } catch {
      return res.status(400).json({ error: "Bad JSON" });
    }

    // Defaults: 6K & JPEG
    const HARD_CAP = 8000;                  // Sicherheitskappe
    const reqMax   = parseInt(body.max,10);
    const TARGET   = Math.min(Number.isFinite(reqMax) && reqMax>0 ? reqMax : 6000, HARD_CAP);

    const inFmt = String(body.fmt || "jpeg").toLowerCase(); // Default JPEG
    const fmt   = ["jpeg","jpg","png","webp"].includes(inFmt) ? (inFmt==="jpg"?"jpeg":inFmt) : "jpeg";

    // Quelle holen
    let srcBuf = null;
    if (body.url && typeof body.url === "string") {
      srcBuf = await fetchBuffer(body.url);
    } else if (body.data && typeof body.data === "string") {
      srcBuf = dataUrlToBuffer(body.data);
    } else {
      return res.status(400).json({ error: "No 'url' or 'data' provided" });
    }
    if (!srcBuf) return res.status(400).json({ error: "Empty source" });

    const meta = await sharp(srcBuf, { limitInputPixels: false }).metadata();
    if (!meta.width || !meta.height) return res.status(415).json({ error: "Unsupported image" });
    const w = meta.width, h = meta.height;
    const landscape = w >= h;

    // Lange Kante = TARGET (keine Ränder, kein Crop)
    const resizeOpts = {
      width:  landscape ? TARGET : null,
      height: landscape ? null   : TARGET,
      fit: "outside",
      kernel: sharp.kernel.lanczos3,
      withoutEnlargement: false
    };

    let img = sharp(srcBuf, { limitInputPixels: false }).resize(resizeOpts);

    // Ausgabeformat
    if (fmt === "png") {
      res.setHeader("Content-Type", "image/png");
      img = img.png({ compressionLevel: 8 });
    } else if (fmt === "webp") {
      res.setHeader("Content-Type", "image/webp");
      img = img.webp({ quality: 100, lossless: true });
    } else { // jpeg
      res.setHeader("Content-Type", "image/jpeg");
      img = img.jpeg({ quality: 95, mozjpeg: true, chromaSubsampling: "4:4:4" });
    }

    const out = await img.toBuffer();
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-PFPX-Upscale",
      `${w}x${h} -> ${landscape ? TARGET : Math.round((TARGET / h) * w)}x${landscape ? Math.round((TARGET / w) * h) : TARGET}`);
    return res.status(200).end(out);

  } catch (err) {
    console.error("upscale error:", err);
    return res.status(500).json({ error: "Upscale error", details: String(err.message || err).slice(0, 300) });
  }
}
