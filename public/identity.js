// Reviewer identity — Google-Docs-style "anonymous animal" names, no login.
//
// Goal (minimal, per the owner's ask): so a suggestion visibly carries WHO made
// it — at least enough to see it wasn't you. We don't collect real identities.
//
//   • Owner (the doc's author, via ?key=…):  name is fixed to "Owner".
//   • Everyone else (a guest with the link): gets an auto-assigned friendly name
//     like "Anonymous Otter", editable by them (Google Docs lets you rename your
//     anonymous self). The choice persists in localStorage so it's stable across
//     reloads and across every doc they review on this box.
//
// The name is only a display label: it's sent as the suggestion `author` and
// rendered on the suggestion card. It is untrusted (a reviewer could type
// anything) and is escaped server-side and again on render — never a trust
// signal, just a "not-you" marker.

const STORE_KEY = 'mmw_reviewer_name';

// Curated so the auto-name always reads as clearly anonymous + friendly, never
// as a real person. Kept short; the seed picks one deterministically.
const ANIMALS = [
  'Otter', 'Falcon', 'Panda', 'Heron', 'Bison', 'Lynx', 'Marmot', 'Ibis',
  'Badger', 'Puffin', 'Gecko', 'Tapir', 'Quokka', 'Narwhal', 'Wombat',
  'Kestrel', 'Manatee', 'Pangolin', 'Capybara', 'Axolotl', 'Meerkat', 'Ocelot',
];

// Small stable hash of a string -> non-negative int (FNV-1a). Used only to pick
// an animal deterministically from a seed; not security-sensitive.
function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// A stable-ish seed for THIS browser so the same guest keeps the same auto-name
// without any server round-trip. We can't read the httpOnly guest cookie from
// JS, so we derive a local seed (persisted) instead. Reviewers on different
// browsers get different names — which is exactly what we want.
function localSeed() {
  let seed = null;
  try { seed = localStorage.getItem('mmw_seed'); } catch { /* storage blocked */ }
  if (!seed) {
    // No Math.random dependency needed; use time + a scratch value. This runs in
    // the browser (not the workflow sandbox), so Date/crypto are available.
    const rnd = (typeof crypto !== 'undefined' && crypto.getRandomValues)
      ? crypto.getRandomValues(new Uint32Array(2)).join('-')
      : String(Date.now());
    seed = `${Date.now()}-${rnd}`;
    try { localStorage.setItem('mmw_seed', seed); } catch { /* ignore */ }
  }
  return seed;
}

// Deterministic "Anonymous <Animal>" from a seed.
function autoName(seed) {
  const animal = ANIMALS[hashStr(seed) % ANIMALS.length];
  return `Anonymous ${animal}`;
}

// Resolve the reviewer's display name.
//   isOwner=true  -> always "Owner" (ignores any stored guest name).
//   otherwise     -> the name they chose, else a stable auto-assigned one.
export function reviewerName(isOwner) {
  if (isOwner) return 'Owner';
  let stored = null;
  try { stored = localStorage.getItem(STORE_KEY); } catch { /* ignore */ }
  if (stored && stored.trim()) return stored.trim().slice(0, 40);
  return autoName(localSeed());
}

// Persist a reviewer-chosen name. Empty/blank clears the override (falls back to
// the auto name). Trimmed and length-capped to match the server's author cap.
export function setReviewerName(name) {
  const clean = String(name || '').trim().slice(0, 40);
  try {
    if (clean) localStorage.setItem(STORE_KEY, clean);
    else localStorage.removeItem(STORE_KEY);
  } catch { /* storage blocked: name just won't persist */ }
  return clean || autoName(localSeed());
}
