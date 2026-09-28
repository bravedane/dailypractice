// Vercel serverless function — handles the "weekly email" subscribe box
// on the Your Daily Practice result screen.
//
// Keeps the Kit (ConvertKit) API key server-side only. The browser never
// sees it — it posts { email } here, this function does the Kit calls.
//
// Requires an environment variable set in the Vercel project:
//   KIT_API_KEY = <Kit v4 API key>
//
// Tags every subscriber with "Daily Practice Tool - Subscriber" (id 24069623)
// — a tag created specifically for this tool, kept separate from the
// existing MWOD funnel tags so it doesn't feed into any live sequence
// without a deliberate decision to route it there.

const KIT_BASE_URL = "https://api.kit.com/v4";
const DAILY_PRACTICE_TAG_ID = 24069623; // "Daily Practice Tool - Subscriber"

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

async function kitFetch(path, apiKey, options = {}) {
  const res = await fetch(`${KIT_BASE_URL}/${path.replace(/^\//, "")}`, {
    ...options,
    headers: {
      "X-Kit-Api-Key": apiKey,
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers || {}),
    },
  });
  let body = null;
  try {
    body = await res.json();
  } catch (e) {
    body = null;
  }
  return { ok: res.ok, status: res.status, body };
}

async function findSubscriber(email, apiKey) {
  const { ok, body } = await kitFetch(
    `subscribers?email_address=${encodeURIComponent(email)}`,
    apiKey,
    { method: "GET" }
  );
  if (!ok || !body || !Array.isArray(body.subscribers) || body.subscribers.length === 0) {
    return null;
  }
  return body.subscribers[0];
}

async function createSubscriber(email, apiKey) {
  const { ok, body } = await kitFetch("subscribers", apiKey, {
    method: "POST",
    body: JSON.stringify({ email_address: email }),
  });
  if (!ok || !body || !body.subscriber) return null;
  return body.subscriber;
}

async function tagSubscriber(subscriberId, tagId, apiKey) {
  // Kit v4 wants the id flat on the body, NOT nested under "subscriber" —
  // {"subscriber": {"id": ...}} returns a 422 ("Either subscriber id or
  // email address is required to tag subscriber"). Confirmed against the
  // live API 2026-09-28.
  const { ok } = await kitFetch(`tags/${tagId}/subscribers`, apiKey, {
    method: "POST",
    body: JSON.stringify({ id: subscriberId }),
  });
  return ok;
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  let payload = req.body;
  if (typeof payload === "string") {
    try { payload = JSON.parse(payload); } catch (e) { payload = {}; }
  }
  const email = payload && payload.email ? String(payload.email).trim() : "";

  if (!isValidEmail(email)) {
    res.status(400).json({ error: "Enter a valid email address." });
    return;
  }

  const apiKey = process.env.KIT_API_KEY;
  if (!apiKey) {
    // Env var not set yet in Vercel — fail closed, never expose why in detail.
    res.status(500).json({ error: "Subscribe is not configured yet." });
    return;
  }

  try {
    let subscriber = await findSubscriber(email, apiKey);
    if (!subscriber) {
      subscriber = await createSubscriber(email, apiKey);
    }
    if (!subscriber || !subscriber.id) {
      res.status(502).json({ error: "Could not create subscriber." });
      return;
    }

    const tagged = await tagSubscriber(subscriber.id, DAILY_PRACTICE_TAG_ID, apiKey);
    if (!tagged) {
      res.status(502).json({ error: "Subscribed but tagging failed." });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Unexpected error." });
  }
};
