// /api/preview-proxy.js – Wasserzeichen-Proxy (CORS offen, sichtbares WM, http/https + data: Support)
import sharp from "sharp";
export const config = { api: { bodyParser: false } };

function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Type, Cache-Control");
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
  try {
    return Buffer.from(m[2], "base64");
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).end();

  try {
    const u = req.query.u ? String(req.query.u) : "";
    if (!u) return res.status(400).json({ error: "missing ?u=" });

    // Größen- & WM-Parameter (Defaults auf deine Frontend-Werte abgestimmt)
    const width    = Math.min(parseInt(req.query.w   || "1200", 10) || 1200, 4000);
    const wmTxt    = esc(req.query.wm  || "PFOTENPIX • PREVIEW");
    const opacity  = Math.min(Math.max(parseFloat(req.query.op  || "0.36"), 0.05), 0.85);
    const fontSize = Math.min(Math.max(parseInt (req.query.fs  || "48",   10) || 48, 16), 160);
    const tileW    = Math.min(Math.max(parseInt (req.query.tw  || "360",  10) || 360, 120), 800);
    const tileH    = Math.min(Math.max(parseInt (req.query.th  || "280",  10) || 280, 100), 800);
    const angle    = parseFloat(req.query.ang || "-30");
    const fmtRaw   = String(req.query.fmt || "jpeg").toLowerCase();
    const fmt      = (fmtRaw === "png" || fmtRaw === "webp") ? fmtRaw : "jpeg";

    // Quelle besorgen (http/https ODER data:)
    let srcBuf = null;
    if (/^data:/i.test(u)) {
      srcBuf = bufferFromDataURL(u);
      if (!srcBuf) return res.status(400).json({ error: "bad data: url" });
    } else {
      const upstream = await fetch(u, {
        // paar Hosts mögen Requests ohne Headers nicht
        headers: {
          "User-Agent": "PfotenPixProxy/1.0 (+https://pfotenpix.de)",
          "Accept": "image/*,*/*;q=0.8"
        }
      });
      if (!upstream.ok) {
        const txt = await upstream.text().catch(()=> "");
        return res.status(502).json({ error:`upstream ${upstream.status}`, details: (txt || "").slice(0,500) });
      }
      const ab = await upstream.arrayBuffer();
      srcBuf = Buffer.from(ab);
    }

    // Bild vorbereiten
    let img = sharp(srcBuf)
      .rotate() // EXIF-Orientierung respektieren
      .resize({ width, fit: "inside", withoutEnlargement: true });

    // SVG-Wasserzeichen (Kachelung, diagonal)
    const svg = (w, h) => `
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <defs>
          <pattern id="wm" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(${angle})">
            <text x="12" y="${Math.round(fontSize * 0.9)}"
              fill="black" fill-opacity="${opacity}"
              stroke="white" stroke-opacity="${Math.min(opacity * 0.75, 0.55)}" stroke-width="2"
              font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
              font-size="${fontSize}" font-weight="800">${wmTxt}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`.trim();

    const meta = await img.metadata();
    const outW = meta.width  || width;
    const outH = meta.height || Math.round(width * 0.75);

    const overlay = Buffer.from(svg(outW, outH));
    img = img.composite([{ input: overlay, top: 0, left: 0 }]);

    // Ausgabeformat
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
    // Kurzes privates Caching auf Client/Vercel, revalidierbar
    res.setHeader("Cache-Control", "private, max-age=300, stale-while-revalidate=60");
    return res.status(200).send(out);
  } catch (err) {
    console.error("preview-proxy error:", err);
    return res.status(500).json({ error: "proxy failure" });
  }
}
