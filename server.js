const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PINATA_JWT = process.env.PINATA_JWT;

// data URL -> {mime, buffer}
function decodeDataUrl(dataUrl) {
  const m = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error("not a data URL");
  return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
}

app.post("/pin", async (req, res) => {
  try {
    if (!PINATA_JWT) return res.status(500).json({ error: "PINATA_JWT not set on server" });
    const { imageDataUrl, signature } = req.body || {};
    if (!imageDataUrl) return res.status(400).json({ error: "missing imageDataUrl" });

    // 1. pin the PNG itself
    const { buffer } = decodeDataUrl(imageDataUrl);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "image/png" }), "skwiggle-art.png");

    const imgRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: { Authorization: "Bearer " + PINATA_JWT },
      body: form
    });
    const imgJson = await imgRes.json();
    if (!imgRes.ok) return res.status(imgRes.status).json({ error: imgJson });
    const imageCid = imgJson.IpfsHash;

    // 2. build metadata, using the signature (the ordered action log) as NFT attributes
    const actions = (signature && signature.actions) || [];
    const metadata = {
      name: "Skwiggle Art " + Date.now(),
      description: "Generative line art made with skwiggle (skwiggle.vercel.app). The attributes below are the actual sequence of choices used to build this piece.",
      image: "ipfs://" + imageCid,
      attributes: actions.slice(0, 60).map((a, i) => ({ trait_type: "step " + (i + 1), value: a.label })),
      skwiggle_signature: signature || null
    };

    const metaRes = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + PINATA_JWT,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ pinataContent: metadata })
    });
    const metaJson = await metaRes.json();
    if (!metaRes.ok) return res.status(metaRes.status).json({ error: metaJson });
    const metaCid = metaJson.IpfsHash;

    res.json({ tokenURI: "ipfs://" + metaCid, imageCid, metaCid });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/", (req, res) => res.send("skwiggle mint-pin proxy is running"));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on " + port));
