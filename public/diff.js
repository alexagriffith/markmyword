// Minimal word-level diff for showing what changed between two versions of a
// block's text. Returns an array of {type:'eq'|'del'|'ins', text} tokens.
// Uses a standard LCS over whitespace-split tokens — good enough for prose diffs
// in a review UI (not a full Myers diff, but readable and dependency-free).

function tokenize(s) {
  // Keep whitespace as part of tokens so re-joining reproduces spacing.
  return String(s).split(/(\s+)/).filter((t) => t.length > 0);
}

// Above this token count on either side, the O(n*m) LCS table gets too big to
// build safely (a pathological block could allocate hundreds of MB and freeze
// the tab). Prose review diffs are far smaller; beyond the cap we degrade to a
// coarse whole-block replace instead of a word-level diff.
const MAX_DIFF_TOKENS = 2000;

export function diffWords(oldStr, newStr) {
  const a = tokenize(oldStr);
  const b = tokenize(newStr);
  const n = a.length, m = b.length;

  if (n > MAX_DIFF_TOKENS || m > MAX_DIFF_TOKENS) {
    const out = [];
    if (oldStr) out.push({ type: 'del', text: oldStr });
    if (newStr) out.push({ type: 'ins', text: newStr });
    return out;
  }

  // LCS length table.
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out = [];
  let i = 0, j = 0;
  const push = (type, text) => {
    const last = out[out.length - 1];
    if (last && last.type === type) last.text += text;
    else out.push({ type, text });
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) { push('eq', a[i]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { push('del', a[i]); i++; }
    else { push('ins', b[j]); j++; }
  }
  while (i < n) { push('del', a[i]); i++; }
  while (j < m) { push('ins', b[j]); j++; }
  return out;
}

// Render a diff token list to an HTML string with ins/del styling. Escapes text.
export function renderDiffHtml(tokens) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return tokens.map((t) => {
    const safe = esc(t.text);
    if (t.type === 'eq') return safe;
    if (t.type === 'del') return `<del class="hs-diff-del">${safe}</del>`;
    return `<ins class="hs-diff-ins">${safe}</ins>`;
  }).join('');
}
