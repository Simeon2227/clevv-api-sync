// netlify/functions/whatsapp_product_sync.js

// ====== ENV (set these in Netlify → Site settings → Environment) ======
const {
  META_VERIFY_TOKEN = "",
  WHATSAPP_TOKEN = "",
  WHATSAPP_PHONE_NUMBER_ID = "",
  SUPABASE_URL = "",
  SUPABASE_SERVICE_ROLE_KEY = "",
  OPENAI_API_KEY = "",
  // You created this bucket already:
  SUPABASE_BUCKET = "vendor_listing_images",
} = process.env;

const WA_API = `https://graph.facebook.com/v20.0/${WHATSAPP_PHONE_NUMBER_ID}`;
const ALLOWED_STATUSES = ["active", "inactive", "draft"];

// ====== Supabase REST helpers (no SDK to keep it light) ======
async function sbFetch(path, init = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const headers = {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
    ...(init.headers || {}),
  };
  return fetch(url, { ...init, headers });
}

async function sbUploadImage(filename, bytes, contentType) {
  const url = `${SUPABASE_URL}/storage/v1/object/${encodeURIComponent(
    SUPABASE_BUCKET
  )}/${encodeURIComponent(filename)}`;

  const res = await fetch(url, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": contentType,
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Supabase upload failed: ${await res.text()}`);

  // If bucket is public, this URL serves the file directly:
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${filename}`;
}

// ====== WhatsApp helpers ======
async function waSendText(toWaId, text) {
  try {
    const res = await fetch(`${WA_API}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: toWaId,
        type: "text",
        text: { preview_url: false, body: text },
      }),
    });
    if (!res.ok) console.error("WhatsApp send error:", await res.text());
  } catch (e) {
    console.error("WhatsApp send exception:", e);
  }
}

async function waGetMediaBytes(mediaId) {
  // 1) Fetch media URL
  const meta1 = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!meta1.ok) throw new Error(await meta1.text());
  const { url, mime_type } = await meta1.json();

  // 2) Download binary
  const bin = await fetch(url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!bin.ok) throw new Error(await bin.text());
  const buf = Buffer.from(await bin.arrayBuffer());
  return { bytes: buf, mime: mime_type || "application/octet-stream" };
}

// ====== Phone matching helpers ======
function normalizeMsisdn(input) {
  if (!input) return "";
  return String(input).replace(/\D/g, ""); // keep digits only
}

async function findProfileByWaId(waId) {
  const msisdn = normalizeMsisdn(waId);

  // Try digits-only column if you add it; also try raw field with/without '+'
  const url =
    `/profiles?select=user_id,whatsapp_number,whatsapp_msisdn` +
    `&or=(whatsapp_msisdn.eq.${msisdn},whatsapp_number.eq.+${msisdn},whatsapp_number.eq.${msisdn})` +
    `&limit=1`;

  const res = await sbFetch(url);
  if (!res.ok) throw new Error(await res.text());
  const rows = await res.json();
  return rows[0]; // { user_id, whatsapp_number, whatsapp_msisdn }
}

// ====== AI parsing (extracts title/price/category/tags...) ======
async function aiExtractProduct({ text, hasImages }) {
  const schema = {
    type: "object",
    properties: {
      title: { type: "string" },
      description: { type: "string" },
      price: { type: "number" },
      currency: { type: "string" },
      category: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      images: { type: "array", items: { type: "string" } },
      location: { type: "string" },
      status: { type: "string", enum: ALLOWED_STATUSES },
      external_id: { type: "string" },
    },
    required: ["title"],
    additionalProperties: false,
  };

  const body = {
    model: "gpt-4o-mini", // ok to change to gpt-3.5-turbo if you prefer
    response_format: { type: "json_schema", json_schema: { name: "Product", schema } },
    messages: [
      {
        role: "system",
        content:
          "Extract marketplace listing data. Do not invent prices. Return JSON only.",
      },
      {
        role: "user",
        content:
          `Text:\n${text}\n\nThere ${hasImages ? "ARE" : "ARE NO"} images attached. Infer category and tags if reasonable.`,
      },
    ],
  };

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await res.text());
    const json = await res.json();
    const content = json.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    if (parsed.status && !ALLOWED_STATUSES.includes(parsed.status)) delete parsed.status;
    return parsed;
  } catch (e) {
    console.error("AI parse error:", e);
    return { title: (text || "Untitled product").slice(0, 120) };
  }
}

// ====== Database upsert into vendor_listings ======
async function upsertListing(data) {
  const status =
    data.status && ALLOWED_STATUSES.includes(data.status) ? data.status : "active";

  const payload = {
    vendor_id: data.vendor_id,     // profiles.user_id
    external_id: data.external_id, // WA message id or provided
    title: data.title,
    description: data.description || null,
    price: data.price ?? null,
    currency: data.currency || null,
    category: data.category || null,
    tags: data.tags || [],
    images: data.images || [],
    location: data.location || null,
    source: "whatsapp",
    status,
    original_link: null,
  };

  const res = await sbFetch(`/vendor_listings`, {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { Prefer: "resolution=merge-duplicates" }, // needs unique index on external_id
  });

  if (!res.ok) throw new Error(await res.text());
  const [row] = await res.json();
  return row;
}

// ====== Netlify handler ======
export async function handler(event) {
  // --- Webhook verification (GET) ---
  if (event.httpMethod === "GET") {
    const params = new URLSearchParams(event.rawQuery || "");
    const mode = params.get("hub.mode");
    const token = params.get("hub.verify_token");
    const challenge = params.get("hub.challenge");
    if (mode === "subscribe" && token === META_VERIFY_TOKEN)
      return { statusCode: 200, body: challenge || "" };
    return { statusCode: 403, body: "Forbidden" };
  }

  if (event.httpMethod !== "POST")
    return { statusCode: 405, body: "Method Not Allowed" };

  const started = Date.now();
  const body = JSON.parse(event.body || "{}");

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messages = value?.messages || [];
  const contacts = value?.contacts || [];

  if (!messages.length) return { statusCode: 200, body: "No messages" };

  // Process first message
  const msg = messages[0];
  const waId = contacts?.[0]?.wa_id || msg.from; // sender's phone number (countrycode+number)
  const messageId = msg.id;

  // 1) Profile lookup by WhatsApp number
  let profile;
  try {
    profile = await findProfileByWaId(waId);
  } catch (e) {
    console.error("Profile lookup error:", e);
  }

  if (!profile) {
    await waSendText(
      waId,
      "👋 Your WhatsApp number isn’t linked to a Clevv vendor account yet.\n" +
        "Please log in and add your WhatsApp number in Profile → https://clevvai.org/vendor\n" +
        "Then send your product again."
    );
    return { statusCode: 200, body: "Profile not found" };
  }

  const vendorId = profile.user_id;

  // 2) Collect text parts
  const textParts = [];
  if (msg.text?.body) textParts.push(msg.text.body);
  if (msg.image?.caption) textParts.push(msg.image.caption);
  if (msg.document?.caption) textParts.push(msg.document.caption);

  // 3) If there’s an image, download + upload to Storage
  const imageUrls = [];
  if (msg.type === "image" && msg.image?.id) {
    try {
      const { bytes, mime } = await waGetMediaBytes(msg.image.id);
      const ext = (mime.split("/")[1] || "jpg").replace("+xml", "");
      const filename = `wa/${waId}/${messageId}.${ext}`;
      const publicUrl = await sbUploadImage(filename, bytes, mime);
      imageUrls.push(publicUrl);
    } catch (e) {
      console.error("Image pipeline failed:", e);
    }
  }

  // Quick ack if we’re running long
  if (Date.now() - started > 3000) {
    await waSendText(waId, "✅ Got your product. Processing now…");
  }

  // 4) AI extract
  const ai = await aiExtractProduct({
    text: textParts.join("\n").trim(),
    hasImages: imageUrls.length > 0,
  });

  const title = (ai.title || "Untitled product").slice(0, 200);
  const status =
    ai.status && ALLOWED_STATUSES.includes(ai.status) ? ai.status : "active";
  const images = Array.from(new Set([...(ai.images || []), ...imageUrls]));

  // 5) Insert/Upsert
  const inserted = await upsertListing({
    vendor_id: vendorId,
    external_id: ai.external_id || messageId, // idempotent per WA message
    title,
    description: ai.description,
    price: ai.price,
    currency: ai.currency || "NGN",
    category: ai.category,
    tags: ai.tags,
    images,
    location: ai.location,
    status,
  });

  // 6) Confirm to vendor
  await waSendText(
    waId,
    `✅ Your product “${title}” has been added to your Clevv catalog and is now discoverable.\nID: ${
      inserted?.id ?? inserted?.external_id
    }`
  );

  return { statusCode: 200, body: "OK" };
}
