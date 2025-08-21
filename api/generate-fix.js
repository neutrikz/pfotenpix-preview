// /api/generate-fix.js – Stabil: multipart/form-data (WP) & JSON (Fallback)

import sharp from "sharp";
import Jimp from "jimp";
import { FormData, File } from "formdata-node"; // ⬅️ File nutzen für Upload-Parts

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const PFPX_SECRET = "pixpixpix";

export const config = {
  api: { bodyParser: false }, // wichtig für multipart
};

// ---- Utils ----
async function readRawBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  return Buffer.concat(chunks);
}

function parseMultipart(buffer, boundary) {
  const CRLF = "\r\n";
  const delim = `--${boundary}`;
  const closeDelim = `--${boundary}--`;
  const body = buffer.toString("binary");

  const parts = body
    .split(delim)
    .filter((p) => p && p !== "--" && p !== closeDelim);

  const fields = {};
  const files = {};

  for (let rawPart of parts) {
    if (rawPart.startsWith(CRLF)) rawPart = rawPart.slice(CRLF.length);
    const sep = CRLF + CRLF;
    const idx = rawPart.indexOf(sep);
    if (idx === -1) continue;

    const rawHeaders = rawPart.slice(0, idx);
    let rawContent = rawPart.slice(idx + sep.length);
    if (rawContent.endsWith(CRLF)) rawContent = rawContent.slice(0, -CRLF.length);

    const headers = {};
    for (const line of rawHeaders.split(CRLF)) {
      const j = line.indexOf(":");
      if (j > -1) headers[line.slice(0, j).trim().toLowerCase()] = line.slice(j + 1).trim();
    }
    const cd = headers["content-disposition"] || "";
    const name = (cd.match(/name="([^"]+)"/i) || [])[1];
    const filename = (cd.match(/filename="([^"]+)"/i) || [])[1];
    const ctype = headers["content-type"] || "";

    if (!name) continue;

    if (filename) {
      files[name] = {
        filename,
        contentType: ctype || "application/octet-stream",
        buffer: Buffer.from(rawContent, "binary"),
      };
    } else {
      fields[name] = Buffer.from(rawContent, "binary").toString("utf8");
    }
  }

  return { fields, files };
}

// ---- Replicate Poll ----
async function pollReplicateResult(id, attempts = 0) {
  if (attempts > 20) throw new Error("Replicate timeout");
  const r = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });
  const j = await r.json();
  if (j.status === "succeeded") return j.output;
  if (j.status === "failed") throw new Error("Replicate failed");
  await new Promise((s) => setTimeout(s, 1500));
  return pollReplicateResult(id, attempts + 1);
}

// ---- Handler ----
export default async function handler(req, res) {
  console.log("✅ generate-fix.js gestartet");

  if (req.method !== "POST") return res.status(405).end();

  if (req.headers["x-pfpx-secret"] !== PFPX_SECRET) {
    console.warn("❌ Sicherheits-Token falsch oder fehlt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();
    console.log("ℹ️ Content-Type:", ctype);

    let sourceBuffer = null; // Bilddaten
    let userText = "";       // optionaler Prompt-Text

    if (ctype.startsWith("multipart/form-data")) {
      const m = /boundary=([^;]+)/i.exec(ctype);
      if (!m) return res.status(400).json({ error: "Bad multipart request (no boundary)" });
      const boundary = m[1];

      const raw = await readRawBody(req);
      const { fields, files } = parseMultipart(raw, boundary);

      const file = files["file"];
      if (!file || !file.buffer) {
        console.warn("❌ multipart: Feld 'file' fehlt");
        return res.status(400).json({ error: "No file uploaded" });
      }
      sourceBuffer = file.buffer;
      userText = (fields["custom_text"] || fields["text"] || "").toString();
      console.log("📥 Bild empfangen (multipart)");
    } else if (ctype.includes("application/json")) {
      const raw = await readRawBody(req);
      let body = {};
      try { body = JSON.parse(raw.toString("utf8")); } catch { /* noop */ }
      const b64 = (body.imageData || "").replace(/^data:image\/\w+;base64,/, "");
      if (!b64) return res.status(400).json({ error: "Kein Bild empfangen." });
      sourceBuffer = Buffer.from(b64, "base64");
      userText = body.userText || "";
      console.log("📥 Bild empfangen (JSON)");
    } else {
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // --- 1) RemBG (Replicate) ---
    console.log("🎭 Rufe RemBG-API auf");
    const repRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version: "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
        input: {
          image: `data:image/png;base64,${sourceBuffer.toString("base64")}`,
          alpha_matting: true,
        },
      }),
    });
    const repJson = await repRes.json();
    if (!repJson.id) {
      console.error("❌ RemBG-Rückgabe ungültig", repJson);
      return res.status(500).json({ error: "Fehler bei RemBG (ID fehlt)" });
    }

    console.log("🕒 Warte auf RemBG-Output");
    const maskUrl = await pollReplicateResult(repJson.id);
    console.log("📤 Maske von RemBG erhalten:", maskUrl);

    const rembgBuffer = Buffer.from(await (await fetch(maskUrl)).arrayBuffer());

    // --- 2) Maske erzeugen & beide Bilder auf 1024x1024 PNG bringen ---
    console.log("🖼️ Maske verarbeiten mit Jimp");
    const jimg = await Jimp.read(rembgBuffer);
    jimg.scan(0, 0, jimg.bitmap.width, jimg.bitmap.height, function (x, y, idx) {
      const a = this.bitmap.data[idx + 3];
      this.bitmap.data[idx + 0] = a;
      this.bitmap.data[idx + 1] = a;
      this.bitmap.data[idx + 2] = a;
    });
    jimg.greyscale().contrast(1.0);
    await jimg.writeAsync("/tmp/mask.png");

    const maskBuffer = await sharp("/tmp/mask.png")
      .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .threshold(128)
      .png()
      .toBuffer();

    const inputPng = await sharp(sourceBuffer)
      .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // --- 3) OpenAI Images Edits ---
    const styles = [
      { name: "natural",     prompt: "enhance photo naturally, clean and realistic" },
      { name: "schwarzweiß", prompt: "convert to black and white stylish photo" },
      { name: "neon",        prompt: "apply neon glow, futuristic style" },
    ];

    const previews = {}; // { stilName: url }

    for (const style of styles) {
      console.log(`🎨 Sende an OpenAI (Stil: ${style.name})`);

      // ⬇️ WICHTIG: Datei-Parts als File-Objekte übergeben (kein Readable/Buffer direkt)
      const form = new FormData();
      form.set("image", new File([inputPng], "image.png", { type: "image/png" }));
      form.set("mask",  new File([maskBuffer], "mask.png",   { type: "image/png" }));
      form.set("prompt", `${style.prompt}${userText ? ` with text: "${userText}"` : ""}`);
      form.set("n", "1");
      form.set("size", "1024x1024");
      form.set("response_format", "url");

      const oi = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, ...form.headers },
        body: form,
      });
      const oiJson = await oi.json();
      if (!oi.ok || !oiJson?.data?.[0]?.url) {
        console.error(`❌ OpenAI-Fehler bei Stil '${style.name}':`, oiJson);
        return res
          .status(oi.status || 500)
          .json({ error: `OpenAI konnte den Stil '${style.name}' nicht generieren.` });
      }
      previews[style.name] = oiJson.data[0].url;
      console.log(`✅ Stil '${style.name}' erfolgreich generiert`);
    }

    console.log("✅ Alle Varianten generiert");
    return res.status(200).json({ success: true, previews });

  } catch (err) {
    console.error("❌ Unerwarteter Fehler in generate-fix.js:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}
