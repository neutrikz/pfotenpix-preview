// /api/preview-proxy.js – Wasserzeichen-Proxy (CORS offen, sichtbares WM, http/https + data: Support)
// Mit Referer/User-Agent-Headern, damit Hotlink-/Firewall-Schutz den Upstream zulässt
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
  // data: direkt zurückgeben
  if (/^data:/i.test(u)) {
    const buf = bufferFromDataURL(u);
    if (!buf) throw new Error("bad data: url");
    return buf;
  }

  const url = new URL(u);
  const ua  = "pfpx-preview-proxy/1.3 (+https://pfotenpix.de)";
  const baseHeaders = {
    "user-agent": ua,
    "accept": "image/*,*/*;q=0.8",
    // viele Hotlink-Protections erwarten irgendeinen Referer; wir nehmen die Origin der Ziel-URL
    "referer": url.origin + "/",
    "accept-language": "de,en;q=0.9"
  };

  // 1. Versuch mit Origin-Referer
  let r = await fetch(u, { headers: baseHeaders, redirect: "follow", cache: "no-store" });

  // 2. Fallback: generischer Referer auf deine Seite (für manche strenge Regeln)
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
    const srcBuf = await fetchUpstream(u);

    // --- WICHTIGER FIX ---
    // 1) Zuerst auf Zielbreite verkleinern (kein Vergrößern)
    const resizedBuf = await sharp(srcBuf)
      .resize({ width, fit: "inside", withoutEnlargement: true })
      .toBuffer();

    // 2) Danach die tatsächlichen Endmaße ermitteln
    const meta = await sharp(resizedBuf).metadata();
    const w = meta.width  || width;
    const h = meta.height || Math.round((w * 3) / 4);

    // 3) SVG-Wasserzeichen exakt in Endmaßen bauen
    const svg = (W,H)=>`
      <svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
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
    const overlay = Buffer.from(svg(w, h));

    // 4) Composite mit exakt gleich großem Overlay
    let img = sharp(resizedBuf).composite([{ input: overlay, top: 0, left: 0 }]);

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
    // caching moderat + SWR
    res.setHeader("Cache-Control", "public, max-age=600, stale-while-revalidate=60");
    // kleiner Debug-Hinweis (optional)
    res.setHeader("X-PFPX-Proxy", "ok");
    return res.status(200).send(out);

  } catch (err) {
    console.error("preview-proxy error:", err);
    // Fehler klar beantworten (hilft beim Debugging, statt kaputtem <img>)
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    return res.status(502).send(JSON.stringify({ error: "proxy failure", details: String(err.message || err).slice(0, 400) }));
  }
}
