// /api/preview-proxy.js – Wasserzeichen-Proxy (CORS offen, sichtbares WM, http/https + data: Support, UA+Referer)
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

// data: → Buffer
function bufferFromDataURL(u) {
  const m = /^data:(.+?);base64,(.+)$/i.exec(u || "");
  if (!m) return null;
  return Buffer.from(m[2], "base64");
}

async function fetchUpstream(u) {
  // Für WordPress/Hoster, die strenge Header erwarten:
  let referer = "";
  try { referer = new URL(u).origin + "/"; } catch (_) {}

  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 15000); // 15s Timeout

  try {
    const res = await fetch(u, {
      method: "GET",
      redirect: "follow",
      headers: {
        // Browser-ähnlicher UA + passende Accepts
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 PfotenPixProxy/1.0",
        "Accept":
          "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "de,en;q=0.8",
        ...(referer ? { Referer: referer } : {}),
      },
      signal: controller.signal,
    });
    clearTimeout(to);
    return res;
  } catch (e) {
    clearTimeout(to);
    throw e;
  }
}

export default async function handler(req, res) {
  applyCORS(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")     return res.status(405).end();

  try {
    const u = req.query.u ? String(req.query.u) : "";
    if (!u) return res.status(400).json({ error: "missing ?u=" });

    const width   = Math.min(parseInt(req.query.w || "1200", 10) || 1200, 3000);
    const wmTxt   = esc(req.query.wm || "PFOTENPIX • PREVIEW");
    const opacity = Math.min(Math.max(parseFloat(req.query.op || "0.36"), 0.05), 0.8);
    const fontSize= Math.min(Math.max(parseInt(req.query.fs || "48", 10) || 48, 16), 160);
    const tileW   = Math.min(Math.max(parseInt(req.query.tw || "360", 10) || 360, 120), 800);
    const tileH   = Math.min(Math.max(parseInt(req.query.th || "280", 10) || 280, 100), 800);
    const angle   = parseFloat(req.query.ang || "-30");
    const fmt     = String((req.query.fmt || "jpeg")).toLowerCase(); // jpeg/webp/png

    // Quelle besorgen (http/https ODER data:)
    let srcBuf = null;
    if (/^data:/i.test(u)) {
      srcBuf = bufferFromDataURL(u);
      if (!srcBuf) return res.status(400).json({ error: "bad data: url" });
    } else {
      const upstream = await fetchUpstream(u);
      if (!upstream.ok) {
        const snippet = (await upstream.text().catch(()=> "")).slice(0, 400);
        return res.status(502).json({
          error: `upstream ${upstream.status}`,
          details: snippet
        });
      }
      const ct = upstream.headers.get("content-type") || "";
      // Wenn Host HTML liefert (z.B. WAF-Blockseite), nicht an Sharp geben
      if (ct && !/^image\//i.test(ct)) {
        const snippet = (await upstream.text().catch(()=> "")).slice(0, 400);
        return res.status(502).json({ error: "non-image upstream", details: snippet });
      }
      srcBuf = Buffer.from(await upstream.arrayBuffer());
    }

    let img = sharp(srcBuf).resize({ width, fit:"inside", withoutEnlargement:true });

    const svg = (w,h)=>`
      <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
        <defs>
          <pattern id="wm" width="${tileW}" height="${tileH}" patternUnits="userSpaceOnUse"
                   patternTransform="rotate(${angle})">
            <text x="12" y="${Math.round(fontSize)}"
              fill="black" fill-opacity="${opacity}"
              stroke="white" stroke-opacity="${Math.min(opacity*0.7,0.5)}" stroke-width="2"
              font-family="system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif"
              font-size="${fontSize}" font-weight="800">${wmTxt}</text>
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#wm)"/>
      </svg>`;

    const meta = await img.metadata();
    const w = meta.width || width, h = meta.height || Math.round(width * 0.75);
    const overlay = Buffer.from(svg(w,h));
    img = img.composite([{ input: overlay, top:0, left:0 }]);

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
    res.setHeader("Content-Disposition", "inline; filename=\"pfpx-preview."+ (fmt==="png"?"png":fmt==="webp"?"webp":"jpg") +"\"");
    return res.status(200).send(out);
  } catch (err) {
    console.error("preview-proxy error:", err);
    return res.status(500).json({ error:"proxy failure" });
  }
}
