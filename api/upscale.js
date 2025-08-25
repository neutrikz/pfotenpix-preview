// /api/upscale.js – simple 4× upscale (Lanczos3). Input: {url} or {data} JSON.
// Returns a binary PNG. No matte, no blur, no padding.

import sharp from "sharp";

export const config = { api: { bodyParser: false } };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

async function readJSON(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return null;
  }
}

function bufferFromDataURL(u) {
  const m = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/i.exec(u || "");
  return m ? Buffer.from(m[1], "base64") : null;
}

async function fetchBuffer(u) {
  const url = new URL(u);
  const headers = {
    "user-agent": "pfpx-upscale/1.0 (+https://pfotenpix.de)",
    accept: "image/*,*/*;q=0.8",
    referer: url.origin + "/",
  };
  const r = await fetch(u, { headers, redirect: "follow", cache: "no-store" });
  if (!r.ok) {
    // try second time with site referer (some CDNs require it)
    const r2 = await fetch(u, { headers: { ...headers, referer: "https://pfotenpix.de/" }, redirect: "follow", cache: "no-store" });
    if (!r2.ok) {
      const txt = await r2.text().catch(() => "");
      const err = (txt || "").slice(0, 200);
      throw new Error(`upstream ${r2.status} ${r2.statusText} ${err}`);
    }
    return Buffer.from(await r2.arrayBuffer());
  }
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  try {
    const json = await readJSON(req);
    if (!json || (typeof json !== "object")) {
      return res.status(400).json({ error: "Bad JSON body" });
    }

    let inputBuf = null;

    if (typeof json.data === "string" && json.data.startsWith("data:image/")) {
      inputBuf = bufferFromDataURL(json.data);
      if (!inputBuf) return res.status(400).json({ error: "Invalid data URL" });
    } else if (typeof json.url === "string" && json.url) {
      const isHttp = /^https?:\/\//i.test(json.url);
      const isData = /^data:/i.test(json.url);
      if (!isHttp && !isData) return res.status(400).json({ error: "url must be http(s) or data:" });
      inputBuf = isData ? bufferFromDataURL(json.url) : await fetchBuffer(json.url);
      if (!inputBuf) return res.status(400).json({ error: "Could not read input image" });
    } else {
      return res.status(400).json({ error: "Provide {url} or {data}" });
    }

    // Decode + rotate (EXIF) + ensure RGBA
    const base = sharp(inputBuf, { limitInputPixels: false }).rotate();

    const meta = await base.metadata();
    const w = meta.width || 1024;
    const h = meta.height || 1024;

    // 4× upscale, clamp to 4096 to keep Printful happy
    const scale   = Math.max(2, Math.min(4, Number(json.scale) || 4));
    const targetW = Math.min(4096, Math.round(w * scale));
    const targetH = Math.min(4096, Math.round(h * scale));

    const out = await base
      .resize(targetW, targetH, { kernel: sharp.kernel.lanczos3 })
      .png({ compressionLevel: 6 })
      .toBuffer();

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=60");
    res.setHeader("X-PFPX-Upscale", `${w}x${h} -> ${targetW}x${targetH}`);
    return res.status(200).send(out);
  } catch (err) {
    console.error("upscale error:", err);
    // Return 500 with a short message; WordPress treats 4xx/5xx as failure and falls back.
    return res.status(500).json({ error: "upscale failed", details: String(err.message || err).slice(0, 200) });
  }
}
