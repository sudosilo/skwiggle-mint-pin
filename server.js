// RED PHONE: skwiggle-mint-pin proxy, mint-debug session.
// RED PHONE: this rewrite exists to make the /pin failure VISIBLE instead of blind.
// RED PHONE: three changes over the prior version:
// RED PHONE:   1. dual Pinata auth. a real JWT uses Bearer; a key+secret uses the legacy header pair.
// RED PHONE:      it auto-picks based on what env vars are actually set, so a credential pasted into the
// RED PHONE:      wrong field is far less likely to silently 401 the whole pipeline.
// RED PHONE:   2. every Pinata failure now logs its real status and body to the Railway deploy logs
// RED PHONE:      (console.error), so the cause shows up server-side even if the browser panel misbehaves.
// RED PHONE:   3. a GET /health route calls Pinata's own testAuthentication endpoint and returns the raw
// RED PHONE:      result as plain JSON. open it in Firefox to confirm the credential with no mint, no wallet,
// RED PHONE:      no image, no app. this is the one-tap credential test the last session never had.

const express = require("express");
const cors = require("cors");
const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

// RED PHONE: accept either scheme. JWT wins if present and JWT-shaped; else fall back to key+secret.
const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_API_KEY = process.env.PINATA_API_KEY;
const PINATA_API_SECRET = process.env.PINATA_API_SECRET;

// RED PHONE: a genuine Pinata JWT is a dot-delimited base64 token that starts with eyJ. anything else in
// RED PHONE: the JWT slot (an API key, a key:secret paste) is treated as NOT a usable Bearer token, so we
// RED PHONE: don't blindly send garbage as Bearer and get an opaque 401.
function looksLikeJwt(s) {
  return typeof s === "string" && s.startsWith("eyJ") && s.split(".").length === 3;
}

// RED PHONE: returns { headers, scheme } or null if no credential is usable at all.
function pinataAuth() {
  if (looksLikeJwt(PINATA_JWT)) {
    return { headers: { Authorization: "Bearer " + PINATA_JWT }, scheme: "jwt" };
  }
  if (PINATA_API_KEY && PINATA_API_SECRET) {
    return {
      headers: { pinata_api_key: PINATA_API_KEY, pinata_secret_api_key: PINATA_API_SECRET },
      scheme: "key+secret"
    };
  }
  // RED PHONE: last resort. if someone set PINATA_JWT to a non-JWT string, try it as Bearer anyway so the
  // RED PHONE: /health route surfaces Pinata's real complaint rather than us refusing to call at all.
  if (PINATA_JWT) {
    return { headers: { Authorization: "Bearer " + PINATA_JWT }, scheme: "jwt-unverified-shape" };
  }
  return null;
}

// data URL -> { mime, buffer }
function decodeDataUrl(dataUrl) {
  const m = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!m) throw new Error("not a data URL");
  return { mime: m[1], buffer: Buffer.from(m[2], "base64") };
}

// RED PHONE: open skwiglemint-production.up.railway.app/health in Firefox after deploy. a green ok:true here
// RED PHONE: means the credential works and any remaining mint failure is downstream (payload, plan limits).
// RED PHONE: an ok:false here IS the whole bug, and the pinata field tells you exactly why.
app.get("/health", async (req, res) => {
  const auth = pinataAuth();
  if (!auth) {
    return res.status(500).json({
      ok: false,
      reason: "no Pinata credential found",
      looked_for: ["PINATA_JWT (must start with eyJ and have two dots)", "PINATA_API_KEY + PINATA_API_SECRET"]
    });
  }
  try {
    const r = await fetch("https://api.pinata.cloud/data/testAuthentication", {
      method: "GET",
      headers: auth.headers
    });
    let body;
    try { body = await r.json(); } catch (_) { body = await r.text(); }
    if (!r.ok) console.error("[health] pinata auth failed", r.status, body);
    return res.status(r.ok ? 200 : r.status).json({
      ok: r.ok,
      auth_scheme: auth.scheme,
      pinata_status: r.status,
      pinata: body
    });
  } catch (e) {
    console.error("[health] request threw", e);
    return res.status(500).json({ ok: false, auth_scheme: auth.scheme, error: String(e) });
  }
});

app.post("/pin", async (req, res) => {
  try {
    const auth = pinataAuth();
    if (!auth) return res.status(500).json({ error: "no Pinata credential set on server (need PINATA_JWT, or PINATA_API_KEY + PINATA_API_SECRET)" });

    const { imageDataUrl, signature } = req.body || {};
    if (!imageDataUrl) return res.status(400).json({ error: "missing imageDataUrl" });

    // 1. pin the PNG itself
    const { buffer } = decodeDataUrl(imageDataUrl);
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: "image/png" }), "skwiggle-art.png");

    const imgRes = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
      method: "POST",
      headers: auth.headers, // RED PHONE: no Content-Type here; fetch sets the multipart boundary from FormData
      body: form
    });
    const imgJson = await imgRes.json();
    if (!imgRes.ok) {
      // RED PHONE: this line is the point. the real reason now lands in Railway's logs, always.
      console.error("[pin] pinFileToIPFS failed", imgRes.status, "scheme=" + auth.scheme, imgJson);
      return res.status(imgRes.status).json({ error: imgJson });
    }
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
      headers: Object.assign({ "Content-Type": "application/json" }, auth.headers),
      body: JSON.stringify({ pinataContent: metadata })
    });
    const metaJson = await metaRes.json();
    if (!metaRes.ok) {
      console.error("[pin] pinJSONToIPFS failed", metaRes.status, "scheme=" + auth.scheme, metaJson);
      return res.status(metaRes.status).json({ error: metaJson });
    }
    const metaCid = metaJson.IpfsHash;

    res.json({ tokenURI: "ipfs://" + metaCid, imageCid, metaCid });
  } catch (e) {
    console.error("[pin] handler threw", e);
    res.status(500).json({ error: String(e) });
  }
});

app.get("/", (req, res) => res.send("skwiggle mint-pin proxy is running. try /health to test the Pinata credential."));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log("listening on " + port));
