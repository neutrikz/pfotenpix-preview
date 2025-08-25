// /api/upscale.js – 4× Upscaler für Druckdateien
import sharp from "sharp";
import { FormData, File } from "formdata-node";

export const config = { api: { bodyParser: false } };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}
async function readRaw(req) { const chunks=[]; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }

function dataToBuffer(u) {
  const m = /^data:(.+);base64,(.+)$/i.exec(u||"");
  if (!m) return null;
  return Buffer.from(m[2], "base64");
}
async function fetchBufferFromUrl(u) {
  // data: direkt
  const db = dataToBuffer(u);
  if (db) return db;

  const r = await fetch(u, {
    headers: {
      "user-agent": "pfpx-upscale/1.0 (+https://pfotenpix.de)",
      "accept": "image/*,*/*;q=0.8",
      "referer": new URL(u).origin + "/"
    },
    redirect: "follow",
    cache: "no-store"
  });
  if (!r.ok) throw new Error(`fetch ${r.status}`);
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

async function parseInput(req) {
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  if (ct.includes("application/json")) {
    const j = JSON.parse((await readRaw(req)).toString("utf8") || "{}");
    if (j.url)  return await fetchBufferFromUrl(String(j.url));
    if (j.data) return dataToBuffer(String(j.data));
    throw new Error("no url/data");
  }
  if (ct.startsWith("multipart/form-data")) {
    // minimal multipart: nur 'file' wird akzeptiert
    const boundary = /boundary=([^;]+)/i.exec(ct)?.[1];
    if (!boundary) throw new Error("bad multipart");
    const bin = (await readRaw(req)).toString("binary");
    const CRLF = "\r\n", delim = `--${boundary}`;
    const parts = bin.split(delim).filter(Boolean);
    for (const p of parts) {
      const i = p.indexOf(CRLF + CRLF); if (i < 0) continue;
      const head = p.slice(0, i), body = p.slice(i + 4);
      const cd = /name="([^"]+)"/i.exec(head)?.[1];
      if (cd === "file") {
        const content = body.endsWith(CRLF) ? body.slice(0, -2) : body;
        return Buffer.from(content, "binary");
      }
    }
    throw new Error("no file");
  }
  throw new Error("unsupported");
}

async function upscaleWithClipdrop(buf) {
  const key = process.env.CLIPDROP_API_KEY;
  if (!key) return null;

  const form = new FormData();
  form.set("image_file", new File([buf], "source.png", { type: "image/png" })); // Clipdrop wandelt selbst
  const r = await fetch("https://clipdrop-api.co/super-resolution/v1", {
    method: "POST",
    headers: { "x-api-key": key, ...form.headers },
    body: form
  });
  if (!r.ok) return null;
  // liefert Binärbild (meist PNG/JPEG)
  const ab = await r.arrayBuffer();
  return Buffer.from(ab);
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")     return res.status(405).end();

  try {
    const srcBuf = await parseInput(req);
    if (!srcBuf || srcBuf.length === 0) return res.status(400).json({ error: "no image" });

    // 1) Versuche Clipdrop 4×
    let out = await upscaleWithClipdrop(srcBuf);

    // 2) Fallback: Sharp 4× (Lanczos3)
    if (!out) {
      const meta = await sharp(srcBuf).metadata();
      const w = Math.max(1, meta.width  || 1024) * 4;
      const h = Math.max(1, meta.height || 1024) * 4;
      out = await sharp(srcBuf).resize({ width: Math.round(w), height: Math.round(h), kernel: "lanczos3" }).png().toBuffer();
    }

    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).send(out);
  } catch (e) {
    console.error("upscale error:", e);
    return res.status(500).json({ error: "upscale_failed", detail: String(e.message || e) });
  }
}
