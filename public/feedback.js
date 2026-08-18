/**
 * In-app feedback / help widget — a small floating button (bottom-LEFT so it
 * never sits over the editor toolbar, the suggestions panel, or the download
 * menu, which all live top / bottom-right). Clicking it opens a panel to send a
 * short message, which POSTs to /api/feedback and opens a GitHub issue.
 *
 * Editing-first, on purpose:
 *   • It NEVER auto-opens, shakes, or nudges — it only appears when clicked, so
 *     it can't interrupt someone mid-edit.
 *   • The launcher is the only always-clickable element; the dimming overlay is
 *     mounted ONLY while the panel is open, and closes on Escape / backdrop, so
 *     it never captures a stray click into the document.
 *   • Self-contained: injects its own markup + styles into <body>, depends on no
 *     app module. Loaded via <script type="module"> from index.html and
 *     viewer.html.
 *
 * Page context is read from the DOM/URL (doc title, doc id, editor mode) and
 * sent along so a filed issue says exactly where the reporter was.
 */

const STYLES = `
  .fb-launch {
    position: fixed; left: 18px; bottom: 18px; z-index: 4000;
    display: inline-flex; align-items: center; gap: 0;
    height: 44px; width: 44px; padding: 0; overflow: hidden;
    border-radius: 999px; cursor: pointer; white-space: nowrap;
    font: 600 13px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #fff; background: #4f46e5;
    border: 1px solid rgba(255,255,255,0.16);
    box-shadow: 0 6px 18px rgba(31,41,55,0.28);
    transition: width .22s cubic-bezier(0.16,1,0.3,1), box-shadow .15s ease, transform .15s ease;
  }
  .fb-launch .fb-launch-icon {
    flex: none; width: 44px; height: 44px;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .fb-launch .fb-launch-icon svg { width: 19px; height: 19px; }
  .fb-launch .fb-launch-label { opacity: 0; transition: opacity .15s ease; padding-right: 16px; }
  .fb-launch:hover, .fb-launch:focus-visible {
    width: 132px; box-shadow: 0 8px 24px rgba(79,70,229,0.42); transform: translateY(-1px);
  }
  .fb-launch:hover .fb-launch-label, .fb-launch:focus-visible .fb-launch-label { opacity: 1; }

  .fb-overlay {
    position: fixed; inset: 0; z-index: 4001; display: none;
    align-items: flex-end; justify-content: flex-start;
    /* Extra bottom gap clears the launcher so the panel never sits flush to
       the viewport edge, even on a short window. */
    padding: 18px 18px 74px;
    background: rgba(17,24,39,0.32);
  }
  .fb-overlay.open { display: flex; }

  .fb-panel {
    width: min(380px, 92vw);
    max-height: calc(100vh - 92px); overflow-y: auto;
    background: #fff;
    border: 1px solid #e2e5ea;
    border-radius: 14px; padding: 18px;
    box-shadow: 0 20px 50px rgba(17,24,39,0.28);
    font: 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    color: #1f2430;
  }
  .fb-panel h3 { margin: 0 0 4px; font-size: 16px; font-weight: 700; color: #111827; }
  .fb-panel p.fb-sub { margin: 0 0 12px; font-size: 13px; color: #5b6270; line-height: 1.5; }
  .fb-panel textarea {
    width: 100%; box-sizing: border-box; min-height: 108px; resize: vertical;
    padding: 10px 12px; border-radius: 8px;
    background: #fafbfc; border: 1px solid #d6dae1;
    color: #111827; font: inherit; line-height: 1.5;
  }
  .fb-panel textarea::placeholder { color: #9aa1ad; }
  .fb-panel textarea:focus { outline: none; border-color: #4f46e5; box-shadow: 0 0 0 3px rgba(79,70,229,0.12); }
  .fb-hp { position: absolute; left: -9999px; width: 1px; height: 1px; opacity: 0; }
  .fb-where { margin-top: 8px; font-size: 12px; line-height: 1.45; color: #7a828f; }
  .fb-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .fb-btn {
    padding: 8px 14px; border-radius: 8px; cursor: pointer; font: 600 13px inherit;
    border: 1px solid transparent;
  }
  .fb-btn-secondary { background: #fff; color: #374151; border-color: #d6dae1; }
  .fb-btn-secondary:hover { background: #f3f4f6; }
  .fb-btn-primary { background: #4f46e5; color: #fff; }
  .fb-btn:disabled { opacity: 0.5; cursor: default; }
  .fb-status { margin-top: 10px; font-size: 13px; min-height: 18px; }
  .fb-status.err { color: #dc2626; }
  .fb-status.ok { color: #059669; }
  .fb-status a { color: #4f46e5; }
`;

// Describe where the reporter is, read from the DOM/URL only (no app coupling).
function currentScreen() {
  const params = new URLSearchParams(location.search);
  const docId = params.get('doc') || (location.pathname.match(/\/d\/([\w-]+)/) || [])[1] || '';
  if (docId) {
    const title = (document.querySelector('#hs-doc-title, .hs-doc-title')?.textContent || document.title || '')
      .replace(/\s+/g, ' ').trim();
    const mode = document.querySelector('#hs-mode')?.value || '';
    const modeLabel = mode ? ` · mode: ${mode}` : '';
    return `Document ${docId}${title ? ` — ${title}` : ''}${modeLabel}`.slice(0, 200);
  }
  return 'Home';
}

function mount() {
  if (document.querySelector('.fb-launch')) return;

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.appendChild(style);

  const launch = document.createElement('button');
  launch.type = 'button';
  launch.className = 'fb-launch';
  launch.setAttribute('aria-label', 'Report an issue or send feedback');
  launch.innerHTML = `
    <span class="fb-launch-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
    </span>
    <span class="fb-launch-label">Feedback</span>`;

  const overlay = document.createElement('div');
  overlay.className = 'fb-overlay';
  overlay.innerHTML = `
    <div class="fb-panel" role="dialog" aria-label="Report an issue or send feedback">
      <h3>Something off? Tell us.</h3>
      <p class="fb-sub">A bug, a confusing bit, or a missing feature — it opens an issue for the team. It won't touch your document.</p>
      <textarea class="fb-text" placeholder="What happened, or what's not working?"></textarea>
      <input class="fb-hp" type="text" tabindex="-1" autocomplete="off" aria-hidden="true" placeholder="Leave this empty" />
      <div class="fb-where"></div>
      <div class="fb-actions">
        <button type="button" class="fb-btn fb-btn-secondary fb-cancel">Cancel</button>
        <button type="button" class="fb-btn fb-btn-primary fb-send">Send</button>
      </div>
      <div class="fb-status" role="status"></div>
    </div>`;

  document.body.appendChild(launch);
  document.body.appendChild(overlay);

  const text = overlay.querySelector('.fb-text');
  const hp = overlay.querySelector('.fb-hp');
  const where = overlay.querySelector('.fb-where');
  const sendBtn = overlay.querySelector('.fb-send');
  const cancelBtn = overlay.querySelector('.fb-cancel');
  const status = overlay.querySelector('.fb-status');

  const open = () => {
    const screen = currentScreen();
    where.textContent = screen ? `Reporting from: ${screen}` : '';
    status.textContent = '';
    status.className = 'fb-status';
    overlay.classList.add('open');
    setTimeout(() => text.focus(), 30);
  };
  const close = () => { overlay.classList.remove('open'); };

  launch.addEventListener('click', open);
  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && overlay.classList.contains('open')) close(); });

  async function send() {
    const message = text.value.trim();
    if (!message) { status.className = 'fb-status err'; status.textContent = 'Please enter some detail first.'; return; }
    sendBtn.disabled = true;
    status.className = 'fb-status'; status.textContent = 'Sending…';
    try {
      const resp = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, website: hp.value, screen: currentScreen() })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.ok) {
        status.className = 'fb-status ok';
        // Build the success line with DOM nodes (never innerHTML), and only
        // trust an http(s) issue URL, so nothing from the response can inject.
        status.textContent = '';
        const safeUrl = typeof data.url === 'string' && /^https?:\/\//.test(data.url) ? data.url : '';
        if (safeUrl) {
          status.append('Thanks! ');
          const a = document.createElement('a');
          a.href = safeUrl; a.target = '_blank'; a.rel = 'noopener';
          a.textContent = `Issue #${String(data.number ?? '').replace(/[^0-9]/g, '')}`;
          status.append(a, ' filed.');
        } else {
          status.textContent = 'Thanks — your report was sent.';
        }
        text.value = '';
        setTimeout(close, 2200);
      } else {
        status.className = 'fb-status err';
        status.textContent = data.error || 'Something went wrong — please try again.';
      }
    } catch {
      status.className = 'fb-status err';
      status.textContent = 'Network error — please try again.';
    } finally {
      sendBtn.disabled = false;
    }
  }

  sendBtn.addEventListener('click', send);
  text.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
