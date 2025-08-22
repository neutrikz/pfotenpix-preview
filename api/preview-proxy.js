// /api/preview-proxy.js – Wasserzeichen-Proxy (offene CORS, sichtbares WM, wählbares Format)
import sharp from "sharp";
export const config = { api: { bodyParser: false } };

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

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).end();

  try {
    const u = req.query.u ? String(req.query.u) : "";
    if (!u) return res.status(400).json({ error: "missing ?u=" });

    const width = Math.min(parseInt(req.query.w || "1200", 10) || 1200, 3000);
    const wmTxt = esc(req.query.wm || "PFOTENPIX • PREVIEW");

    // Neu: sichtbarer & steuerbarer Look
    const opacity = Math.min(Math.max(parseFloat(req.query.op || "0.32"), 0.05), 0.6); // 0.32 default
    const fontSize = Math.min(Math.max(parseInt(req.query.fs || "42", 10) || 42, 16), 120);
    const tileW    = Math.min(Math.max(parseInt(req.query.tw || "360", 10) || 360, 120), 600);
    const tileH    = Math.min(Math.max(parseInt(req.query.th || "300", 10) || 300, 100), 600);
    const angle    = parseFloat(req.query.ang || "-30");

    // Optionales Ausgabeformat (jpeg/webp/png), default jpeg
    const fmt = String((req.query.fmt || "jpeg")).toLowerCase();

    const upstream = await fetch(u);
    if (!upstream.ok) {
      const txt = await upstream.text().catch(()=> "");
      return res.status(502).json({ error:`upstream ${upstream.status}`, details: txt?.slice(0,500) });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());

    let img = sharp(buf).resize({ width, fit:"inside", withoutEnlargement:true });

    const svg = (w,h)=>`
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <defs>
          <pattern id="wm" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(${angle})">
            <!-- Doppelte Schicht: sichtbarer auf hell & dunkel -->
            <text x="12" y="${Math.round(fontSize)}"
              fill="black" fill-opacity="${opacity}"
              stroke="white" stroke-opacity="${Math.min(opacity*0.75,0.5)}" stroke-width="1.8"
              font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
              font-size="${fontSize}" font-weight="800">${wmTxt}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`;

    const meta = await img.metadata();
    const w = meta.width || width, h = meta.height || Math.round(width);
    const overlay = Buffer.from(svg(w,h));

    img = img.composite([{ input: overlay, top:0, left:0 }]);

    // Ausgabeformat anwenden
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
    res.setHeader("Cache-Control", "private, max-age=300, stale-while-revalidate=60");
    return res.status(200).send(out);
  } catch (err) {
    console.error("preview-proxy error:", err);
    return res.status(500).json({ error:"proxy failure" });
  }
}
