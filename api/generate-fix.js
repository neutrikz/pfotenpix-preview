// /api/generate-fix.js – Stabil: unterstützt multipart/form-data (WP) & JSON (Fallback)
// Dependencies: sharp, jimp, formdata-node (bereits bei dir vorhanden)

import sharp from "sharp";
import Jimp from "jimp";
import { FormData } from "formdata-node";
import { Readable } from "stream";

// --- Konfiguration / Secrets ---
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const PFPX_SECRET = "pixpixpix";

// Vercel: BodyParser AUS, damit multipart nicht „weggeparst“ wird
export const config = {
  api: {
    bodyParser: false,
  },
};

// --- Utility: Roh-Body lesen (für JSON-Fallback) ---
async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// --- Mini multipart Parser (nur was wir brauchen: boundary, file, text) ---
function parseMultipart(buffer, boundary) {
  const CRLF = "\r\n";
  const delimiter = `--${boundary}`;
  const closeDelimiter = `--${boundary}--`;

  const body = buffer.toString("binary");
  const parts = body
    .split(delimiter)
    .filter((p) => p && p !== "--" && p !== closeDelimiter);

  const fields = {};
  const files = {};

  for (let rawPart of parts) {
    // Teile abtrennen, führende CRLF entfernen
    if (rawPart.startsWith(CRLF)) rawPart = rawPart.slice(CRLF.length);

    const [rawHeaders, rawContent] = splitOnce(rawPart, `${CRLF}${CRLF}`);

    const headerLines = rawHeaders.split(CRLF);
    const headers = {};
    for (const line of headerLines) {
      const idx = line.indexOf(":");
      if (idx > -1) {
        const key = line.slice(0, idx).trim().toLowerCase();
        const val = line.slice(idx + 1).trim();
        headers[key] = val;
      }
    }

    const cd = headers["content-disposition"] || "";
    // name="..."; filename="..."
    const nameMatch = /name="([^"]+)"/i.exec(cd);
    const filenameMatch = /filename="([^"]+)"/i.exec(cd);
    const contentType = (headers["content-type"] || "").toLowerCase();

    const name = nameMatch ? nameMatch[1] : "";

    // Inhalt: alles bis vor dem abschließenden CRLF + "--" (oder delimiter-Anfang)
    // Wir entfernen das trailing CRLF, das Teil trennt
    let contentBinary = rawContent;
    if (contentBinary.endsWith(CRLF)) {
      contentBinary = contentBinary.slice(0, -CRLF.length);
    }

    if (filenameMatch) {
      // Datei
      const filename = filenameMatch[1] || "upload.bin";
      const fileBuffer = Buffer.from(contentBinary, "binary");
      files[name] = {
        filename,
        contentType: contentType || "application/octet-stream",
        buffer: fileBuffer,
      };
    } else {
      // Feld
      const val = Buffer.from(contentBinary, "binary").toString("utf8");
      fields[name] = val;
    }
  }

  return { fields, files };

  function splitOnce(str, sep) {
    const idx = str.indexOf(sep);
    if (idx === -1) return [str, ""];
    return [str.slice(0, idx), str.slice(idx + sep.length)];
  }
}

export default async function handler(req, res) {
  console.log("✅ generate-fix.js gestartet");

  if (req.method !== "POST") return res.status(405).end();

  if (req.headers["x-pfpx-secret"] !== PFPX_SECRET) {
    console.warn("❌ Sicherheits-Token falsch oder fehlt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const ctype = (req.headers["content-type"] || "").toLowerCase();

    let sourceBuffer = null; // Originalbild
    let userText = ""; // optionaler Text

    if (ctype.startsWith("multipart/form-data")) {
      // --- multipart Pfad (von WordPress Snippet) ---
      const boundaryMatch = /boundary=([^;]+)/i.exec(ctype);
      if (!boundaryMatch) {
        console.warn("❌ multipart ohne boundary");
        return res.status(400).json({ error: "Bad multipart request" });
      }
      const boundary = boundaryMatch[1];

      const raw = await readRawBody(req);
      const { fields, files } = parseMultipart(raw, boundary);

      const file = files["file"];
      if (!file || !file.buffer) {
        console.warn("❌ multipart: Feld 'file' fehlt");
        return res.status(400).json({ error: "No file uploaded" });
      }
      userText = (fields["custom_text"] || fields["text"] || "").toString();

      sourceBuffer = file.buffer;
      console.log("📥 Bild empfangen (multipart), beginne Verarbeitung");
    } else if (ctype.includes("application/json")) {
      // --- JSON Fallback (älteres WP-Setup) ---
      const raw = await readRawBody(req);
      let body = {};
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch (e) {
        console.warn("❌ JSON parse fehlgeschlagen");
        return res.status(400).json({ error: "Invalid JSON" });
      }
      const { imageData, userText: userTextIn } = body || {};
      if (!imageData) {
        console.warn("❌ Kein imageData im JSON");
        return res.status(400).json({ error: "Kein Bild empfangen." });
      }
      const b64 = imageData.replace(/^data:image\/\w+;base64,/, "");
      sourceBuffer = Buffer.from(b64, "base64");
      userText = userTextIn || "";
      console.log("📥 Bild empfangen (JSON), beginne Verarbeitung");
    } else {
      console.warn("❌ Unsupported Content-Type:", ctype);
      return res.status(415).json({ error: "Unsupported Content-Type" });
    }

    // --- 1) RemBG aufrufen (Replicate) ---
    console.log("🎭 Rufe RemBG-API auf");
    const replicateRes = await fetch("https://api.replicate.com/v1/predictions", {
      method: "POST",
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        version:
          "fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003",
        input: {
          image: `data:image/png;base64,${sourceBuffer.toString("base64")}`,
          alpha_matting: true,
        },
      }),
    });

    const replicateJson = await replicateRes.json();
    if (!replicateJson.id) {
      console.error("❌ RemBG-Rückgabe ungültig", replicateJson);
      return res.status(500).json({ error: "Fehler bei RemBG (ID fehlt)" });
    }

    console.log("🕒 Warte auf RemBG-Output");
    const outputUrl = await pollReplicateResult(replicateJson.id);
    console.log("📤 Maske von RemBG erhalten:", outputUrl);

    const rembgBuffer = Buffer.from(await (await fetch(outputUrl)).arrayBuffer());

    // --- 2) Maske aus Alpha erstellen (Jimp), dann binarisieren & auf 1024x1024 resizen (Sharp) ---
    console.log("🖼️ Maske verarbeiten mit Jimp");
    const img = await Jimp.read(rembgBuffer);
    img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
      const alpha = this.bitmap.data[idx + 3];
      this.bitmap.data[idx + 0] = alpha;
      this.bitmap.data[idx + 1] = alpha;
      this.bitmap.data[idx + 2] = alpha;
    });
    img.greyscale().contrast(1.0);
    const tmpMaskPath = "/tmp/mask.png";
    await img.writeAsync(tmpMaskPath);

    const maskBuffer = await sharp(tmpMaskPath)
      .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .threshold(128)
      .png()
      .toBuffer();

    // Original auf 1024x1024 PNG (OpenAI limit: PNG < 4 MB)
    const resizedImageBuffer = await sharp(sourceBuffer)
      .resize(1024, 1024, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();

    // --- 3) Varianten via OpenAI Images Edits ---
    const styles = [
      { name: "natural", prompt: "enhance photo naturally, clean and realistic" },
      { name: "schwarzweiß", prompt: "convert to black and white stylish photo" },
      { name: "neon", prompt: "apply neon glow, futuristic style" },
    ];

    const previews = {}; // { stil: url }

    for (const style of styles) {
      console.log(`🎨 Sende an OpenAI (Stil: ${style.name})`);
      const form = new FormData();
      // formdata-node erlaubt Streams + filename
      form.set("image", Readable.from(resizedImageBuffer), "image.png");
      form.set("mask", Readable.from(maskBuffer), "mask.png");
      form.set(
        "prompt",
        `${style.prompt}${userText ? ` with text: "${userText}"` : ""}`
      );
      form.set("n", "1");
      form.set("size", "1024x1024");
      form.set("response_format", "url");

      const openaiRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          // formdata-node liefert die korrekten multipart-Header
          ...form.headers,
        },
        body: form,
      });

      const openaiJson = await openaiRes.json();
      if (!openaiRes.ok || !openaiJson?.data?.[0]?.url) {
        console.error(`❌ OpenAI-Fehler bei Stil '${style.name}':`, openaiJson);
        return res
          .status(openaiRes.status || 500)
          .json({ error: `OpenAI konnte den Stil '${style.name}' nicht generieren.` });
      }
      previews[style.name] = openaiJson.data[0].url;
      console.log(`✅ Stil '${style.name}' erfolgreich generiert`);
    }

    console.log("✅ Alle Varianten generiert");

    // 🔁 Antwortformat so, wie dein WP-Snippet es erwartet:
    // { previews: { stilName: url, ... } }
    return res.status(200).json({
      previews,
      success: true,
    });
  } catch (err) {
    console.error("❌ Unerwarteter Fehler in generate-fix.js:", err);
    return res.status(500).json({ error: "Interner Serverfehler" });
  }
}

// --- Replicate Poll Helper ---
async function pollReplicateResult(id, attempts = 0) {
  if (attempts > 20) throw new Error("Replicate timeout");

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: { Authorization: `Token ${REPLICATE_API_TOKEN}` },
  });
  const json = await res.json();

  if (json.status === "succeeded") {
    return json.output;
  } else if (json.status === "failed") {
    throw new Error("Replicate failed");
  } else {
    await new Promise((r) => setTimeout(r, 1500));
    return pollReplicateResult(id, attempts + 1);
  }
}
