// mode-policy.js is the single source of truth for the viewer's mode dropdown:
// which of Editing/Suggesting/Using a caller may select, and which is the default
// on load. It must exactly mirror the server's access gate — a caller who the API
// says canEdit must get Editing selectable + defaulted; a view-only guest must
// never land in an editable mode. These tests pin every capability combination.
import { canUseMode, defaultMode, modePolicy, MODES, MODE_UNAVAILABLE_REASON } from '../public/mode-policy.js';

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };
const eq = (a, b, m) => ok(a === b, `${m} — expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);

// --- canUseMode: per-mode selectability --------------------------------------
eq(canUseMode('edit',    { canEdit: true,  canSuggest: true,  interactive: false }), true,  'edit selectable when canEdit');
eq(canUseMode('edit',    { canEdit: false, canSuggest: true,  interactive: false }), false, 'edit NOT selectable without canEdit');
eq(canUseMode('suggest', { canEdit: false, canSuggest: true,  interactive: false }), true,  'suggest selectable when canSuggest');
eq(canUseMode('suggest', { canEdit: true,  canSuggest: false, interactive: false }), false, 'suggest NOT selectable without canSuggest');
eq(canUseMode('use',     { canEdit: true,  canSuggest: true,  interactive: true  }), true,  'use selectable for interactive docs');
eq(canUseMode('use',     { canEdit: true,  canSuggest: true,  interactive: false }), false, 'use NOT selectable for static docs');
eq(canUseMode('bogus',   { canEdit: true,  canSuggest: true,  interactive: true  }), false, 'unknown mode never selectable');

// --- defaultMode: most-capable-allowed, in edit → suggest → use → view -------
eq(defaultMode({ canEdit: true,  canSuggest: true,  interactive: false }), 'edit',    'edit access → default Editing');
eq(defaultMode({ canEdit: true,  canSuggest: true,  interactive: true  }), 'edit',    'edit access wins even when interactive');
eq(defaultMode({ canEdit: false, canSuggest: true,  interactive: false }), 'suggest', 'suggest-only → default Suggesting');
eq(defaultMode({ canEdit: false, canSuggest: false, interactive: true  }), 'use',     'view-only interactive → default Using');
eq(defaultMode({ canEdit: false, canSuggest: false, interactive: false }), 'view',    'view-only static → default Viewing (locked)');

// The default mode must ALWAYS be usable (or 'view'); we never default into a mode
// the caller can't operate. Exhaustive over all 8 capability combinations.
for (const canEdit of [false, true]) for (const canSuggest of [false, true]) for (const interactive of [false, true]) {
  const caps = { canEdit, canSuggest, interactive };
  const d = defaultMode(caps);
  ok(d === 'view' || canUseMode(d, caps),
     `default (${d}) is usable for caps ${JSON.stringify(caps)}`);
}

// A doc-owner style caller (canEdit true) never defaults to suggest/use.
eq(defaultMode({ canEdit: true, canSuggest: false, interactive: true }), 'edit', 'canEdit alone → Editing');

// --- modePolicy: full snapshot for the dropdown ------------------------------
const viewOnly = modePolicy({ canEdit: false, canSuggest: false, interactive: false });
eq(viewOnly.default, 'view', 'view-only policy defaults to view');
eq(viewOnly.modes.length, 3, 'policy always lists all 3 modes (never hides one)');
ok(viewOnly.modes.every((m) => MODES.includes(m.mode)), 'policy modes are edit/suggest/use');
ok(viewOnly.modes.every((m) => !m.enabled), 'view-only: no mode enabled');
ok(viewOnly.modes.every((m) => m.reason === MODE_UNAVAILABLE_REASON[m.mode]), 'disabled modes carry their reason');

const suggester = modePolicy({ canEdit: false, canSuggest: true, interactive: false });
eq(suggester.default, 'suggest', 'suggester defaults to Suggesting');
eq(suggester.modes.find((m) => m.mode === 'suggest').enabled, true, 'suggester: Suggesting enabled');
eq(suggester.modes.find((m) => m.mode === 'edit').enabled, false, 'suggester: Editing disabled');
eq(suggester.modes.find((m) => m.mode === 'edit').reason, MODE_UNAVAILABLE_REASON.edit, 'suggester: Editing gives edit reason');
ok(suggester.modes.find((m) => m.mode === 'suggest').reason === null, 'enabled mode has null reason');

const editor = modePolicy({ canEdit: true, canSuggest: true, interactive: false });
eq(editor.default, 'edit', 'editor defaults to Editing');
eq(editor.modes.find((m) => m.mode === 'use').enabled, false, 'editor on static doc: Using disabled');
eq(editor.modes.find((m) => m.mode === 'use').reason, MODE_UNAVAILABLE_REASON.use, 'Using disabled reason = interactive-only');

console.log(`mode-policy: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
