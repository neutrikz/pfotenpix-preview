// /api/generate.js – Vercel Serverless Function für PfotenPix mit automatischer Maskenerstellung

export const config = { api: { bodyParser: false } };

import fetch from 'node-fetch';
import FormData from 'form-data';

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

async function fetchArrayBuffer(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: ctrl.signal });
    if (!response.ok) throw new Error(`fetch ${response.status}`);
    return await response.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}

function buildPrompt(style) {
  return {
    "natürlich": "Fotorealistische, natürliche Farbversion dieses Haustierfotos. Keine künstlerische Verfremdung.",
    "schwarzweiß": "Elegante Schwarz-Weiß-Version des Haustierfotos. Fein abgestufte Grautöne.",
    "neon": "Stilisierte Neon-Version im Pop-Art-Stil mit leuchtenden Akzenten und modernem Hintergrund."
  }[style] || "Fotorealistische Version des Bildes.";
}

async function generateMask(imageUrl) {
  const res = await fetch("https://replicate.com/api/models/yshrsmz/ISNet-anime-seg/predictions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`
    },
    body: JSON.stringify({
      version: "latest",
      input: { image: imageUrl }
    })
  });
  const data = await res.json();
  const maskUrl = data?.prediction?.output;
  if (!maskUrl) throw new Error("Maskenerstellung fehlgeschlagen.");
  return maskUrl;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Only POST allowed" });

  try {
    const secret = req.headers["x-pfpx-secret"];
    if (!secret || secret !== process.env.PFPX_SECRET) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    if (!process.env.OPENAI_API_KEY || !process.env.REPLICATE_API_TOKEN) {
      return res.status(500).json({ error: "Missing API keys" });
    }

    const body = await readJson(req);
    const imageUrl = body.image_url;
    const styles = Array.isArray(body.styles) && body.styles.length
      ? body.styles : ["natürlich", "schwarzweiß", "neon"];

    if (!imageUrl) return res.status(400).json({ error: "Missing image_url" });

    // Maske erzeugen
    const maskUrl = await generateMask(imageUrl);

    // Bild + Maske laden
    const imgBuf = Buffer.from(await fetchArrayBuffer(imageUrl));
    const maskBuf = Buffer.from(await fetchArrayBuffer(maskUrl));
    const imgName = imageUrl.split("/").pop()?.split("?")[0] || "upload.jpg";
    const maskName = "mask.png";

    async function makeEdit(style) {
      const prompt = buildPrompt(style);
      const form = new FormData();
      form.append("model", "gpt-image-1");
      form.append("prompt", prompt);
      form.append("image", imgBuf, imgName);
      form.append("mask", maskBuf, maskName);
      form.append("size", "1024x1024");
      form.append("n", "1");

      const response = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: form,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`OpenAI API Error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      const url = result?.data?.[0]?.url;
      if (!url) throw new Error("No URL returned from OpenAI.");
      return url;
    }

    const previews = {};
    for (const style of styles) {
      previews[style] = await makeEdit(style);
    }

    return res.status(200).json({ previews });

  } catch (err) {
    console.error("❌ Fehler bei der Generierung:", err.message || err);
    return res.status(500).json({ error: "Generation failed", detail: err.message || err });
  }
}
