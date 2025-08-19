// /api/generate.js — Vercel Serverless Function (Node 18+)

export const config = { api: { bodyParser: false } }; // nur für Next.js-ähnliche Umgebungen, stört sonst nicht

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function fetchArrayBuffer(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`fetch ${r.status}`);
    return await r.arrayBuffer();
  } finally {
    clearTimeout(t);
  }
}

function buildPrompt(style) {
  switch (style) {
    case "natürlich":
      return "Erzeuge eine fotorealistische, natürliche Farbversion. Scharf, detailreich, ohne künstlerische Verfremdung.";
    case "schwarzweiß":
      return "Erzeuge eine elegante, hochwertige Schwarz-Weiß-Version. Hoher Dynamikumfang, fein abgestufte Kontraste, edler Look.";
    case "neon":
      return "Erzeuge eine fotorealistische Version mit lebendiger Neon-Optik: leuchtende farbige Highlights, moderner Pop-Art Flair, aber Motiv bleibt klar erkennbar.";
    default:
      return "Erzeuge eine fotorealistische, klare Version.";
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Only POST allowed" });
  }

  try {
    // Auth vom WordPress-Server
    const secret = req.headers["x-pfpx-secret"];
    if (!secret || secret !== process.env.PFPX_SECRET) {
      return res.status(401).json({ error: "Bad secret" });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ error: "Missing OPENAI_API_KEY" });
    }

    // Body lesen
    const body = await readJson(req);
    const imageUrl = body.image_url;
    const styles = Array.isArray(body.styles) && body.styles.length
      ? body.styles
      : ["natürlich", "schwarzweiß", "neon"];

    if (!imageUrl) {
      return res.status(400).json({ error: "image_url missing" });
    }

    // Kundenbild vom WP-Upload holen
    const imgBuf = Buffer.from(await fetchArrayBuffer(imageUrl));
    const imgName = imageUrl.split("/").pop()?.split("?")[0] || "upload.png";

    // Ein Edit pro Stil erstellen (seriell = zuverlässiger bzgl. Limits)
    async function makeEdit(style) {
      const prompt = buildPrompt(style);

      const form = new FormData();
      form.append("model", "gpt-image-1");
      form.append("prompt", prompt);
      form.append("image", new Blob([imgBuf]), imgName); // image-to-image
      form.append("size", "512x512");
      form.append("n", "1");
      form.append("response_format", "url");

      const resp = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
        body: form,
      });

      if (!resp.ok) {
        const txt = await resp.text();
        throw new Error(`OpenAI error ${resp.status}: ${txt}`);
      }
      const json = await resp.json();
      const url = json?.data?.[0]?.url;
      if (!url) throw new Error("No URL returned from OpenAI");
      return url;
    }

    const previews = {};
    for (const style of styles) {
      previews[style] = await makeEdit(style);
    }

    return res.status(200).json({ previews });
  } catch (err) {
    console.error("generate error:", err);
    return res.status(500).json({ error: "Generation failed" });
  }
}
