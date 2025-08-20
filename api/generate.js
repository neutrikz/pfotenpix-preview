// /api/generate.js – Vercel Serverless Function für PfotenPix mit automatischer Maskenerstellung

export const config = { api: { bodyParser: false } };

// Body als JSON lesen
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

// Bild von URL laden
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

// Prompt-Generator
function buildPrompt(style) {
  const basePrompt = {
    "natürlich": "Erzeuge eine fotorealistische, natürliche Farbversion dieses Haustierfotos. Die Fellstruktur, Augen und Details sollen scharf und realitätsgetreu erscheinen. Keine künstlerische Verfremdung.",
    "schwarzweiß": "Erzeuge eine elegante Schwarz-Weiß-Version des Fotos. Erhalte alle Details des Tieres mit hohem Dynamikumfang und fein abgestuften Grautönen.",
    "neon": "Erzeuge eine stilisierte Version dieses Haustierfotos mit Neon-Optik im Pop-Art-Stil. Leuchtende, bunte Akzente umrahmen das Tier, ohne es zu verfälschen."
  };
  return basePrompt[style] || "Erzeuge eine fotorealistische Version.";
}

// Maske über Replicate generieren
async function getMaskFromReplicate(imageUrl) {
  const replicateRes = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.REPLICATE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
     version: "6f8a54ae8a4f9c42c5798b26efb26c55c95c9e2c010f74b3279c25baf92d8930", // neue Version prüfen
      input: { image: imageUrl }
    })
  });

  const replicateData = await replicateRes.json();

  if (!replicateData || !replicateData.urls || !replicateData.urls.get) {
    console.error("❌ Replicate API-Fehler: Antwort unvollständig:", replicateData);
    throw new Error("Ungültige Antwort von Replicate API – keine Status-URL.");
  }

  const statusUrl = replicateData.urls.get;

  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 2000));
    const poll = await fetch(statusUrl, {
      headers: { Authorization: `Token ${process.env.REPLICATE_API_TOKEN}` }
    });
    const pollData = await poll.json();
    if (pollData.status === "succeeded") {
      return pollData.output;
    } else if (pollData.status === "failed") {
      throw new Error("Maskenerstellung via Replicate fehlgeschlagen.");
    }
  }

  throw new Error("Maskenerstellung Timeout nach 60 Sekunden.");
}


export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const secret = req.headers["x-pfpx-secret"];
    if (!secret || secret !== process.env.PFPX_SECRET) {
      return res.status(401).json({ error: "Unauthorized: Invalid Secret" });
    }

    const body = await readJson(req);
    const imageUrl = body.image_url;
    const styles = Array.isArray(body.styles) && body.styles.length
      ? body.styles
      : ["natürlich", "schwarzweiß", "neon"];

    if (!imageUrl) {
      return res.status(400).json({ error: "Missing image_url" });
    }

    // Masken-URL generieren
    const maskUrl = await getMaskFromReplicate(imageUrl);
    if (!maskUrl) throw new Error("Keine Maske generiert.");

    // Originalbild & Maske laden
    const imgBuf  = Buffer.from(await fetchArrayBuffer(imageUrl));
    const maskBuf = Buffer.from(await fetchArrayBuffer(maskUrl));
    const imgName = imageUrl.split("/").pop()?.split("?")[0] || "upload.png";

    // Varianten erzeugen
    const previews = {};
    for (const style of styles) {
      const prompt = buildPrompt(style);
      const form = new FormData();
      form.append("model", "gpt-image-1");
      form.append("prompt", prompt);
      form.append("image", new Blob([imgBuf]), imgName);
      form.append("mask", new Blob([maskBuf]), "mask.png");
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
        const errText = await response.text();
        console.error("OpenAI Error:", errText);
        throw new Error(`OpenAI Fehler (${response.status})`);
      }

      const result = await response.json();
      const url = result?.data?.[0]?.url;
      if (!url) throw new Error("Keine Bild-URL von OpenAI zurückgegeben.");
      previews[style] = url;
    }

    return res.status(200).json({ previews });

  } catch (err) {
    console.error("❌ Fehler bei der Generierung:", err.message || err);
    return res.status(500).json({ error: "Generation failed", detail: err.message || err });
  }
}
