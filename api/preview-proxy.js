// /api/preview-proxy.js – Wasserzeichen-/B/W-Proxy für externe Bild-URLs
// Sicherheit: verlangt x-pfpx-secret. Liefert CORS-Header für deinen Shop.

import sharp from "sharp";

const PFPX_SECRET = "pixpixpix";
const ALLOWED_ORIGINS = [
  "https://pfotenpix.de",
  "https://www.pfotenpix.de",
  "https://pfotenpix-preview.vercel.app",
  "http://localhost:3000",
];

export const config = { api: { bodyParser: false } };

function applyCORS(req, res) {
  const origin = req.headers.origin || "";
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader("Access-Control-Allow-Origin", allow);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-pfpx-secret");
  res.setHeader("Access-Control-Allow-Credentials", "true");
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).end();

  if (req.headers["x-pfpx-secret"] !== PFPX_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const u = req.query.u ? String(req.query.u) : "";
    if (!u) return res.status(400).json({ error: "missing ?u=" });

    const width = Math.min(parseInt(req.query.w || "1200", 10) || 1200, 3000);
    const bw    = req.query.bw === "1";
    const wmTxt = (req.query.wm || "PFOTENPIX • PREVIEW").toString();

    // 1) Upstream laden (OpenAI/CDN)
    const upstream = await fetch(u, { method: "GET" });
    if (!upstream.ok) {
      const txt = await upstream.text().catch(() => "");
      return res.status(502).json({ error: `upstream ${upstream.status}`, details: txt?.slice(0, 500) });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());

    // 2) Bild verarbeiten
    let img = sharp(buf).resize({ width, fit: "inside", withoutEnlargement: true });

    if (bw) img = img.toColourspace("b-w"); // garantiert monochrom

    // 3) Wasserzeichen via SVG-Kachel
    const svg = (w, h) => `
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <defs>
          <pattern id="wm" width="260" height="220" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(-30)">
            <text x="0" y="0"
                  fill="black" fill-opacity="0.16"
                  font-family="system-ui, sans-serif" font-size="32" font-weight="700">
              ${wmTxt}
            </text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`;

    // Wir brauchen die Dimensionen nach dem Resize
    const meta = await img.metadata();
    const w = meta.width || width, h = meta.height || Math.round(width);

    const overlay = Buffer.from(svg(w, h));
    img = img
      .composite([{ input: overlay, top: 0, left: 0 }])
      .jpeg({ quality: 92, chromaSubsampling: "4:2:0" }); // effizient & webfreundlich

    const out = await img.toBuffer();

    // 4) Response
    res.setHeader("Content-Type", "image/jpeg");
    // Cache kurz halten (OpenAI-URLs sind befristet)
    res.setHeader("Cache-Control", "private, max-age=300, stale-while-revalidate=60");
    return res.status(200).send(out);
  } catch (err) {
    console.error("preview-proxy error:", err);
    return res.status(500).json({ error: "proxy failure" });
  }
}
