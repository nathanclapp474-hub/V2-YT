// api/health-webhook.js
// Receives POSTs from the "Health Auto Export" iOS app and writes
// the latest Apple Watch / Health data into Supabase app_state.
//
// Setup:
// 1. Drop this file in your repo at /api/health-webhook.js and redeploy.
// 2. In Vercel -> Settings -> Environment Variables, add:
//      HEALTH_WEBHOOK_SECRET = any-random-string-you-pick
//    (reuses your existing SUPABASE_URL / SUPABASE_ANON_KEY, no new Supabase setup needed)
// 3. In Health Auto Export -> Automations -> New Automation -> REST API:
//      URL: https://your-app.vercel.app/api/health-webhook?secret=YOUR_SECRET
//      Method: POST, Format: JSON
//      Pick whichever metrics you want (steps, heart rate, sleep, HRV, etc.)
//      Set a schedule (e.g. every morning, or "on automation trigger")

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Use POST' });
  }

  // --- simple shared-secret auth (this endpoint is public, don't skip this) ---
  const secret = req.query.secret || req.headers['x-webhook-secret'];
  if (!process.env.HEALTH_WEBHOOK_SECRET || secret !== process.env.HEALTH_WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return res.status(500).json({ error: 'Supabase env vars not configured' });
  }

  try {
    const body = req.body || {};
    const metrics = body?.data?.metrics || [];
    const workouts = body?.data?.workouts || [];

    // Reduce the payload to "latest value per metric" so app_state stays small
    // and the dashboard can just read straight values instead of arrays.
    const latest = {};
    for (const m of metrics) {
      const points = m.data || [];
      if (!points.length) continue;
      // last entry = most recent (Health Auto Export sends chronological order)
      const last = points[points.length - 1];
      latest[m.name] = { units: m.units || null, ...last };
    }

    const recentWorkouts = workouts.slice(-5); // keep last 5 workouts only

    // 1. Read existing app_state row for key 'health' so we merge, not overwrite
    const getRes = await fetch(
      `${SUPABASE_URL}/rest/v1/app_state?key=eq.health&select=data`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
      }
    );
    const existingRows = await getRes.json();
    const existingData = existingRows?.[0]?.data || {};

    const merged = {
      ...existingData,
      metrics: { ...(existingData.metrics || {}), ...latest },
      workouts: recentWorkouts.length ? recentWorkouts : existingData.workouts || [],
      last_synced: new Date().toISOString(),
      source: 'apple_health',
    };

    // 2. Upsert into app_state
    const upsertRes = await fetch(`${SUPABASE_URL}/rest/v1/app_state`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify({
        key: 'health',
        data: merged,
        updated_at: new Date().toISOString(),
      }),
    });

    if (!upsertRes.ok) {
      const errText = await upsertRes.text();
      throw new Error(`Supabase upsert failed: ${errText}`);
    }

    return res.status(200).json({
      ok: true,
      metrics_received: metrics.length,
      workouts_received: workouts.length,
    });
  } catch (err) {
    console.error('health-webhook error:', err);
    return res.status(500).json({ error: err.message });
  }
}
