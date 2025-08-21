// /api/generate-fix.js – Full-Mask Style Transfer + harte Identitäts-Guidance + Retries + offene CORS
import sharp from "sharp";
import { FormData, File } from "formdata-node";

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const config = { api: { bodyParser: false } };

function applyCORS(req,res){
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
}

async function readRawBody(req){ const chunks=[]; for await (const ch of req) chunks.push(ch); return Buffer.concat(chunks); }

function parseMultipart(buffer,boundary){
  const CRLF="\r\n", delim=`--${boundary}`, closeDelim=`--${boundary}--`;
  const body=buffer.toString("binary"); const parts=body.split(delim).filter(p=>p && p!=="--" && p!==closeDelim);
  const fields={}, files={};
  for (let rawPart of parts){
    if (rawPart.startsWith(CRLF)) rawPart=rawPart.slice(CRLF.length);
    const sep=CRLF+CRLF, idx=rawPart.indexOf(sep); if (idx===-1) continue;
    const rawHeaders=rawPart.slice(0,idx); let rawContent=rawPart.slice(idx+sep.length);
    if (rawContent.endsWith(CRLF)) rawContent=rawContent.slice(0,-CRLF.length);
    const headers={}; for(const line of rawHeaders.split(CRLF)){ const j=line.indexOf(":"); if(j>-1) headers[line.slice(0,j).trim().toLowerCase()]=line.slice(j+1).trim(); }
    const cd=headers["content-disposition"]||""; const name=(cd.match(/name="([^"]+)"/i)||[])[1]; const filename=(cd.match(/filename="([^"]+)"/i)||[])[1];
    const ctype=headers["content-type"]||"";
    if(!name) continue;
    if(filename){ files[name]={ filename, contentType:ctype||"application/octet-stream", buffer:Buffer.from(rawContent,"binary") }; }
    else { fields[name]=Buffer.from(rawContent,"binary").toString("utf8"); }
  }
  return { fields, files };
}

const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const withJitter=(ms)=>Math.round(ms*(0.85+Math.random()*0.3));
async function fetchOpenAIWithRetry(form, styleName, {retries=3, baseDelayMs=900}={}){
  let last=null;
  for(let i=1;i<=retries;i++){
    try{
      console.log(`🟦 [${styleName}] OpenAI Versuch ${i}/${retries}`);
      const resp=await fetch("https://api.openai.com/v1/images/edits",{ method:"POST", headers:{ Authorization:`Bearer ${OPENAI_API_KEY}`, ...form.headers }, body:form });
      const reqId=resp.headers?.get?.("x-request-id")||resp.headers?.get?.("x-requestid")||"";
      const txt=await resp.text(); let json; try{ json=JSON.parse(txt);}catch{ json=null; }
      if(resp.ok && json?.data?.[0]?.url){ console.log(`🟩 [${styleName}] Erfolg${reqId?` – reqId: ${reqId}`:''}`); return json.data[0].url; }
      const is5xx=resp.status>=500; const serverErr=json?.error?.type==="server_error";
      console.warn(`🟨 [${styleName}] Fehler`,{status:resp.status, body:json||txt});
      if(!(is5xx||serverErr) || i===retries){ last=new Error(json?.error?.message||`HTTP ${resp.status}`); break; }
      const d=withJitter(baseDelayMs*Math.pow(2,i-1)); console.log(`⏳ Retry in ${d}ms …`); await sleep(d);
    }catch(e){ last=e; if(i===retries) break; const d=withJitter(baseDelayMs*Math.pow(2,i-1)); console.log(`⏳ Retry in ${d}ms …`); await sleep(d); }
  }
  throw last||new Error("OpenAI fehlgeschlagen");
}

export default async function handler(req,res){
  applyCORS(req,res);
  if(req.method==="OPTIONS") return res.status(204).end();
  if(req.method!=="POST")    return res.status(405).end();

  try{
    const ctype=(req.headers["content-type"]||"").toLowerCase();
    let sourceBuffer=null, userText="";
    if(ctype.startsWith("multipart/form-data")){
      const m=/boundary=([^;]+)/i.exec(ctype); if(!m) return res.status(400).json({error:"Bad multipart (no boundary)"});
      const {fields,files}=parseMultipart(await readRawBody(req), m[1]);
      const f=files["file"]; if(!f?.buffer) return res.status(400).json({error:"No file uploaded"});
      sourceBuffer=f.buffer; userText=(fields["custom_text"]||fields["text"]||"").toString();
    } else if (ctype.includes("application/json")){
      const body=JSON.parse((await readRawBody(req)).toString("utf8")||"{}");
      const b64=(body.imageData||"").replace(/^data:image\/\w+;base64,/,""); if(!b64) return res.status(400).json({error:"Kein Bild empfangen."});
      sourceBuffer=Buffer.from(b64,"base64"); userText=body.userText||"";
    } else return res.status(415).json({error:"Unsupported Content-Type"});

    const SIZE=1024;
    const inputPng=await sharp(sourceBuffer).resize(SIZE,SIZE,{fit:"contain",background:{r:0,g:0,b:0,alpha:0}}).png().toBuffer();

    // Full-mask: erlaubt Stiltransfer über die ganze Fläche, ohne kostenpflichtige Segmentierung
    const fullMaskPng=await sharp({ create:{ width:SIZE, height:SIZE, channels:4, background:{ r:0,g:0,b:0, alpha:0 } } }).png().toBuffer();

    // ✨ Identitäts-Guidance
    const guardrails = [
      "This is a photograph of a specific real pet. Keep the same species, breed characteristics, unique markings, proportions and pose.",
      "Do NOT invent new animals or change anatomy. Do NOT change ear shape, muzzle length, or eye size; avoid cartoon eyes.",
      "Maintain the original facial structure and silhouette; enhance style, color and lighting only.",
      "Background should remain clean and unobtrusive; no new props or scenery.",
      "High-resolution, artifact-free rendering suitable for fine-art printing."
    ].join(" ");

    const promptNatural = [
      "High-end studio portrait retouch of the pet: realistic, premium, magazine quality.",
      "Soft diffused key light with subtle rim light; refined micro-contrast in fur; gentle color grading.",
      "Elegant neutral backdrop with slight falloff; no HDR look; no over-smoothing.",
      guardrails,
      userText ? `Integrate this text subtly if present: "${userText}".` : ""
    ].join(" ");

    const promptBW = [
      "Fine-art black and white conversion of the existing photo (true grayscale).",
      "Deep blacks, controlled highlights, rich midtones; silver-gelatin print character; delicate film grain.",
      "Crisp detail in whiskers and eyes; dramatic directional lighting.",
      guardrails,
      userText ? `If text is provided, render it small and tasteful in monochrome: "${userText}".` : ""
    ].join(" ");

    const promptNeon = [
      "Neon pop-art style OVERLAY while preserving the exact pet identity, silhouette and face.",
      "Cyan/magenta/orange rim-light strokes that follow the fur contours; smooth neon gradients with gentle halation.",
      "Dark indigo-to-violet background vignette; subject remains clearly recognizable; no cartoonification; keep eye size natural.",
      "Do NOT change species or breed; do NOT redraw anatomy; this is a stylized color/lighting treatment.",
      guardrails,
      userText ? `Add matching neon typography for: "${userText}".` : ""
    ].join(" ");

    const styles = [
      { name:"natural",     prompt: promptNatural },
      { name:"schwarzweiß", prompt: promptBW },
      { name:"neon",        prompt: promptNeon },
    ];

    const previews={};
    for(const style of styles){
      const form=new FormData();
      form.set("image", new File([inputPng], "image.png", { type:"image/png" }));
      form.set("mask",  new File([fullMaskPng], "mask.png",   { type:"image/png" })); // ganze Fläche editierbar
      form.set("prompt", style.prompt);
      form.set("n", "1");
      form.set("size", "1024x1024");
      form.set("response_format", "url");
      previews[style.name] = await fetchOpenAIWithRetry(form, style.name, { retries:3, baseDelayMs:900 });
    }

    return res.status(200).json({ success:true, previews });
  } catch(err){
    console.error("generate-fix.js error:", err);
    return res.status(500).json({ error:"Interner Serverfehler" });
  }
}
