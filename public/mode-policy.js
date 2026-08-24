// Mode policy — the pure decision behind the viewer's mode dropdown.
//
// Given a caller's capabilities on a doc (canEdit / canSuggest, and whether the
// doc is interactive), decide:
//   • which modes are SELECTABLE (Editing / Suggesting / Using), and
//   • which mode should be the DEFAULT on load.
// The viewer's dropdown renders all three modes always (an absent button is what
// made the toolbar feel broken); a non-selectable mode is shown disabled with a
// reason. Keeping this logic pure + exported means it can be tested exhaustively
// without booting the whole viewer, and there's exactly ONE source of truth for
// "who can do what" — matching the server's access gate.

export const MODES = ['edit', 'suggest', 'use'];

// Human-facing reason a mode is unavailable (shown in the disabled row's subline).
export const MODE_UNAVAILABLE_REASON = {
  edit: "You don't have edit access on this link",
  suggest: 'This link is view-only',
  use: 'Only for interactive documents',
};

// Is a single mode selectable for these capabilities?
//   edit    — needs edit access (owner, or link access = edit)
//   suggest — needs suggest access (owner, or link access ≥ suggest)
//   use     — only meaningful for interactive docs (their own links/tabs/buttons)
export function canUseMode(mode, { canEdit, canSuggest, interactive }) {
  switch (mode) {
    case 'edit': return !!canEdit;
    case 'suggest': return !!canSuggest;
    case 'use': return !!interactive;
    default: return false;
  }
}

// The default mode on load: the most capable the caller is allowed, in the order
// edit → suggest → use. A caller with none of those (a view-only static link) gets
// 'view': a read-only state with no selectable mode (the trigger locks to "Viewing").
export function defaultMode({ canEdit, canSuggest, interactive }) {
  if (canEdit) return 'edit';
  if (canSuggest) return 'suggest';
  if (interactive) return 'use';
  return 'view';
}

// Full snapshot for the dropdown: the default plus each mode's enabled/reason.
// `caps` = { canEdit, canSuggest, interactive }.
export function modePolicy(caps) {
  return {
    default: defaultMode(caps),
    modes: MODES.map((mode) => ({
      mode,
      enabled: canUseMode(mode, caps),
      reason: canUseMode(mode, caps) ? null : MODE_UNAVAILABLE_REASON[mode],
    })),
  };
}
