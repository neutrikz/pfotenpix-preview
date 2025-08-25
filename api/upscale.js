// /api/upscale.js – reines Upscale (Lanczos3), KEIN Matte/Blur, KEIN Padding
import sharp from "sharp";

export const config = { api: { bodyParser: false } };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}
async function readRaw(req){ const chunks=[]; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }

function parseJsonSafe(buf){
  try { return JSON.parse(buf.toString("utf8")||"{}"); } catch { return {}; }
}

function bufFromDataUrl(u){
  const m = /^data:(.+?);base64,(.+)$/i.exec(u||"");
  if (!m) return null; 
  return Buffer.from(m[2], "base64");
}

async function fetchAsBuffer(u){
  if (/^data:/i.test(u)) {
    const b = bufFromDataUrl(u);
    if (!b) throw new Error("Bad data URL");
    return b;
  }
  const r = await fetch(u, { redirect: "follow", headers: { accept: "image/*,*/*;q=0.8" } });
  if (!r.ok) throw new Error(`Fetch ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req, res){
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).end();

  try{
    const bodyBuf = await readRaw(req);
    const ct = (req.headers["content-type"]||"").toLowerCase();
    let url = "", max = 4096, fmt = "png";

    if (ct.includes("application/json")){
      const j = parseJsonSafe(bodyBuf);
      url = String(j.url || j.image || "");
      max = Math.min(Math.max(parseInt(j.max || 4096, 10) || 4096, 512), 8192);
      fmt = (j.format||"png").toLowerCase();
    } else {
      // einfache Query-Fallbacks (optional)
      const qs = new URL("http://x"+(req.url||"")).searchParams;
      url = String(qs.get("url") || "");
      max = Math.min(Math.max(parseInt(qs.get("max")||"4096",10)||4096,512),8192);
      fmt = (qs.get("format")||"png").toLowerCase();
    }

    if (!url) return res.status(400).json({ error: "missing url" });

    const src = await fetchAsBuffer(url);

    let img = sharp(src).withMetadata().resize({
      width: max, height: max, fit: "inside", withoutEnlargement: false,
      kernel: sharp.kernel.lanczos3
    });

    if (fmt === "jpeg" || fmt === "jpg") { img = img.jpeg({ quality: 92, chromaSubsampling: "4:2:0" }); res.setHeader("Content-Type","image/jpeg"); }
    else if (fmt === "webp") { img = img.webp({ quality: 92 }); res.setHeader("Content-Type","image/webp"); }
    else { img = img.png({ compressionLevel: 9 }); res.setHeader("Content-Type","image/png"); }

    const out = await img.toBuffer();
    res.setHeader("Cache-Control","public, max-age=600, stale-while-revalidate=60");
    return res.status(200).send(out);
  }catch(err){
    console.error("upscale error:", err);
    return res.status(500).json({ error: "upscale_failed", detail: String(err.message||err).slice(0,200) });
  }
}
