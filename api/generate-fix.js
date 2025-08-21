// /api/generate-fix.js – Debug-Version
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

    console.log("🎭 Rufe RemBG-API auf");
    const replicateRes = await fetch('https://api.replicate.com/v1/predictions', {
      method: 'POST',
      headers: {
        Authorization: `Token ${REPLICATE_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        version: '7ed7f24468c2f47bbf4ed5e4b24ac01b78a24f1e1a9263001f21c83c0e3c8b4d',
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

    console.log("🖼️ Maske verarbeiten mit Jimp");
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

    const styles = [
      { name: "natural", prompt: "enhance photo naturally, clean and realistic" },
      { name: "schwarzweiß", prompt: "convert to black and white stylish photo" },
      { name: "neon", prompt: "apply neon glow, futuristic style" },
    ];

    const results = [];

    for (const style of styles) {
      console.log(`🎨 Sende an OpenAI (Stil: ${style.name})`);

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
