// Vercel serverless function — handles the "Email Me This Result" lead
// capture on the Your Daily Practice result screen.
//
// The actual email send is a client-side mailto: (see conversation.html /
// emailMeResult()) since we have no transactional email service wired up.
// This endpoint's only job is the Kit (ConvertKit) side: create/find the
// subscriber and tag them "Daily Practice Tool - Got Result" (id 24466600)
// so completing the tool and requesting a copy counts as a real lead
// signal — distinct from the separate weekly-nudge "Subscriber" tag
// (24069623) handled by api/subscribe.js. Someone can do one, both, or
// neither; the two tags are intentionally independent.
//
// Requires the same environment variable as subscribe.js:
//   KIT_API_KEY = <Kit v4 API key>

const KIT_BASE_URL = "https://api.kit.com/v4";
const GOT_RESULT_TAG_ID = 24466600; // "Daily Practice Tool - Got Result"

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
  // same gotcha documented in api/subscribe.js. Confirmed 2026-09-28.
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
    // Env var not set yet — fail closed. The mailto: send still works
    // client-side regardless of whether this Kit call succeeds.
    res.status(500).json({ error: "Not configured yet." });
    return;
  }

  try {
    let subscriber = await findSubscriber(email, apiKey);
    if (!subscriber) {
      subscriber = await createSubscriber(email, apiKey);
    }
    if (!subscriber || !subscriber.id) {
      res.status(502).json({ error: "Could not create/find subscriber." });
      return;
    }

    const tagged = await tagSubscriber(subscriber.id, GOT_RESULT_TAG_ID, apiKey);
    if (!tagged) {
      res.status(502).json({ error: "Subscriber saved but tagging failed." });
      return;
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Unexpected error." });
  }
};
