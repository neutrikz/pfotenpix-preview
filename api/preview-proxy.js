// /api/preview-proxy.js – Wasserzeichen-Proxy (ohne Header-Auth), nur erlaubte Origins/Referrer
// Abhängigkeit: sharp

import sharp from "sharp";

const ALLOWED_ORIGINS = [
  "https://pfotenpix.de",
  "https://www.pfotenpix.de",
  "https://pfotenpix-preview.vercel.app",
  "http://localhost:3000",
];

export const config = { api: { bodyParser: false } };

function getOriginHost(req) {
  const o = req.headers.origin || "";
  try { return new URL(o).origin; } catch { return ""; }
}
function referrerAllowed(req) {
  const ref = req.headers.referer || "";
  if (!ref) return false;
  try {
    const r = new URL(ref);
    return ALLOWED_ORIGINS.includes(`${r.protocol}//${r.host}`);
  } catch { return false; }
}
function applyCORS(req, res) {
  const origin = getOriginHost(req);
  const allow  = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin, Referer");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).end();

  // Erlaube nur Requests mit erlaubtem Origin ODER gültigem Referer
  const originOK  = ALLOWED_ORIGINS.includes(getOriginHost(req));
  const refererOK = referrerAllowed(req);
  if (!originOK && !refererOK) {
    return res.status(403).json({ error: "forbidden" });
  }

  try {
    const u = req.query.u ? String(req.query.u) : "";
    if (!u) return res.status(400).json({ error: "missing ?u=" });

    const width = Math.min(parseInt(req.query.w || "1200", 10) || 1200, 3000);
    const wmTxt = (req.query.wm || "PFOTENPIX • PREVIEW").toString();

    // 1) Upstream laden (OpenAI/CDN)
    const upstream = await fetch(u, { method: "GET" });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      return res.status(502).json({ error: `upstream ${upstream.status}`, details: txt?.slice(0, 500) });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());

    // 2) Resize
    let img = sharp(buf).resize({ width, fit: "inside", withoutEnlargement: true });

    // 3) Wasserzeichen als SVG-Pattern (sichtbar positioniert)
    const svg = (w, h) => `
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <defs>
          <pattern id="wm" width="280" height="230" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(-30)">
            <text x="12" y="42"
                  fill="black" fill-opacity="0.18"
                  font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
                  font-size="32" font-weight="700">
              ${wmTxt}
            </text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`;

    const meta = await img.metadata();
    const w = meta.width || width;
    const h = meta.height || Math.round(width);

    const overlay = Buffer.from(svg(w, h));
    img = img
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: 92, chromaSubsampling: "4:2:0" });

    const out = await img.toBuffer();

    // 4) Response
    res.setHeader("Content-Type", "image/jpeg");
    res.setHeader("Cache-Control", "private, max-age=300, stale-while-revalidate=60");
    return res.status(200).send(out);
  } catch (err) {
    console.error("preview-proxy error:", err);
    return res.status(500).json({ error: "proxy failure" });
  }
}
