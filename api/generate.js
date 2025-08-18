// api/generate.js
export const config = { runtime: "edge" };
const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET || "";

function promptsFor(style) {
  const map = {
    natural: "photo-realistic pet portrait, natural colors, subtle retouch, clean soft lighting, high detail",
    bw: "photorealistic black and white pet portrait, soft contrast, fine details, film look",
    neon: "photorealistic pet with vivid neon rim lights (magenta, cyan, orange), crisp details, glowing accents"
  };
  return map[style] || map.natural;
}

async function replicateImg2Img(imageUrl, prompt) {
  const modelVersion = "stability-ai/sdxl-img2img"; // replace with valid version slug
  const create = await fetch("https://api.replicate.com/v1/predictions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Token ${REPLICATE_TOKEN}`
    },
    body: JSON.stringify({
      version: modelVersion,
      input: { image: imageUrl, prompt, strength: 0.4, guidance_scale: 7 }
    })
  });
  if (!create.ok) throw new Error("Replicate create failed: " + (await create.text()));
  const job = await create.json();
  let outUrl = null;
  for (let i=0;i<60;i++) {
    await new Promise(r=>setTimeout(r, 2500));
    const s = await fetch(`https://api.replicate.com/v1/predictions/${job.id}`, {
      headers: { "Authorization": `Token ${REPLICATE_TOKEN}` }
    });
    if (!s.ok) throw new Error("Replicate poll failed: " + (await s.text()));
    const data = await s.json();
    if (data.status === "succeeded") {
      outUrl = Array.isArray(data.output) ? data.output[0] : data.output;
      break;
    }
    if (data.status === "failed" || data.status === "canceled") throw new Error("Generation failed");
  }
  if (!outUrl) throw new Error("Timeout waiting for Replicate");
  return outUrl;
}

export default async function handler(req) {
  try {
    if (req.method !== "POST") return new Response(JSON.stringify({ ok:false, error:"POST only" }), { status: 405 });
    const body = await req.json();
    const { order_id, item_id, image_url, styles = ["natural","bw","neon"], callback, secret } = body || {};
    if (!order_id || !item_id || !image_url || !callback) return new Response(JSON.stringify({ ok:false, error:"Missing fields" }), { status: 400 });
    if (CALLBACK_SECRET && secret !== CALLBACK_SECRET) return new Response(JSON.stringify({ ok:false, error:"Bad secret" }), { status: 403 });

    let previews = [];
    if (!REPLICATE_TOKEN) {
      previews = styles.map(() => image_url); // MOCK mode
    } else {
      for (const s of styles) {
        const url = await replicateImg2Img(image_url, promptsFor(s));
        previews.push(url);
      }
    }

    const cb = await fetch(callback, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ order_id, item_id, previews, secret })
    });
    if (!cb.ok) return new Response(JSON.stringify({ ok:false, error:"Callback failed: " + (await cb.text()) }), { status: 502 });

    return new Response(JSON.stringify({ ok:true, previews }), { status: 200 });
  } catch (e) {
    return new Response(JSON.stringify({ ok:false, error: String(e) }), { status: 500 });
  }
}
