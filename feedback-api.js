// Feedback → GitHub issue endpoint (server side).
//
// POST /api/feedback  → opens a GitHub issue in the configured repo.
//
// Config (env):
//   GITHUB_TOKEN  — fine-grained PAT scoped to the repo, "Issues: Read and
//                   write". Lives ONLY on the server; never sent to the browser.
//   GITHUB_REPO   — "owner/name" (defaults to DEFAULT_REPO below).
//   FEEDBACK_ALLOWED_HOSTS — comma-separated extra hostnames allowed to POST
//                   (in addition to this deployment's own host).
//
// Anti-spam (layered, in-memory — fine for one small always-on box):
//   1. Same-origin only — Origin/Referer host must match the request host, so
//      raw curl/bot POSTs are rejected.
//   2. Per-IP sliding-window rate limit.
//   3. Content guards — honeypot field, min/max length.
//
// Mirrors the AI Architect feedback function, ported from a Vercel handler to
// an Express route so it fits markmyword's Express + Fly setup.

const DEFAULT_REPO = 'alexagriffith/markmyword';
const MIN_LEN = 2;
const MAX_LEN = 5000;

const RL_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const RL_MAX = 6;                    // max submissions per IP per window
const RL_MIN_GAP_MS = 4000;          // min gap between two submissions

// Neutralize GitHub auto-linking in plain-text (non-fenced) contexts: a
// zero-width space after @ / # stops mentions and issue cross-refs from firing,
// while the text still reads normally.
function defuse(s) {
  return String(s).replace(/([@#])/g, '$1​');
}

// Client IP, honoring Fly's header first (same order guardrails uses).
function clientIp(req) {
  return (
    req.headers['fly-client-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

function makeRateLimiter(now) {
  const hits = new Map(); // ip -> number[] of recent timestamps
  let sweepAt = 0;
  return function rateLimited(ip) {
    const t = now();
    // Proactively drop expired IPs on a timer, not only when the map is huge, so
    // a spray of one-request-per-IP sources can't accumulate unbounded entries.
    if (t > sweepAt) {
      for (const [k, v] of hits) {
        if (!v.some((ts) => t - ts < RL_WINDOW_MS)) hits.delete(k);
      }
      sweepAt = t + RL_WINDOW_MS;
    }
    const arr = (hits.get(ip) || []).filter((ts) => t - ts < RL_WINDOW_MS);
    if (arr.length && t - arr[arr.length - 1] < RL_MIN_GAP_MS) { hits.set(ip, arr); return true; }
    if (arr.length >= RL_MAX) { hits.set(ip, arr); return true; }
    arr.push(t);
    hits.set(ip, arr);
    return false;
  };
}

function sameOrigin(req) {
  const host = req.headers.host;
  if (!host) return false;
  const src = req.headers.origin || req.headers.referer || '';
  if (!src) return false;
  let srcHost;
  try { srcHost = new URL(src).host.toLowerCase(); } catch { return false; }
  const h = host.toLowerCase();
  if (srcHost === h) return true;
  const extra = (process.env.FEEDBACK_ALLOWED_HOSTS || '')
    .split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  return extra.includes(srcHost);
}

// Build the Express handler. `now` and `fetchImpl` are injectable for tests.
export function makeFeedbackHandler({ now = () => Date.now(), fetchImpl = fetch } = {}) {
  const rateLimited = makeRateLimiter(now);

  return async function handler(req, res) {
    // 1. Only accept posts that came from the app itself.
    if (!sameOrigin(req)) {
      return res.status(403).json({ ok: false, error: 'Feedback can only be sent from the app.' });
    }

    // 2. Rate limit (cheap reject before any GitHub work).
    if (rateLimited(clientIp(req))) {
      return res.status(429).json({ ok: false, error: 'You are sending feedback too quickly — please wait a moment and try again.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};

    // 3a. Honeypot: bots fill hidden fields; real users leave it empty. Silently
    // accept so the bot thinks it succeeded, and do nothing.
    if (body.website) {
      return res.status(200).json({ ok: true });
    }

    // 3b. Content guards.
    const message = (body.message || '').toString().trim();
    if (message.length < MIN_LEN) {
      return res.status(400).json({ ok: false, error: 'Please enter a bit more detail first.' });
    }
    if (message.length > MAX_LEN) {
      return res.status(400).json({ ok: false, error: 'That feedback is too long — please shorten it.' });
    }

    // Server config check (after validating the request itself).
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO || DEFAULT_REPO;
    if (!token) {
      return res.status(500).json({ ok: false, error: 'Feedback is not configured yet (missing GITHUB_TOKEN).' });
    }

    const screen = (body.screen || '').toString().slice(0, 200);
    const ua = (req.headers['user-agent'] || '').toString().slice(0, 300);

    const oneLine = message.replace(/\s+/g, ' ').trim();
    // Title is plain text on GitHub (no markdown), but neutralize @mentions so a
    // title can't ping anyone, and drop backticks so it can't break out.
    const title = `Feedback: ${defuse(oneLine).replace(/`/g, "'").slice(0, 70)}${oneLine.length > 70 ? '…' : ''}`;
    // The reporter's message and screen are UNTRUSTED. Render them inside a fenced
    // code block so markdown (links, images/tracking pixels, headings) and
    // @mentions stay inert; guard against a fence break in the message itself.
    const fence = message.includes('```') ? '````' : '```';
    const issueBody = [
      fence,
      message,
      fence,
      '',
      '---',
      screen ? `**Where:** \`${defuse(screen)}\`` : '',
      `**Browser:** \`${ua.replace(/`/g, "'")}\``,
      `_Sent from the in-app feedback button._`,
    ].filter(Boolean).join('\n');

    const [owner, name] = repo.split('/');
    try {
      const gh = await fetchImpl(`https://api.github.com/repos/${owner}/${name}/issues`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'User-Agent': 'markmyword-feedback',
        },
        body: JSON.stringify({ title, body: issueBody }),
      });

      if (!gh.ok) {
        // Don't leak the token or GitHub internals to the client.
        return res.status(502).json({ ok: false, error: `Could not create the issue (GitHub returned ${gh.status}).` });
      }
      const issue = await gh.json();
      return res.status(200).json({ ok: true, url: issue.html_url, number: issue.number });
    } catch {
      return res.status(502).json({ ok: false, error: 'Could not reach GitHub — please try again.' });
    }
  };
}
