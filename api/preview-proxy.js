// /api/preview-proxy.js – Wasserzeichen-Proxy (offene CORS, keine Header-Auth)

import sharp from "sharp";
export const config = { api: { bodyParser: false } };

function applyCORS(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).end();

  try {
    const uRaw = req.query.u ? String(req.query.u) : "";
    if (!uRaw) return res.status(400).json({ error: "missing ?u=" });

    // Nur http/https zulassen (keine data:, file:, etc.)
    const isHttp = /^https?:\/\//i.test(uRaw);
    if (!isHttp) return res.status(400).json({ error: "unsupported scheme (expected http/https)" });

    // Größe & Format
    const width = Math.min(parseInt(req.query.w || "1200", 10) || 1200, 3000);
    const fmt   = String(req.query.fmt || "jpeg").toLowerCase(); // jpeg | webp | png | avif
    const wmTxt = (req.query.wm || "PFOTENPIX • PREVIEW").toString();

    // Upstream mit Timeout und sinnvollen Accept-Headern holen
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 45000); // 45s
    const upstream = await fetch(uRaw, {
      method: "GET",
      headers: {
        "Accept": "image/*,*/*;q=0.8",
        "User-Agent": "PfotenPix-PreviewProxy/1.0 (+https://pfotenpix.de)"
      },
      // kein `credentials`, keine Referrer-Infos
      redirect: "follow",
      signal: ctrl.signal,
      // referrerPolicy nur im Browser relevant; Node ignoriert
    }).catch((e) => {
      throw new Error("upstream fetch failed: " + (e?.message || "unknown"));
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      const txt = await upstream.text().catch(()=> "");
      return res.status(502).json({
        error: `upstream ${upstream.status}`,
        details: (txt || "").slice(0, 500)
      });
    }

    const buf = Buffer.from(await upstream.arrayBuffer());

    // 1) Basisschritt: EXIF-Orientierung respektieren & auf Zielbreite skalieren
    const { data: baseBuf, info } = await sharp(buf)
      .rotate() // respektiert EXIF-Orientation
      .resize({ width, fit: "inside", withoutEnlargement: true })
      .toBuffer({ resolveWithObject: true });

    // 2) Dynamisches SVG-Wasserzeichen passend zur Zielgröße bauen
    const outW = info.width  || width;
    const outH = info.height || Math.round(width);

    // Font & Kachelgröße relativ zur Bildbreite
    const fontSize = Math.max(18, Math.round(outW / 35));         // z.B. ~34pt bei 1200px
    const tileW    = Math.max(220, Math.round(fontSize * 7.5));   // Kachelbreite
    const tileH    = Math.max(180, Math.round(fontSize * 6.0));   // Kachelhöhe
    const padX     = Math.round(fontSize * 0.6);
    const padY     = Math.round(fontSize * 1.2);

    const svg = (w,h)=>`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs>
        <pattern id="wm" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse" patternTransform="rotate(-30)">
          <text x="${padX}" y="${padY}"
            fill="#000" fill-opacity="0.18"
            font-family="system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
            font-size="${fontSize}" font-weight="700"
            textLength="${tileW - padX * 2}" lengthAdjust="spacingAndGlyphs">${escapeXml(wmTxt)}</text>
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#wm)"/>
    </svg>`;

    const overlay = Buffer.from(svg(outW, outH));

    // 3) Watermark auf die bereits skalierte Basis legen
    let pipeline = sharp(baseBuf).composite([{ input: overlay, top: 0, left: 0 }]);

    // 4) Format wählen (Standard JPEG)
    switch (fmt) {
      case "png":
        pipeline = pipeline.png({ compressionLevel: 8, adaptiveFiltering: true });
        res.setHeader("Content-Type", "image/png");
        break;
      case "webp":
        pipeline = pipeline.webp({ quality: 90 });
        res.setHeader("Content-Type", "image/webp");
        break;
      case "avif":
        pipeline = pipeline.avif({ quality: 50 }); // AVIF braucht geringere Q-Werte
        res.setHeader("Content-Type", "image/avif");
        break;
      default: // jpeg
        pipeline = pipeline.jpeg({ quality: 92, chromaSubsampling: "4:2:0" });
        res.setHeader("Content-Type", "image/jpeg");
        break;
    }

    const out = await pipeline.toBuffer();

    // Kurzer Cache für CDN/Browser
    res.setHeader("Cache-Control", "public, max-age=300, s-maxage=600, stale-while-revalidate=60");
    res.setHeader("X-PFPX-Proxy", "1");
    return res.status(200).send(out);

  } catch (err) {
    console.error("preview-proxy error:", err);
    const msg = (err && err.message) ? err.message : String(err);
    return res.status(500).json({ error: "proxy failure", message: msg });
  }
}

// Hilfsfunktion: SVG/XML-escape fürs Wasserzeichen
function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
