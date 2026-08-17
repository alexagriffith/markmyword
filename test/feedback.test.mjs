// Unit tests for the feedback → GitHub issue handler. Exercises the guards
// (same-origin, honeypot, length, missing token) and a successful issue create,
// with an injected fetch so no real GitHub call is made and no token is needed.
import { makeFeedbackHandler } from '../feedback-api.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

// Minimal Express-like req/res doubles.
function mkReq({ host = 'app.test', origin = 'https://app.test', body = {}, ip = '1.2.3.4', ua = 'jsdom' } = {}) {
  return {
    headers: { host, origin, 'user-agent': ua, 'fly-client-ip': ip },
    socket: { remoteAddress: ip },
    body,
  };
}
function mkRes() {
  return {
    statusCode: 0, payload: null, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(o) { this.payload = o; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

// A fixed clock so the per-IP limiter is deterministic; advance it per call so
// the min-gap guard doesn't trip our own sequential tests.
let t = 1_000_000;
const now = () => (t += 5000);

// 1. Cross-origin POST is rejected (403) before any GitHub work.
{
  const h = makeFeedbackHandler({ now, fetchImpl: async () => { throw new Error('should not fetch'); } });
  const res = mkRes();
  await h(mkReq({ origin: 'https://evil.test', body: { message: 'hi there' } }), res);
  ok(res.statusCode === 403, 'cross-origin -> 403');
  ok(res.payload.ok === false, 'cross-origin body ok:false');
}

// 2. Honeypot filled -> silent 200, no GitHub call.
{
  let fetched = false;
  const h = makeFeedbackHandler({ now, fetchImpl: async () => { fetched = true; return { ok: true, json: async () => ({}) }; } });
  const res = mkRes();
  await h(mkReq({ body: { message: 'spam', website: 'http://bot' } }), res);
  ok(res.statusCode === 200 && res.payload.ok === true, 'honeypot -> silent 200');
  ok(fetched === false, 'honeypot never calls GitHub');
}

// 3. Too-short message -> 400.
{
  const h = makeFeedbackHandler({ now, fetchImpl: async () => ({ ok: true, json: async () => ({}) }) });
  const res = mkRes();
  await h(mkReq({ body: { message: 'x' } }), res);
  ok(res.statusCode === 400, 'too-short -> 400');
}

// 4. Missing GITHUB_TOKEN -> 500 with a clear message, valid request otherwise.
{
  const saved = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const h = makeFeedbackHandler({ now, fetchImpl: async () => { throw new Error('should not fetch'); } });
  const res = mkRes();
  await h(mkReq({ body: { message: 'a real bug report' } }), res);
  ok(res.statusCode === 500 && /GITHUB_TOKEN/.test(res.payload.error), 'no token -> 500 (configured)');
  if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
}

// 5. Happy path -> creates an issue, returns url + number, token never in response.
{
  process.env.GITHUB_TOKEN = 'test-token-shh';
  process.env.GITHUB_REPO = 'owner/repo';
  let seenAuth = null, seenBody = null, seenUrl = null;
  const h = makeFeedbackHandler({
    now,
    fetchImpl: async (url, init) => {
      seenUrl = url; seenAuth = init.headers.Authorization; seenBody = JSON.parse(init.body);
      return { ok: true, json: async () => ({ html_url: 'https://github.com/owner/repo/issues/7', number: 7 }) };
    },
  });
  const res = mkRes();
  await h(mkReq({ body: { message: 'clicking suggest did nothing on the chart', screen: 'Document abc — Report · mode: suggest' } }), res);
  ok(res.statusCode === 200 && res.payload.ok === true, 'happy path -> 200 ok');
  ok(res.payload.url === 'https://github.com/owner/repo/issues/7' && res.payload.number === 7, 'returns issue url + number');
  ok(seenUrl === 'https://api.github.com/repos/owner/repo/issues', 'posts to configured repo issues endpoint');
  ok(seenAuth === 'Bearer test-token-shh', 'token sent to GitHub as Bearer');
  ok(JSON.stringify(res.payload).indexOf('test-token-shh') === -1, 'token NOT leaked in response');
  ok(/\*\*Where:\*\*/.test(seenBody.body) && /mode: suggest/.test(seenBody.body), 'issue body includes screen context');
  delete process.env.GITHUB_TOKEN; delete process.env.GITHUB_REPO;
}

// 6. GitHub error -> 502, GitHub internals not leaked.
{
  process.env.GITHUB_TOKEN = 'test-token-shh';
  const h = makeFeedbackHandler({ now, fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ message: 'validation' }) }) });
  const res = mkRes();
  await h(mkReq({ body: { message: 'another real report' } }), res);
  ok(res.statusCode === 502 && /422/.test(res.payload.error), 'github failure -> 502 (status only)');
  delete process.env.GITHUB_TOKEN;
}

console.log(`feedback: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
