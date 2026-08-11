// Guardrails for a small shared box: rate limiting, caller identity (owner vs
// guest), and per-guest document caps. Designed for ~15 trusted testers on one
// cheap Fly machine — cheap to run, no external deps beyond `cookie`.
//
// Identity model (no login yet):
//   • OWNER  — holds the OWNER_KEY secret. Passes it once as ?key=… (or the
//              x-owner-key header); we set a signed cookie so the tab stays
//              "owner". Unlimited docs, exempt from the guest ceiling.
//   • GUEST  — anyone else. Gets an anonymous signed id cookie = their identity.
//              Capped to GUEST_DOC_LIMIT docs; the whole box is capped to
//              MAX_GUEST_OWNERS distinct guests.
//
// Rate limits are per-IP sliding windows held in memory (fine for one process;
// resets on restart, which is acceptable for abuse protection on a small box).
import crypto from 'node:crypto';
import * as cookie from 'cookie';

// ── tunables (env-overridable) ───────────────────────────────────────────────
export const LIMITS = {
  // "Tight" preset chosen by the owner.
  READ_PER_MIN: num(process.env.MMW_READ_PER_MIN, 300),   // GET doc/versions/suggestions + polling
  WRITE_PER_MIN: num(process.env.MMW_WRITE_PER_MIN, 60),  // edit / suggest / accept / reject / restore
  UPLOAD_PER_HOUR: num(process.env.MMW_UPLOAD_PER_HOUR, 10),
  GUEST_DOC_LIMIT: num(process.env.MMW_GUEST_DOC_LIMIT, 1), // docs a single guest may own
  MAX_GUEST_OWNERS: num(process.env.MMW_MAX_GUEST_OWNERS, 15), // distinct guests on the box
  MAX_DOC_BYTES: num(process.env.MMW_MAX_DOC_BYTES, 2_000_000), // 2 MB per file
};

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ── secret for signing cookies ───────────────────────────────────────────────
// SESSION_SECRET should be set in production; fall back to a per-boot random so
// dev still works (cookies just don't survive a restart, which is fine).
const SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const OWNER_KEY = process.env.OWNER_KEY || ''; // empty => owner mode disabled

const sign = (val) => crypto.createHmac('sha256', SECRET).update(val).digest('base64url');
function signed(val) { return `${val}.${sign(val)}`; }
function unsign(tok) {
  if (typeof tok !== 'string' || !tok.includes('.')) return null;
  const i = tok.lastIndexOf('.');
  const val = tok.slice(0, i), mac = tok.slice(i + 1);
  const expect = sign(val);
  // constant-time compare
  if (mac.length !== expect.length) return null;
  return crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect)) ? val : null;
}

// ── rate limiter: in-memory sliding window per (bucket, ip) ───────────────────
const hits = new Map(); // key -> number[] (timestamps ms)

function allow(bucket, ip, limit, windowMs, now) {
  const key = `${bucket}:${ip}`;
  const arr = hits.get(key) || [];
  const cutoff = now - windowMs;
  // drop expired, keep recent
  let i = 0;
  while (i < arr.length && arr[i] <= cutoff) i++;
  const recent = i > 0 ? arr.slice(i) : arr;
  if (recent.length >= limit) {
    hits.set(key, recent);
    return { ok: false, retryAfter: Math.ceil((recent[0] + windowMs - now) / 1000) };
  }
  recent.push(now);
  hits.set(key, recent);
  return { ok: true };
}

// Occasionally sweep empty/expired keys so the map can't grow unbounded.
function sweep(now) {
  const HOUR = 3600_000;
  for (const [key, arr] of hits) {
    if (!arr.length || arr[arr.length - 1] <= now - HOUR) hits.delete(key);
  }
}

// Client IP, honoring one proxy hop (Fly sets fly-client-ip / X-Forwarded-For).
function clientIp(req) {
  return (
    req.headers['fly-client-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

// ── middleware factory ───────────────────────────────────────────────────────
// `now` is injectable for tests.
export function makeGuardrails({ now = () => Date.now() } = {}) {
  let sweepAt = 0;

  // Attach req.caller = { token, isOwner } and (re)issue cookies.
  // token identifies a guest for the doc cap; owner's token is the literal
  // 'owner' so all owner docs share one bucket and never count as guests.
  function identify(req, res, next) {
    const jar = cookie.parse(req.headers.cookie || '');
    let isOwner = false;

    // Promote to owner if the correct key is presented (query or header),
    // or if a valid owner cookie is already set.
    const presented = req.query?.key || req.headers['x-owner-key'];
    if (OWNER_KEY && presented && safeEqual(String(presented), OWNER_KEY)) {
      isOwner = true;
      res.append('Set-Cookie', cookie.serialize('mmw_owner', signed('owner'), cookieOpts(true)));
    } else if (jar.mmw_owner && unsign(jar.mmw_owner) === 'owner') {
      isOwner = true;
    }

    let token;
    if (isOwner) {
      token = 'owner';
    } else {
      // Existing valid guest cookie, else mint a new anonymous id.
      const existing = jar.mmw_guest ? unsign(jar.mmw_guest) : null;
      token = existing || `g_${crypto.randomBytes(12).toString('base64url')}`;
      if (!existing) {
        res.append('Set-Cookie', cookie.serialize('mmw_guest', signed(token), cookieOpts(false)));
      }
    }

    req.caller = { token, isOwner };
    next();
  }

  const limiter = (bucket, limit, windowMs) => (req, res, next) => {
    const t = now();
    if (t > sweepAt) { sweep(t); sweepAt = t + 600_000; } // sweep ~every 10 min
    // Owner is exempt from rate limits (it's you).
    if (req.caller?.isOwner) return next();
    const r = allow(bucket, clientIp(req), limit, windowMs, t);
    if (!r.ok) {
      res.setHeader('Retry-After', String(r.retryAfter));
      return res.status(429).json({ error: 'rate_limited', retryAfter: r.retryAfter });
    }
    next();
  };

  return {
    identify,
    readLimiter: limiter('read', LIMITS.READ_PER_MIN, 60_000),
    writeLimiter: limiter('write', LIMITS.WRITE_PER_MIN, 60_000),
    uploadLimiter: limiter('upload', LIMITS.UPLOAD_PER_HOUR, 3600_000),
  };
}

function cookieOpts(isOwner) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: isOwner ? 60 * 60 * 24 * 90 : 60 * 60 * 24 * 365, // owner 90d, guest 1y
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Exposed for tests.
export const _internal = { sign, signed, unsign, allow, clientIp, hits, safeEqual };
