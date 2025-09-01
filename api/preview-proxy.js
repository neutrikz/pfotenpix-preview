// /api/preview-proxy.js – Wasserzeichen-Proxy (CORS offen, sichtbares WM, http/https + data: Support)
// Robuster: harte Limits, EXIF-Ausrichtung, sRGB, Timeout, Content-Length-Prüfung
import sharp from "sharp";
import fs from "node:fs";
import path from "node:path";

export const config = { api: { bodyParser: false } };

/* ------------------------ CORS ------------------------ */
function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

/* ------------------------ Utils ------------------------ */
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clamp(n, min, max) {
  n = Number(n);
  if (Number.isNaN(n)) n = min;
  return Math.min(Math.max(n, min), max);
}

function tryRead(p) {
  try { return fs.readFileSync(p); } catch { return null; }
}

/* ------------------ data: → Buffer (mit Limit) ------------------ */
const MAX_BYTES_DATA = 18 * 1024 * 1024; // 18 MB Obergrenze für data: payload

function bufferFromDataURL(u) {
  const m = /^data:(.+?);base64,(.+)$/i.exec(u || "");
  if (!m) return null;
  const b64 = m[2];
  // Grobe Plausibilitätsprüfung: Base64 ~ 4/3 der Bytes
  const approx = Math.floor(b64.length * 3 / 4);
  if (approx > MAX_BYTES_DATA) {
    throw new Error(`dataurl_too_large ~${approx}B > ${MAX_BYTES_DATA}B`);
  }
  return Buffer.from(b64, "base64");
}

/* ------------------ Upstream holen (mit Limits) ------------------ */
const MAX_BYTES_HTTP = 25 * 1024 * 1024; // 25 MB Obergrenze für HTTP
const FETCH_TIMEOUT_MS = 15000;          // 15s

async function fetchUpstream(u) {
  // data: direkt
  if (/^data:/i.test(u)) {
    const buf = bufferFromDataURL(u);
    if (!buf) throw new Error("bad data: url");
    return buf;
  }

  // Nur http/https zulassen
  if (!/^https?:\/\//i.test(u)) {
    throw new Error("unsupported_protocol");
  }

  // Einige Upstreams mögen encoded URLs → 2x decode tolerant
  let urlString = u;
  try { urlString = decodeURIComponent(u); } catch {}
  try { urlString = decodeURIComponent(urlString); } catch {}

  let url;
  try { url = new URL(urlString); }
  catch { throw new Error("bad_url"); }

  const ua = "pfpx-preview-proxy/1.6 (+https://pfotenpix.de)";
  const baseHeaders = {
    "user-agent": ua,
    "accept": "image/*,*/*;q=0.8",
    "referer": url.origin + "/",
    "accept-language": "de,en;q=0.9"
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  // 1. Versuch mit normalem Referer
  let r = await fetch(url.toString(), {
    headers: baseHeaders, redirect: "follow", cache: "no-store",
    signal: controller.signal
  }).catch((e) => { throw new Error(`fetch_fail_1 ${String(e)}`); });

  // 2. Fallback mit pfotenpix-Referer
  if (!r.ok) {
    const fallbackHeaders = { ...baseHeaders, referer: "https://pfotenpix.de/" };
    r = await fetch(url.toString(), {
      headers: fallbackHeaders, redirect: "follow", cache: "no-store",
      signal: controller.signal
    }).catch((e) => { throw new Error(`fetch_fail_2 ${String(e)}`); });
  }

  clearTimeout(timer);

  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`upstream ${r.status} ${r.statusText} :: ${txt.slice(0, 400)}`);
  }

  // Content-Length vorab prüfen (falls vorhanden)
  const cl = parseInt(r.headers.get("content-length") || "0", 10);
  if (cl && cl > MAX_BYTES_HTTP) {
    throw new Error(`upstream_too_large ${cl}B > ${MAX_BYTES_HTTP}B`);
  }

  // Ganze Antwort lesen (Vercel/Node fetch → arrayBuffer möglich)
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_BYTES_HTTP) {
    throw new Error(`upstream_too_large_effective ${buf.length}B > ${MAX_BYTES_HTTP}B`);
  }
  return buf;
}

/* ------------------ Schrift aus /public laden ------------------ */
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
        ext === ".otf"   ? "font/otf"   : "font/ttf";
      const fmt =
        ext === ".woff2" ? "woff2" :
        ext === ".woff"  ? "woff"  :
        ext === ".otf"   ? "opentype" : "truetype";
      return { b64: buf.toString("base64"), mime, fmt };
    }
  }
  return null;
}

/* ================================================================ */

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).end();

  try {
    const u = req.query.u ? String(req.query.u) : "";
    if (!u) return res.status(400).json({ error: "missing ?u=" });

    // Parameter (robust geklammert)
    const width    = clamp(parseInt(req.query.w  ?? "1200", 10),  120, 3000);
    const wmTxt    = esc(req.query.wm ?? "PFOTENPIX - PREVIEW");
    const opacity  = clamp(parseFloat(req.query.op ?? "0.36"), 0.05, 0.8);
    const fontSize = clamp(parseInt(req.query.fs ?? "48", 10),  16, 160);
    const tileW    = clamp(parseInt(req.query.tw ?? "360",10), 120,  800);
    const tileH    = clamp(parseInt(req.query.th ?? "280",10), 100,  800);
    const angle    = Number(req.query.ang ?? -30);
    const fmt      = String((req.query.fmt ?? "jpeg")).toLowerCase(); // jpeg/webp/png
    const q        = clamp(parseInt(req.query.q ?? (fmt === "webp" ? 90 : 92), 10), 60, 100);

    // Sharp Sicherheitsventile
    sharp.cache(true);
    sharp.concurrency(0);                 // default
    const LIMIT_PIXELS = 80e6;            // 80 Mio. Pixel (z.B. 10k x 8k)
    sharp.limitInputPixels(LIMIT_PIXELS);

    // 1) Quellbild holen
    const srcBuf = await fetchUpstream(u);

    // 2) Vorverarbeitung: EXIF-orient, sRGB
    let pipeline = sharp(srcBuf, { failOn: "none", unlimited: false })
      .rotate()                            // EXIF-orient
      .toColorspace("srgb");               // in sRGB konvertieren

    // 3) auf Zielbreite, niemals vergrößern
    const resizedBuf = await pipeline
      .resize({ width, fit: "inside", withoutEnlargement: true })
      .toBuffer();

    // 4) Endmaße bestimmen
    const meta = await sharp(resizedBuf).metadata();
    const w = meta.width  || width;
    const h = meta.height || Math.round((w * 3) / 4);

    // 5) Font laden & einbetten
    const font = loadFontFromPublic(); // { b64, mime, fmt } | null
    const fontFace = font
      ? `@font-face{font-family:'pfpxwm';src:url(data:${font.mime};base64,${font.b64}) format('${font.fmt}');font-weight:600;font-style:normal;font-display:block;}`
      : "";
    const family = font ? "pfpxwm" : "DejaVu Sans, Liberation Sans, Arial, Helvetica, sans-serif";

    // 6) SVG-Overlay erzeugen
    const svg = (W,H)=>`
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
        <defs>
          <style>
            ${fontFace}
            text{ font-family:${family}; font-weight:600; text-rendering:optimizeLegibility; }
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

    const overlay = Buffer.from(svg(w, h));

    // 7) Compositing (WM drüber)
    let outSharp = sharp(resizedBuf).composite([{ input: overlay, top: 0, left: 0 }]);

    // 8) Ausgabeformat + Header
    if (fmt === "webp") {
      outSharp = outSharp.webp({ quality: q });
      res.setHeader("Content-Type", "image/webp");
    } else if (fmt === "png") {
      outSharp = outSharp.png({ compressionLevel: 9 });
      res.setHeader("Content-Type", "image/png");
    } else {
      outSharp = outSharp.jpeg({ quality: q, chromaSubsampling: "4:2:0", progressive: true });
      res.setHeader("Content-Type", "image/jpeg");
    }

    const out = await outSharp.toBuffer();

    // 9) Caching-Header
    res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=60");
    res.setHeader("X-PFPX-Proxy", "ok");
    return res.status(200).send(out);

  } catch (err) {
    console.error("preview-proxy error:", err);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(502).send(JSON.stringify({
      error: "proxy_failure",
      details: String(err && err.message ? err.message : err).slice(0, 400)
    }));
  }
}
