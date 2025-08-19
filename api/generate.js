// /api/generate.js – Vercel Serverless Function für PfotenPix

export const config = { api: { bodyParser: false } }; // Vercel-kompatibel

// Body als JSON lesen (für Raw POST)
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

// Prompt-Generator pro Stil
function buildPrompt(style) {
  switch (style) {
    case "natürlich":
      return "Erzeuge eine fotorealistische, natürliche Farbversion dieses Haustierfotos. Die Fellstruktur, Augen und Details sollen scharf und realitätsgetreu erscheinen. Keine künstlerische Verfremdung. Der Hintergrund kann weich gezeichnet sein, aber das Tier bleibt zentriert und unverändert.";
    case "schwarzweiß":
      return "Erzeuge eine elegante Schwarz-Weiß-Version des Fotos. Erhalte alle Details des Tieres, mit hohem Dynamikumfang und fein abgestuften Grautönen. Keine künstlerischen Filter oder übertriebene Kontraste. Das Tier bleibt naturgetreu und klar erkennbar.";
    case "neon":
      return "Erzeuge eine stilisierte Version dieses Haustierfotos mit Neon-Optik im Pop-Art-Stil. Leuchtende, bunte Akzente umrahmen das Tier, ohne es zu verfälschen. Der Hintergrund darf modern und kontrastreich sein – z. B. Neonraster, Farbverlauf oder Lichtlinien – aber das Tier bleibt realistisch und im Zentrum des Bildes.";
    default:
      return "Erzeuge eine fotorealistische, klare Version.";
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    const secret = req.headers["x-pfpx-secret"];
    console.log("🔒 Eingehendes Secret:", secret);
    console.log("🔐 Vercel ENV Secret:", process.env.PFPX_SECRET);

    if (!secret || secret !== process.env.PFPX_SECRET) {
      return res.status(401).json({ error: "Unauthorized: Invalid Secret" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // 📥 JSON-Body lesen
    const body = await readJson(req);
    const imageUrl = body.image_url;
    const styles = Array.isArray(body.styles) && body.styles.length
      ? body.styles
      : ["natürlich", "schwarzweiß", "neon"];

    if (!imageUrl) {
      return res.status(400).json({ error: "Missing image_url" });
    }

    // 📸 Bild abrufen & umwandeln
    const imgBuf = Buffer.from(await fetchArrayBuffer(imageUrl));
    const imgName = imageUrl.split("/").pop()?.split("?")[0] || "upload.png";

    // 🔁 Bearbeitung für jeden Stil
    async function makeEdit(style) {
      const prompt = buildPrompt(style);

      const form = new FormData();
      form.append("model", "gpt-image-1");
      form.append("prompt", prompt);
      form.append("image", new Blob([imgBuf]), imgName);
      form.append("size", "1024x1024"); // ✅ Gültige Größe
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
        console.error("OpenAI Error Response:", errorText);
        throw new Error(`OpenAI API Error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      const url = result?.data?.[0]?.url;
      if (!url) throw new Error("No URL returned from OpenAI.");
      return url;
    }

    // 🔄 Alle Varianten generieren
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
