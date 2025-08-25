// /api/upscale-pad.js – Upscale + Mirror-Pad (natürlicher Rand)
// POST JSON: { url: "https://...", dataurl?: "data:image/..." }
// Query: ?ratio=21x30|3:4|1:1  & matte=0.12  & fmt=png|jpeg  & max=4096  & edge=4  & bgblur=16
// Antwort: Bildstream (image/png|image/jpeg)

import sharp from "sharp";

export const config = { api: { bodyParser: false } };

function cors(res){
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}
function clamp(n, lo, hi){ return Math.min(Math.max(Number(n), lo), hi); }
function parseRatio(raw){
  if (!raw) return 1;
  const s = String(raw).trim()
    .replace(/[×x/]/gi, ":")
    .replace(/\s*cm\b/gi,"")
    .replace(/[^\d:.\-]/g, "");
  const [a,b] = s.split(":").map(Number);
  if (!a || !b) return 1;
  return Math.max(0.05, Math.min(20, a/b));
}
function isHttp(u){ return /^https?:\/\//i.test(u||""); }
function isData(u){ return /^data:image\//i.test(u||""); }
async function readRawBody(req){ const bufs=[]; for await(const ch of req) bufs.push(ch); return Buffer.concat(bufs); }
function bufFromDataURL(u){ const m=/^data:image\/[a-z0-9+.\-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(u||""); return m?Buffer.from(m[1],"base64"):null; }

async function fetchUpstream(u){
  if (isData(u)) {
    const b = bufFromDataURL(u);
    if (!b) throw new Error("Bad data URL");
    return b;
  }
  if (!isHttp(u)) throw new Error("URL must be http(s) or data:");
  const url = new URL(u);
  const headers = {
    "user-agent": "pfpx-upscale-mirror/1.1 (+https://pfotenpix.de)",
    "accept": "image/*,*/*;q=0.8",
    "referer": url.origin + "/",
    "accept-language": "de,en;q=0.9",
  };
  let r = await fetch(u, { headers, redirect:"follow", cache:"no-store" });
  if (!r.ok) r = await fetch(u, { headers: { ...headers, referer:"https://pfotenpix.de/" }, redirect:"follow", cache:"no-store" });
  if (!r.ok) {
    const txt = await r.text().catch(()=> "");
    throw new Error(`upstream ${r.status} ${r.statusText} :: ${txt.slice(0,180)}`);
  }
  return Buffer.from(await r.arrayBuffer());
}

export default async function handler(req,res){
  cors(res);
  if (req.method==="OPTIONS") return res.status(204).end();
  if (req.method!=="POST")   return res.status(405).json({error:"Method not allowed"});

  try{
    // ---- Params ----
    const ratio   = parseRatio(req.query.ratio || "1:1");
    const matte   = clamp(req.query.matte ?? 0.12, 0, 0.49);   // Anteil je Seite
    const fmt     = (String(req.query.fmt||"png").toLowerCase()==="jpeg") ? "jpeg" : "png";
    const maxEdge = clamp(req.query.max ?? 4096, 512, 8192);
    const edgePx  = clamp(req.query.edge ?? 4, 1, 32);         // Quellbreite für Spiegelleisten
    const bgBlur  = clamp(req.query.bgblur ?? 16, 0, 100);     // Blur der Basisfläche (Eckenfüllung)

    // ---- Body ----
    const ct = String(req.headers["content-type"]||"").toLowerCase();
    let srcBuf=null;
    if (ct.includes("application/json")){
      const j = JSON.parse((await readRawBody(req)).toString("utf8")||"{}");
      if (j.dataurl) srcBuf = bufFromDataURL(j.dataurl);
      else if (j.url) srcBuf = await fetchUpstream(j.url);
      else throw new Error("Body must contain {url} or {dataurl}");
      if (!srcBuf) throw new Error("Invalid dataurl");
    } else { throw new Error("Content-Type must be application/json"); }

    const meta = await sharp(srcBuf).metadata();
    if (!(meta.width && meta.height)) throw new Error("Cannot read image");

    // ---- Zielgeometrie ----
    const W = ratio >= 1 ? maxEdge : Math.round(maxEdge * ratio);
    const H = ratio >= 1 ? Math.round(maxEdge / ratio) : maxEdge;

    const innerW = Math.max(1, Math.floor(W * (1 - 2*matte)));
    const innerH = Math.max(1, Math.floor(H * (1 - 2*matte)));

    // 1) Zentrales Motiv auf Innenmaß (lanczos3)
    const contentBuf = await sharp(srcBuf)
      .resize({ width: innerW, height: innerH, fit: "inside", kernel: sharp.kernel.lanczos3, withoutEnlargement: false })
      .toBuffer();
    const cMeta = await sharp(contentBuf).metadata();
    const padL = Math.floor((W - (cMeta.width  || innerW)) / 2);
    const padT = Math.floor((H - (cMeta.height || innerH)) / 2);
    const padR = W - padL - (cMeta.width  || innerW);
    const padB = H - padT - (cMeta.height || innerH);

    // 2) Basis: geblurrte Cover-Füllung für die Ecken
    const baseBuf = await sharp(srcBuf).resize({ width: W, height: H, fit: "cover" }).blur(bgBlur).toBuffer();
    let canvas = sharp(baseBuf);

    // 3) Aus den Rändern des *resized* Innenbilds Spiegelleisten bauen
    const e = Math.min(edgePx, Math.max(1, Math.floor((cMeta.width||innerW)/100))); // ~1% oder edgePx
    const eY = Math.min(edgePx, Math.max(1, Math.floor((cMeta.height||innerH)/100)));

    // Links
    const leftStrip = await sharp(contentBuf).extract({ left:0, top:0, width:e, height:cMeta.height })
      .flop().resize({ width: padL, height:cMeta.height }).blur(3).toBuffer();
    // Rechts
    const rightStrip = await sharp(contentBuf).extract({ left:cMeta.width - e, top:0, width:e, height:cMeta.height })
      .resize({ width: padR, height:cMeta.height }).blur(3).toBuffer();
    // Oben
    const topStrip = await sharp(contentBuf).extract({ left:0, top:0, width:cMeta.width, height:eY })
      .flip().resize({ width:cMeta.width, height: padT }).blur(3).toBuffer();
    // Unten
    const bottomStrip = await sharp(contentBuf).extract({ left:0, top:cMeta.height - eY, width:cMeta.width, height:eY })
      .resize({ width:cMeta.width, height: padB }).blur(3).toBuffer();

    // 4) Ecken (aus den vier Content-Ecken) – sanft verwischt
    const cornerSize = 12;
    const lt = await sharp(contentBuf).extract({ left:0, top:0, width:cornerSize, height:cornerSize })
      .resize({ width: padL, height: padT }).blur(6).toBuffer();
    const rt = await sharp(contentBuf).extract({ left:cMeta.width-cornerSize, top:0, width:cornerSize, height:cornerSize })
      .resize({ width: padR, height: padT }).blur(6).toBuffer();
    const lb = await sharp(contentBuf).extract({ left:0, top:cMeta.height-cornerSize, width:cornerSize, height:cornerSize })
      .resize({ width: padL, height: padB }).blur(6).toBuffer();
    const rb = await sharp(contentBuf).extract({ left:cMeta.width-cornerSize, top:cMeta.height-cornerSize, width:cornerSize, height:cornerSize })
      .resize({ width: padR, height: padB }).blur(6).toBuffer();

    // 5) Komposition: Streifen + Ecken + zentrales Motiv
    const composites = [
      // Seiten
      { input: leftStrip,   left: 0,                top: padT },
      { input: rightStrip,  left: W - padR,         top: padT },
      { input: topStrip,    left: padL,             top: 0 },
      { input: bottomStrip, left: padL,             top: H - padB },
      // Ecken
      { input: lt, left: 0,         top: 0 },
      { input: rt, left: W - padR,  top: 0 },
      { input: lb, left: 0,         top: H - padB },
      { input: rb, left: W - padR,  top: H - padB },
      // Inhalt
      { input: contentBuf, left: padL, top: padT }
    ];
    canvas = canvas.composite(composites);

    // Ausgabe
    if (fmt === "jpeg"){
      res.setHeader("Content-Type","image/jpeg");
      const out = await canvas.jpeg({ quality:95, chromaSubsampling:"4:4:4" }).toBuffer();
      res.setHeader("Cache-Control","no-store");
      return res.status(200).send(out);
    } else {
      res.setHeader("Content-Type","image/png");
      const out = await canvas.png({ compressionLevel:9 }).toBuffer();
      res.setHeader("Cache-Control","no-store");
      return res.status(200).send(out);
    }

  } catch(err){
    console.error("upscale-pad (mirror) error:", err);
    res.setHeader("Content-Type","application/json; charset=utf-8");
    return res.status(500).send(JSON.stringify({ error:"upscale failure", detail:String(err?.message||err).slice(0,300) }));
  }
}
