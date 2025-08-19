export default function handler(req, res) {
  const secret = req.headers["x-pfpx-secret"];
  if (!secret || secret !== process.env.PFPX_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  return res.status(200).json({ result: "pong" });
}
