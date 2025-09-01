// /api/preview-proxy.js – Wasserzeichen-Proxy (CORS offen, sichtbares WM, http/https + data: Support)
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

// Named export ist ok (kein default!)
export const config = { api: { bodyParser: false } };

// --------------- Helpers ---------------
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// data: → Buffer
function bufferFromDataURL(u) {
  const m = /^data:(.+?);base64,(.+)$/i.exec(u || "");
  if (!m) return null;
  return Buffer.from(m[2], "base64");
}

async function fetchUpstream(u) {
  // data: direkt
  if (/^data:/i.test(u)) {
    const buf = bufferFromDataURL(u);
    if (!buf) throw new Error("bad data: url");
    return buf;
  }

  const url = new URL(u);
  const ua  = "pfpx-preview-proxy/1.5 (+https://pfotenpix.de)";
  const baseHeaders = {
    "user-agent": ua,
    accept: "image/*,*/*;q=0.8",
    referer: url.origin + "/",
    "accept-language": "de,en;q=0.9",
  };

  let r = await fetch(u, { headers: baseHeaders, redirect: "follow", cache: "no-store" });
  if (!r.ok) {
    const fallbackHeaders = { ...baseHeaders, referer: "https://pfotenpix.de/" };
    r = await fetch(u, { headers: fallbackHeaders, redirect: "follow", cache: "no-store" });
  }
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`upstream ${r.status} ${r.statusText} :: ${txt.slice(0, 400)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

function tryRead(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

function loadFontFromPublic() {
  const candidates = [
    "public/fonts/Inter-SemiBold.woff2",
    "public/fonts/Inter-Regular.woff2",
    "public/fonts/Inter-SemiBold.woff",
    "public/fonts/Inter-Regular.woff",
    "public/fonts/Roboto-Regular.woff2",
    "public/fonts/Roboto-Regular.woff",
    "public/fonts/DejaVuSans.woff",
    "public/fonts/DejaVuSans.ttf",
    "public/Roboto-Regular.woff",
    "public/DejaVuSans.woff",
    "public/DejaVuSans.ttf",
  ];

  for (const rel of candidates) {
    const abs = path.join(process.cwd(), rel);
    const buf = tryRead(abs);
    if (buf) {
      const ext = path.extname(abs).toLowerCase();
      const mime =
        ext === ".woff2" ? "font/woff2" :
        ext === ".woff"  ? "font/woff"  :
        ext === ".otf"   ? "font/otf"   :
                           "font/ttf";
      const fmt =
        ext === ".woff2" ? "woff2" :
        ext === ".woff"  ? "woff"  :
        ext === ".otf"   ? "opentype" : "truetype";
      return { b64: buf.toString("base64"), mime, fmt };
    }
  }
  return null;
}

// --------------- Default-Export: genau EINMAL ---------------
export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).end();

  try {
    const u = req.query.u ? String(req.query.u) : "";
    if (!u) return res.status(400).json({ error: "missing ?u=" });

    const width    = Math.min(parseInt(req.query.w || "1200", 10) || 1200, 3000);
    const wmTxt    = esc(req.query.wm || "PFOTENPIX - PREVIEW");
    const opacity  = Math.min(Math.max(parseFloat(req.query.op || "0.36"), 0.05), 0.8);
    const fontSize = Math.min(Math.max(parseInt(req.query.fs || "48", 10) || 48, 16), 160);
    const tileW    = Math.min(Math.max(parseInt(req.query.tw || "360", 10) || 360, 120), 800);
    const tileH    = Math.min(Math.max(parseInt(req.query.th || "280", 10) || 280, 100), 800);
    const angle    = parseFloat(req.query.ang || "-30");
    const fmt      = String((req.query.fmt || "jpeg")).toLowerCase(); // jpeg/webp/png

    // 1) Bild auf Zielbreite rendern
    const srcBuf = await fetchUpstream(u);
    const resizedBuf = await sharp(srcBuf)
      .resize({ width, fit: "inside", withoutEnlargement: true })
      .toBuffer();

    // 2) Endmaße
    const meta = await sharp(resizedBuf).metadata();
    const W = meta.width  || width;
    const H = meta.height || Math.round((W * 3) / 4);

    // 3) Font laden & in SVG einbetten
    const font = loadFontFromPublic();
    const fontFace = font
      ? `@font-face{font-family:'pfpxwm';src:url(data:${font.mime};base64,${font.b64}) format('${font.fmt}');font-weight:600;font-style:normal;font-display:block;}`
      : "";

    const family = font ? "pfpxwm" : "DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif";

    // 4) SVG-Overlay
    const svg = (w,h)=>`
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <defs>
          <style>
            ${fontFace}
            text{font-family:${family};font-weight:600;text-rendering:optimizeLegibility;}
          </style>
          <pattern id="wm" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(${angle})">
            <text x="12" y="${Math.round(fontSize)}"
              fill="black" fill-opacity="${opacity}"
              stroke="white" stroke-opacity="${Math.min(opacity*0.5,0.4)}" stroke-width="1"
              font-size="${fontSize}">${wmTxt}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`;

    const overlay = Buffer.from(svg(W, H));

    // 5) Compositing
    let img = sharp(resizedBuf).composite([{ input: overlay, top: 0, left: 0 }]);

    // 6) Ausgabeformat
    if (fmt === "webp") {
      img = img.webp({ quality: 90 });
      res.setHeader("Content-Type", "image/webp");
    } else if (fmt === "png") {
      img = img.png({ compressionLevel: 9 });
      res.setHeader("Content-Type", "image/png");
    } else {
      img = img.jpeg({ quality: 92, chromaSubsampling: "4:2:0" });
      res.setHeader("Content-Type", "image/jpeg");
    }

    const out = await img.toBuffer();
    res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=60");
    res.setHeader("X-PFPX-Proxy", "ok");
    return res.status(200).send(out);

  } catch (err) {
    console.error("preview-proxy error:", err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(502).send(JSON.stringify({
      error: "proxy failure",
      details: String(err.message || err).slice(0, 400)
    }));
  }
}
