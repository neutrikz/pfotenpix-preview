// /api/generate.js – mit RemBG-Modell
import fetch from 'node-fetch';
import sharp from 'sharp';
import Jimp from 'jimp';

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
    // 🖼️ 1. Bild dekodieren
    const buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ""), 'base64');

    // 🎭 2. Hintergrund entfernen mit RemBG (Replicate)
    const replicateRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '7ed7f24468c2f47bbf4ed5e4b24ac01b78a24f1e1a9263001f21c83c0e3c8b4d', // RemBG v1.4.1
        input: {
          image: `data:image/png;base64,${buffer.toString('base64')}`,
          alpha_matting: true
        },
      }),
    });

    const replicateJson = await replicateRes.json();
    const outputUrl = await pollReplicateResult(replicateJson.id);
    const rembgBuffer = await fetch(outputUrl).then(r => r.arrayBuffer());

    // 🪄 3. Maske aus dem Alphakanal erzeugen
    const image = await Jimp.read(Buffer.from(rembgBuffer));
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
      const alpha = this.bitmap.data[idx + 3];
      this.bitmap.data[idx + 0] = alpha;
      this.bitmap.data[idx + 1] = alpha;
      this.bitmap.data[idx + 2] = alpha;
    });
    image.greyscale().contrast(1.0);
    await image.writeAsync('/tmp/mask.png');

    const maskBuffer = await sharp('/tmp/mask.png')
      .threshold(128)
      .png()
      .toBuffer();

    // 🎨 4. OpenAI Variationen erzeugen
    const styles = [
      { name: "natural", prompt: "enhance photo naturally, clean and realistic" },
      { name: "schwarzweiß", prompt: "convert to black and white stylish photo" },
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
          image: `data:image/png;base64,${Buffer.from(rembgBuffer).toString('base64')}`,
          mask: `data:image/png;base64,${maskBuffer.toString('base64')}`,
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

  } catch (err) {
    console.error("❌ Fehler in generate.js:", err);
    return res.status(500).json({ error: 'Interner Serverfehler' });
  }
}

// ⏳ Wartefunktion für Replicate
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
