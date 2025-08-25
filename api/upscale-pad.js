// /api/upscale-pad.js
// 4× Upscale (Clipdrop → Sharp Lanczos3), optionaler Passepartout-Rand (matte)
// Hintergrund: auto | dominant | blur | #hex, optional ratio-Padding + margin, 300 DPI
import sharp from "sharp";
import { FormData, File } from "formdata-node";

export const config = { api: { bodyParser: false } };

// -------------------- Util --------------------
function cors(res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}
async function readBody(req){
  const chunks=[]; for await (const ch of req) chunks.push(ch);
  return Buffer.concat(ch).toString("utf8");
}
function parseRatio(s){
  const m=/^(\d+)\s*[:/]\s*(\d+)$/.exec(String(s||""));
  if(!m) return null;
  return [parseInt(m[1],10), parseInt(m[2],10)];
}
function hexToRGB(hex){
  const h=(hex||"ffffff").replace(/[^0-9a-f]/gi,"").padEnd(6,"f").slice(0,6);
  return { r:parseInt(h.slice(0,2),16), g:parseInt(h.slice(2,4),16), b:parseInt(h.slice(4,6),16), alpha:1 };
}
async function fetchBuffer(url){
  if (/^data:/i.test(url)) {
    const m = /^data:.*?;base64,(.+)$/i.exec(url);
    if(!m) throw new Error("Bad data URL");
    return Buffer.from(m[1], "base64");
  }
  const r = await fetch(url, { redirect:"follow", cache:"no-store" });
  if(!r.ok) throw new Error("Fetch failed "+r.status);
  return Buffer.from(await r.arrayBuffer());
}

// -------------------- Farben / Hintergründe --------------------
async function edgeColor(buf) {
  // mittelt Randpixel (2 px) nach 24×24 Downscale
  const SM = 24;
  const img = sharp(buf).resize(SM, SM, { fit: "inside" }).raw();
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  let r=0,g=0,b=0,c=0;
  const isEdge = (x,y) => (x<=1 || y<=1 || x>=w-2 || y>=h-2);
  for (let y=0;y<h;y++){
    for (let x=0;x<w;x++){
      if (!isEdge(x,y)) continue;
      const i = (y*w + x)*ch;
      r += data[i+0]||0; g += data[i+1]||0; b += data[i+2]||0; c++;
    }
  }
  if (!c) return { r:255, g:255, b:255, alpha:1 };
  return { r:Math.round(r/c), g:Math.round(g/c), b:Math.round(b/c), alpha:1 };
}
async function dominantColor(buf) {
  // 32×32 Downscale, 4-Bit Quantisierung, Histogramm
  const SM = 32;
  const img = sharp(buf).resize(SM, SM, { fit: "inside" }).raw();
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels;
  const hist = new Map();
  for (let i=0;i<w*h;i++){
    const r=data[i*ch+0]||0, g=data[i*ch+1]||0, b=data[i*ch+2]||0;
    const rq=r>>4, gq=g>>4, bq=b>>4;
    const key=(rq<<8)|(gq<<4)|bq;
    const e=hist.get(key)||{n:0,R:0,G:0,B:0};
    e.n++; e.R+=r; e.G+=g; e.B+=b; hist.set(key,e);
  }
  let best=null;
  for (const e of hist.values()) if (!best || e.n>best.n) best=e;
  if (!best) return { r:255, g:255, b:255, alpha:1 };
  return { r:Math.round(best.R/best.n), g:Math.round(best.G/best.n), b:Math.round(best.B/best.n), alpha:1 };
}

// -------------------- Ops: Upscale, Matte, Ratio --------------------
async function clipdropUpscale(buf){
  const key = process.env.CLIPDROP_API_KEY || process.env.CLIPDROP_KEY;
  if(!key) return null;
  try{
    const fd = new FormData();
    fd.set("image_file", new File([buf], "in.png", { type:"image/png" }));
    const r = await fetch("https://clipdrop-api.co/super-resolution/v1", {
      method:"POST", headers:{ "x-api-key": key }, body: fd
    });
    if(!r.ok) throw new Error("Clipdrop HTTP "+r.status);
    return Buffer.from(await r.arrayBuffer());
  }catch(e){ return null; }
}

async function lanczosUpscale4x(buf){
  const meta = await sharp(buf).metadata();
  const w = Math.max(1, meta.width || 1024);
  const h = Math.max(1, meta.height|| 1024);
  return await sharp(buf)
    .resize({ width:w*4, height:h*4, kernel:"lanczos3" })
    .png({ compressionLevel:9 })
    .toBuffer();
}

async function applyMatte(buf, mattePct, bgMode, blurSigma = 30) {
  const pct = Math.max(0, Math.min(0.4, Number(mattePct)||0)); // 0..40%
  if (pct <= 0) return buf;

  const meta = await sharp(buf).metadata();
  const W = meta.width || 1024, H = meta.height || 1024;

  // inneres Bild (contain)
  const innerW = Math.max(1, Math.round(W*(1-2*pct)));
  const innerH = Math.max(1, Math.round(H*(1-2*pct)));
  const inner  = await sharp(buf).resize({ width: innerW, height: innerH, fit: "inside" }).toBuffer();
  const mode = String(bgMode||'auto').toLowerCase();

  if (mode === 'blur') {
    const sigma = Math.max(0.3, Math.min(100, Number(blurSigma)||30));
    const base = await sharp(buf)
      .resize({ width: W, height: H, fit: "cover" })
      .blur(sigma)
      .toBuffer();
    return await sharp(base)
      .composite([{ input: inner, left: Math.round((W-innerW)/2), top: Math.round((H-innerH)/2) }])
      .withMetadata({ density: 300 })
      .png({ compressionLevel: 9 })
      .toBuffer();
  }

  // einfarbig (auto/dominant/hex)
  let bg;
  if (mode === 'dominant') bg = await dominantColor(buf);
  else if (mode === 'auto') bg = await edgeColor(buf);
  else bg = hexToRGB(bgMode);

  const canvas = sharp({ create: { width: W, height: H, channels: 3, background: bg } });
  return await canvas
    .composite([{ input: inner, left: Math.round((W-innerW)/2), top: Math.round((H-innerH)/2) }])
    .withMetadata({ density: 300 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

async function padToRatio(buf, ratio, margin, bgColorObj, fmt){
  if(!ratio) return buf;
  const meta = await sharp(buf).metadata();
  const iw = meta.width || 1, ih = meta.height || 1;
  const [rw,rh] = ratio;
  const targetR = rw/rh, imageR = iw/ih;
  let cw, ch;
  if (imageR > targetR) { cw = iw; ch = Math.round(iw/targetR); }
  else { ch = ih; cw = Math.round(ih*targetR); }

  const innerW = Math.round(cw*(1 - margin*2));
  const innerH = Math.round(ch*(1 - margin*2));
  const inner  = await sharp(buf).resize({ width: innerW, height: innerH, fit:"inside" }).toBuffer();

  const canvas = sharp({ create: { width: cw, height: ch, channels: 3, background: bgColorObj } });
  let out = await canvas
    .composite([{ input: inner, left: Math.round((cw-innerW)/2), top: Math.round((ch-innerH)/2) }])
    .withMetadata({ density: 300 });

  if (fmt === "jpeg") return await out.jpeg({ quality:95 }).toBuffer();
  return await out.png({ compressionLevel:9 }).toBuffer();
}

// -------------------- Handler --------------------
export default async function handler(req, res){
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).end();

  try{
    const urlObj = new URL(req.url, "http://x");
    const matte  = urlObj.searchParams.get("matte");            // e.g. 0.12
    const bgMode = (urlObj.searchParams.get("bg")||"auto");     // auto|dominant|blur|#hex
    const blur   = urlObj.searchParams.get("blur") || "30";     // for bg=blur
    const ratio  = parseRatio(urlObj.searchParams.get("ratio")); // e.g. 3:4
    const margin = Math.min(Math.max(parseFloat(urlObj.searchParams.get("margin")||"0.02"), 0), 0.2);
    const fmt    = (urlObj.searchParams.get("fmt")||"png").toLowerCase()==="jpeg" ? "jpeg" : "png";

    // Body lesen
    const bodyTxt = await readBody(req);
    const body = JSON.parse(bodyTxt||"{}");
    const src = body.url || body.data || body.image || "";
    if (!src) return res.status(400).json({ error:"missing url/data" });

    // (1) Quelle holen
    const base = await fetchBuffer(src);

    // (2) Upscale 4×
    let up = await clipdropUpscale(base);
    if (!up) up = await lanczosUpscale4x(base);

    // (3) Matte anwenden
    up = await applyMatte(up, matte, bgMode, blur);

    // (4) Ratio-Padding (optional) – Hintergrundfarbe für Canvas bestimmen
    let canvasBg = null;
    if (ratio) {
      if (bgMode === 'blur') {
        // für äußeres Canvas harmonisch: Kantenfarbe
        canvasBg = await edgeColor(up);
      } else if (bgMode === 'dominant') {
        canvasBg = await dominantColor(up);
      } else if (bgMode === 'auto') {
        canvasBg = await edgeColor(up);
      } else {
        canvasBg = hexToRGB(bgMode);
      }
    }

    const out = await padToRatio(up, ratio, margin, canvasBg || hexToRGB('ffffff'), fmt);

    res.setHeader("Content-Type", fmt==="jpeg" ? "image/jpeg" : "image/png");
    res.setHeader("Cache-Control","no-store");
    return res.status(200).send(out);
  }catch(e){
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(500).end(JSON.stringify({ error:"upscale-pad failed", details:String(e).slice(0,300) }));
  }
}
