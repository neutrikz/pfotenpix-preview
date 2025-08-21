// /api/generate-fix.js – finale Version mit formdata-node & createFile
import sharp from 'sharp';
import Jimp from 'jimp';
import { FormData } from 'formdata-node';
import { createFile } from 'formdata-node/file-from-path';

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
  console.log("✅ generate-fix.js gestartet");

  if (req.method !== 'POST') return res.status(405).end();
  if (req.headers['x-pfpx-secret'] !== PFPX_SECRET) {
    console.warn("❌ Sicherheits-Token falsch oder fehlt");
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { imageData, userText } = req.body;

  if (!imageData) {
    console.warn("❌ Kein Bild erhalten");
    return res.status(400).json({ error: 'Kein Bild empfangen.' });
  }

  try {
    console.log("📥 Bild empfangen, beginne Verarbeitung");
    const buffer = Buffer.from(imageData.replace(/^data:image\/\w+;base64,/, ""), 'base64');

    // ➤ RemBG API aufrufen
    console.log("🎭 Rufe RemBG-API auf");
    const replicateRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: 'fb8af171cfa1616ddcf1242c093f9c46bcada5ad4cf6f2fbe8b81b330ec5c003',
        input: {
          image: `data:image/png;base64,${buffer.toString('base64')}`,
          alpha_matting: true,
        },
      }),
    });

    const replicateJson = await replicateRes.json();
    if (!replicateJson.id) {
      console.error("❌ RemBG-Rückgabe ungültig", replicateJson);
      return res.status(500).json({ error: 'Fehler bei RemBG (ID fehlt)' });
    }

    console.log("🕒 Warte auf RemBG-Output");
    const outputUrl = await pollReplicateResult(replicateJson.id);
    console.log("📤 Maske von RemBG erhalten:", outputUrl);

    const rembgBuffer = await fetch(outputUrl).then(r => r.arrayBuffer());

    // ➤ Maske bearbeiten mit Jimp
    console.log("🖼️ Maske verarbeiten mit Jimp");
    const image = await Jimp.read(Buffer.from(rembgBuffer));
    image.scan(0, 0, image.bitmap.width, image.bitmap.height, function (x, y, idx) {
      const alpha = this.bitmap.data[idx + 3];
      this.bitmap.data[idx + 0] = alpha;
      this.bitmap.data[idx + 1] = alpha;
      this.bitmap.data[idx + 2] = alpha;
    });
    image.greyscale().contrast(1.0);

    const resizedImage = image.clone().resize(1024, 1024);
    await resizedImage.writeAsync('/tmp/mask.png');

    const maskBuffer = await sharp('/tmp/mask.png')
      .threshold(128)
      .png()
      .toBuffer();

    const resizedOriginalBuffer = await sharp(buffer).resize(1024, 1024).png().toBuffer();
    await sharp(resizedOriginalBuffer).toFile('/tmp/image.png');

    const styles = [
      { name: "natural", prompt: "enhance photo naturally, clean and realistic" },
      { name: "schwarzweiß", prompt: "convert to black and white stylish photo" },
      { name: "neon", prompt: "apply neon glow, futuristic style" },
    ];

    const results = [];

    for (const style of styles) {
      console.log(`🎨 Sende an OpenAI (Stil: ${style.name})`);

      const form = new FormData();
      form.set("image", await createFile('/tmp/image.png'));
      form.set("mask", await createFile('/tmp/mask.png'));
      form.set("prompt", `${style.prompt}${userText ? ` with text: "${userText}"` : ''}`);
      form.set("n", "1");
      form.set("size", "1024x1024");
      form.set("response_format", "url");

      const openaiRes = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...form.headers,
        },
        body: form,
      });

      const openaiJson = await openaiRes.json();

      if (!openaiJson?.data?.[0]?.url) {
        console.error(`❌ OpenAI-Fehler bei Stil '${style.name}':`, openaiJson);
        return res.status(500).json({ error: `OpenAI konnte den Stil '${style.name}' nicht generieren.` });
      }

      results.push({
        stil: style.name,
        url: openaiJson.data[0].url,
        datum: new Date().toISOString(),
        text: userText || ""
      });

      console.log(`✅ Stil '${style.name}' erfolgreich generiert`);
    }

    console.log("✅ Alle Varianten generiert");
    return res.status(200).json({ images: results });

  } catch (err) {
    console.error("❌ Unerwarteter Fehler in generate-fix.js:", err);
    return res.status(500).json({ error: 'Interner Serverfehler' });
  }
}

// ⏳ Helper
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
