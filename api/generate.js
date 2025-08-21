// /api/generate.js
import fetch from 'node-fetch';
import sharp from 'sharp';
import { Readable } from 'stream';
import Jimp from 'jimp';
import { v4 as uuidv4 } from 'uuid';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REPLICATE_API_TOKEN = process.env.REPLICATE_API_TOKEN;
const PFPX_SECRET = 'pixpixpix';

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  if (req.headers['x-pfpx-secret'] !== PFPX_SECRET) return res.status(401).json({ error: 'Unauthorized' });

  const { imageData, userText } = req.body;
  if (!imageData) return res.status(400).json({ error: 'Kein Bild empfangen.' });

  try {
    // 🖼️ 1. Originalbild dekodieren
    const buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ""), 'base64');

    // 🎭 2. Maske mit Replicate erzeugen
    const replicateRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: "7f7d79d6c3...", // <- deine konkrete Modellversion hier einsetzen
        input: {
          image: `data:image/png;base64,${buffer.toString('base64')}`
        }
      }),
    });

    const replicateJson = await replicateRes.json();
    const maskUrl = await pollReplicateResult(replicateJson.id);

    // 🪄 3. Maske in transparentes PNG umwandeln
    const maskBuffer = await fetch(maskUrl).then(r => r.arrayBuffer());
    const maskImage = await Jimp.read(Buffer.from(maskBuffer));
    maskImage.greyscale().contrast(1).writeAsync("/tmp/mask.png");
    const transparentMask = await sharp("/tmp/mask.png")
      .threshold(128)
      .toColourspace('b-w')
      .png()
      .toBuffer();

    // 🎨 4. 3 Stile generieren via OpenAI
    const styles = [
      { name: "natural", prompt: "enhance photo naturally, clean and realistic" },
      { name: "schwarzweiß", prompt: "convert to stylish black and white photo" },
      { name: "neon", prompt: "apply neon glow, futuristic style" },
    ];

    const results = [];

    for (const style of styles) {
      const openaiRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          image: `data:image/png;base64,${buffer.toString('base64')}`,
          mask: `data:image/png;base64,${transparentMask.toString('base64')}`,
          prompt: `${style.prompt}${userText ? ` with text: "${userText}"` : ''}`,
          n: 1,
          size: "1024x1024",
          response_format: "url"
        }),
      });

      const openaiJson = await openaiRes.json();
      results.push({
        stil: style.name,
        url: openaiJson.data?.[0]?.url || null,
        datum: new Date().toISOString(),
        text: userText || ""
      });
    }

    return res.status(200).json({ images: results });

  } catch (error) {
    console.error("❌ Fehler in generate.js:", error);
    return res.status(500).json({ error: 'Interner Serverfehler' });
  }
}

// 🕒 Helfer: Ergebnis von Replicate abfragen
async function pollReplicateResult(id, attempts = 0) {
  if (attempts > 20) throw new Error("Replicate timeout");

  const res = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
    headers: {
      Authorization: `Token ${REPLICATE_API_TOKEN}`,
    },
  });
  const json = await res.json();

  if (json.status === "succeeded") {
    return json.output;
  } else if (json.status === "failed") {
    throw new Error("Replicate failed");
  } else {
    await new Promise(r => setTimeout(r, 1500));
    return pollReplicateResult(id, attempts + 1);
  }
}
