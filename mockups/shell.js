/* Aplos mockup shell (revision 2). Load synchronously in <head> (sets theme before paint).
   Page contract:
     <html data-window="main|onboarding" data-states="a,b,c" data-esc="home.html">
     <aside class="sidebar" data-active="home" data-status="importing" data-accounts="all" data-extra="calendar"></aside>
     <span class="traffic"></span>               (filled with traffic lights)
     <svg class="ic"><use href="#i-check"/></svg> (icon sprite)
     [data-tip="Compose" data-key="C"]            (tooltip with keycap)
     [data-list] > [data-row]                     (j/k list; data-href opens; E/L/# triage; X picks; Z undo)
     [data-app-icon]                              (filled with the app icon)
   API: Mock.toast({...}), Mock.onKey(fn), Mock.dur(name), Mock.reduced, Mock.state, Mock.closeGaps(list) */
(function () {
  const html = document.documentElement;
  const qs = new URLSearchParams(location.search);
  const stored = (() => { try { return localStorage.getItem('aplos-mock-theme'); } catch { return null; } })();
  html.dataset.theme = qs.get('theme') || stored || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  if (qs.has('shot')) html.classList.add('shot');
  if (qs.get('hints') === '1') html.classList.add('show-hints');
  const states = (html.dataset.states || '').split(',').map(s => s.trim()).filter(Boolean);
  const state = qs.get('state') || states[0] || '';
  if (state) html.dataset.state = state;

  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const css = name => getComputedStyle(html).getPropertyValue(name).trim();
  const dur = name => { const v = css('--dur-' + name); return v.endsWith('ms') ? parseFloat(v) : parseFloat(v) * 1000; };

  /* ---------------- Icons (Lucide-style monoline, drawn for these mockups) ---------------- */
  const I = {
    home: '<path d="M3.5 10.5 12 3.5l8.5 7"/><path d="M5.5 9v11h13V9"/><path d="M10 20v-5.5h4V20"/>',
    clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
    calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    today: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 17h.01"/>',
    tray: '<path d="M3.5 13.5 6 5h12l2.5 8.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19z"/><path d="M3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    filetext: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
    send: '<path d="M20.5 3.5 10.5 13.5"/><path d="M20.5 3.5 14 20.5l-3.5-7-7-3.5z"/>',
    trash: '<path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 13h10l1-13"/><path d="M10 11v5M14 11v5"/>',
    spam: '<path d="M8.2 3.5h7.6l4.7 4.7v7.6l-4.7 4.7H8.2l-4.7-4.7V8.2z"/><path d="M12 8v4.5M12 16h.01"/>',
    settings: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
    help: '<circle cx="12" cy="12" r="8.5"/><path d="M9.6 9.5a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.5M12 16.5h.01"/>',
    compose: '<path d="M12 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6"/><path d="M18.2 3.3a1.9 1.9 0 0 1 2.7 2.7L12.5 14.3 9 15l.7-3.5z"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
    bubble: '<path d="M20 14.5a2 2 0 0 1-2 2H8.5L4 20V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z"/><path d="M8 8.5h8M8 12h5"/>',
    bookmark: '<path d="M17.5 20.5 12 17l-5.5 3.5V5a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 17.5 5z"/>',
    more: '<circle cx="5.5" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.25" fill="currentColor" stroke="none"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
    checkcircle: '<circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.5 2.5 4.5-5"/>',
    circle: '<circle cx="12" cy="12" r="8.5"/>',
    reply: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5V20"/>',
    replyall: '<path d="M7.5 14 2.5 9l5-5"/><path d="M12.5 14l-5-5 5-5"/><path d="M7.5 9h7.5a5 5 0 0 1 5 5v6"/>',
    forward: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5A5.5 5.5 0 0 0 4 14.5V20"/>',
    paperclip: '<path d="m20.5 11.5-8.4 8.4a5 5 0 0 1-7-7l8.4-8.4a3.3 3.3 0 0 1 4.7 4.6l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.8-7.7"/>',
    link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.4.4l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.7 1.7"/><path d="M14 10.5a4.5 4.5 0 0 0-6.4-.4l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.7-1.7"/>',
    chevl: '<path d="m15 18-6-6 6-6"/>', chevr: '<path d="m9 18 6-6-6-6"/>', chevd: '<path d="m6 9 6 6 6-6"/>', chevu: '<path d="m6 15 6-6 6 6"/>',
    updown: '<path d="m7.5 15 4.5 4.5 4.5-4.5M7.5 9 12 4.5 16.5 9"/>',
    x: '<path d="M17.5 6.5l-11 11M6.5 6.5l11 11"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    arrowr: '<path d="M5 12h14M13 6l6 6-6 6"/>', arrowl: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    arrowu: '<path d="M12 19V5M6 11l6-6 6 6"/>', arrowd: '<path d="M12 5v14M6 13l6 6 6-6"/>',
    refresh: '<path d="M19.5 11A7.5 7.5 0 0 0 6 7.2L4.5 9"/><path d="M4.5 4.5V9H9"/><path d="M4.5 13A7.5 7.5 0 0 0 18 16.8l1.5-1.8"/><path d="M19.5 19.5V15H15"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>',
    cloudoff: '<path d="M3 3l18 18"/><path d="M6 8.5A5 5 0 0 0 7 18.5h10.5M20.5 15.5A4 4 0 0 0 17 10h-1A6.5 6.5 0 0 0 9.5 5.5"/>',
    alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5M12 16h.01"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    sun: '<circle cx="12" cy="12" r="3.5"/><path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
    moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8.5 20h7M12 16v4"/>',
    key: '<circle cx="7.5" cy="15.5" r="3.5"/><path d="m10 13 9-9M15.5 7.5l2.5 2.5M18 5l2 2"/>',
    server: '<rect x="3.5" y="4" width="17" height="7" rx="2"/><rect x="3.5" y="13" width="17" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
    laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.5"/><path d="M2.5 19h19"/>',
    lock: '<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/>',
    cart: '<circle cx="9" cy="20" r="1.2"/><circle cx="17.5" cy="20" r="1.2"/><path d="M3 3.5h2.2l2.3 12h10.8l2-8.5H6.2"/>',
    phone: '<path d="M20.5 16.4v3a2 2 0 0 1-2.2 2A18.5 18.5 0 0 1 2.6 5.7 2 2 0 0 1 4.6 3.5h3l1.4 4.1-1.9 1.6a12 12 0 0 0 7.7 7.7l1.6-1.9z"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>',
    bell: '<path d="M6 9a6 6 0 0 1 12 0c0 6.5 2.5 8 2.5 8h-17S6 15.5 6 9"/><path d="M10.3 20.5a2 2 0 0 0 3.4 0"/>',
    keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9"/>',
    user: '<circle cx="12" cy="8" r="3.8"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
    users: '<circle cx="9" cy="8.5" r="3.3"/><path d="M3 20a6 6 0 0 1 12 0"/><path d="M15.5 5.2a3.3 3.3 0 0 1 0 6.6M21 20a6 6 0 0 0-3.5-5.5"/>',
    globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5a13 13 0 0 1 0 17M12 3.5a13 13 0 0 0 0 17"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>',
    at: '<circle cx="12" cy="12" r="3.8"/><path d="M15.8 8.2v4.8a2.7 2.7 0 0 0 5.4 0V12a9.2 9.2 0 1 0-3.7 7.4"/>',
    external: '<path d="M14.5 3.5h6v6M10 14 20.5 3.5M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h5.5"/>',
    pin: '<path d="M12 21s-6.5-5.8-6.5-11a6.5 6.5 0 0 1 13 0c0 5.2-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
    video: '<rect x="2.5" y="6" width="13" height="12" rx="2"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/>',
    download: '<path d="M12 3.5v11.5M7 10l5 5 5-5M4.5 20h15"/>',
    pause: '<path d="M9 5.5v13M15 5.5v13"/>',
    type: '<path d="M5 7V5h14v2M9.5 19h5M12 5v14"/>',
    sidebar: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M9 4.5v15"/>',
    tag: '<path d="M3.5 12V5A1.5 1.5 0 0 1 5 3.5h7l8.5 8.5-8.5 8.5z"/><circle cx="8" cy="8" r="1.4"/>',
    eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    hourglass: '<path d="M6.5 3.5h11M6.5 20.5h11M7.5 3.5c0 5 9 5 9 8.5s-9 3.5-9 8.5M16.5 3.5c0 5-9 5-9 8.5s9 3.5 9 8.5"/>',
    grip: '<circle cx="9" cy="6" r="1" fill="currentColor"/><circle cx="15" cy="6" r="1" fill="currentColor"/><circle cx="9" cy="12" r="1" fill="currentColor"/><circle cx="15" cy="12" r="1" fill="currentColor"/><circle cx="9" cy="18" r="1" fill="currentColor"/><circle cx="15" cy="18" r="1" fill="currentColor"/>',
    popout: '<rect x="3.5" y="7.5" width="13" height="13" rx="2"/><path d="M8 4h10.5A1.5 1.5 0 0 1 20 5.5V16"/>',
    repeat: '<path d="M4 12a7 7 0 0 1 12-5l2.5 2.5"/><path d="M18.5 4.5v5h-5"/><path d="M20 12a7 7 0 0 1-12 5l-2.5-2.5"/><path d="M5.5 19.5v-5h5"/>',
  };
  function sprite() {
    const s = Object.entries(I).map(([k, v]) => `<symbol id="i-${k}" viewBox="0 0 24 24">${v}</symbol>`).join('');
    const d = document.createElement('div');
    d.innerHTML = `<svg width="0" height="0" style="position:absolute" aria-hidden="true">${s}</svg>`;
    document.body.prepend(d.firstChild);
  }
  const icon = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true"><use href="#i-${n}"/></svg>`;

  /* ---------------- Sidebar (revision 2: quiet groups, Notion-like) ---------------- */
  // [id, label, icon, href, count, key]
  const NAV = [
    { items: [['search', 'Search', 'search', 'search.html', null, '/'], ['home', 'Home', 'home', 'home.html', 14, '⌃1'], ['later', 'Later', 'clock', 'later.html', 9, '⌃2'], ['calendar', 'Calendar', 'calendar', 'calendar-week.html', null, '⌃6']] },
    { head: 'Mail', items: [['all', 'All mail', 'tray', 'inbox.html', null, '⌃3'], ['done', 'Done', 'checkcircle', 'done.html', null, ''], ['drafts', 'Drafts', 'file', 'empty.html?state=drafts', 1, '⌃4'], ['sent', 'Sent', 'send', 'inbox.html', null, '⌃5'], ['spam', 'Spam', 'spam', 'empty.html?state=spam', null, '⌃8'], ['trash', 'Trash', 'trash', 'empty.html?state=trash', null, '⌃7']] },
  ];
  const CALENDARS = [['Work', '--tag-hill'], ['Personal', '--tag-sky'], ['Hollow Creek', '--tag-ember'], ['Family', '--tag-sand']];
  const STATUS = {
    synced: '',
    importing: `<div class="status-slot">${icon('refresh')}<div style="flex:1">Importing older mail<br><b>214</b> of 500<div class="status-track" role="progressbar" aria-label="alex.moreno@gmail.com sync"><i></i></div></div></div>`,
    paused: `<div class="status-slot">${icon('pause')}<div>Google asked Aplos to slow down. Resuming at <b>2:14 PM</b>.<br><button class="btn btn-text xs">Retry now</button></div></div>`,
    offline: `<div class="status-slot">${icon('cloudoff')}<div>Offline. 2 changes waiting.</div></div>`,
    reconnect: `<div class="status-slot is-attn">${icon('alert')}<div><b>Google needs you to sign in again.</b><br><button class="btn btn-text xs btn-danger">Reconnect</button></div></div>`,
    demo: `<div class="status-slot">${icon('mail')}<div>Demo mail · Remove in Settings</div></div>`,
    firstmail: `<div class="status-slot">${icon('refresh')}<div style="flex:1">Reading your newest mail<br><b>24</b> of 50<div class="status-track" role="progressbar" aria-label="alex.moreno@gmail.com sync"><i></i></div></div></div>`,
  };
  const ACCTS = {
    all: { label: 'Alex Moreno', mono: 'A' },
    personal: { label: 'alex.moreno@gmail.com', mono: 'A' },
    demo: { label: 'Demo mail', mono: 'D' },
    none: { label: 'No accounts', mono: '·' },
  };
  function miniMonth() {
    // October 2026 starts on a Thursday; today is Thursday the 29th
    const days = []; for (let d = 27; d <= 30; d++) days.push([d, 'out']); for (let d = 1; d <= 31; d++) days.push([d, '']); for (let d = 1; d <= 7; d++) days.push([d, 'out']);
    let rows = ''; for (let w = 0; w < 6; w++) { rows += '<tr>' + days.slice(w * 7, w * 7 + 7).map(([d, c]) => `<td class="${c} ${!c && d >= 25 && d <= 31 ? 'week' : ''} ${!c && d === 29 ? 'today' : ''}"><span>${d}</span></td>`).join('') + '</tr>'; }
    return `<div class="mini-month"><div class="mm-head">October 2026<button class="btn btn-icon xs" aria-label="Previous month">${icon('chevl', 'sm')}</button><button class="btn btn-icon xs" aria-label="Next month">${icon('chevr', 'sm')}</button></div>
      <table aria-label="October 2026"><thead><tr>${['S', 'M', 'T', 'W', 'T', 'F', 'S'].map(d => `<th>${d}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  function sidebar(el) {
    const active = el.dataset.active || '';
    const counts = el.dataset.counts ? JSON.parse(el.dataset.counts) : {};
    const a = ACCTS[el.dataset.accounts || 'all'];
    const item = ([id, label, ic, href, n, key]) => {
      const c = id in counts ? counts[id] : n;
      return `<a class="nav-item" href="${href}" data-nav="${id}" ${key ? `data-tip="${label}" data-key="${key}"` : ''} ${id === active ? 'aria-current="page"' : ''}>${icon(ic)}<span>${label}</span>${c ? `<span class="count">${c}</span>` : ''}</a>`;
    };
    const groups = NAV.map(g => `<div class="nav-group">${g.head ? `<div class="nav-head">${g.head}</div>` : ''}${g.items.map(item).join('')}</div>`).join('');
    const cal = el.dataset.extra === 'calendar'
      ? `${miniMonth()}<div class="nav-group"><div class="nav-head">Calendars</div>${CALENDARS.map(([n, c]) => `<a class="nav-item" href="#"><span class="swatch" style="background:var(${c})"></span><span>${n}</span></a>`).join('')}</div>`
      : '';
    el.innerHTML = `
      <div class="side-top">
        <button class="acct-switch" data-tip="Switch account"><span class="mono">${a.mono}</span><span class="ellipsis">${a.label}</span>${icon('chevd')}</button>
        <a class="btn btn-icon" href="compose.html" data-tip="New message" data-key="C" aria-label="New message">${icon('compose')}</a>
      </div>
      <nav class="nav" aria-label="Places">${groups}${cal}</nav>
      <div class="sidebar-foot">${STATUS[el.dataset.status || 'synced'] || ''}
        <a class="nav-item" href="settings-appearance.html" data-tip="Settings" data-key="⌘," ${active === 'settings' ? 'aria-current="page"' : ''}>${icon('settings')}<span>Settings</span></a>
        <a class="nav-item" href="shortcuts.html" data-tip="Keyboard shortcuts" data-key="?">${icon('help')}<span>Help</span></a>
      </div>`;
  }

  /* ---------------- Tooltips ---------------- */
  let tipEl, tipTimer, lastClose = 0;
  function tooltips() {
    tipEl = document.createElement('div'); tipEl.className = 'tooltip'; tipEl.setAttribute('role', 'tooltip'); document.body.append(tipEl);
    document.addEventListener('pointerover', e => {
      const t = e.target.closest('[data-tip]'); if (!t) return;
      clearTimeout(tipTimer);
      const show = () => {
        tipEl.innerHTML = `<span>${t.dataset.tip}</span>${t.dataset.key ? t.dataset.key.split(' ').map(k => `<span class="kbd">${k}</span>`).join('') : ''}`;
        const r = t.getBoundingClientRect(); const z = parseFloat(document.body.style.zoom || 1);
        tipEl.style.left = '0px'; tipEl.style.top = '0px'; tipEl.classList.add('is-open');
        const w = tipEl.offsetWidth;
        let x = (r.left + r.width / 2) / 1 - w / 2; x = Math.max(8, Math.min(x, innerWidth / z - w - 8));
        tipEl.style.left = x + 'px'; tipEl.style.top = (r.bottom / 1 + 6) + 'px';
      };
      tipTimer = setTimeout(show, Date.now() - lastClose < 600 ? 0 : 500);
      t.addEventListener('pointerleave', () => { clearTimeout(tipTimer); if (tipEl.classList.contains('is-open')) lastClose = Date.now(); tipEl.classList.remove('is-open'); }, { once: true });
    });
  }

  /* ---------------- Toasts (§7.13) ---------------- */
  function stack() {
    let s = document.querySelector('.toast-stack');
    if (!s) { s = document.createElement('div'); s.className = 'toast-stack'; s.setAttribute('aria-live', 'polite'); (document.querySelector('.main') || document.querySelector('.window')).append(s); }
    return s;
  }
  function toast({ icon: ic = 'check', tone = '', text = '', actions = [], ms } = {}) {
    const s = stack();
    const t = document.createElement('div'); t.className = 'toast float'; t.setAttribute('role', 'status');
    t.innerHTML = `${ic ? icon(ic, tone) : ''}<span>${text}</span>${actions.map(([l, k]) => `<button class="act">${l}${k ? ` <span class="kbd">${k}</span>` : ''}</button>`).join('')}`;
    s.append(t);
    while (s.children.length > 3) s.firstElementChild.remove();
    const life = ms ?? (actions.some(a => a[0] === 'Undo') ? dur('toast-undo') : dur('toast'));
    let timer;
    const arm = () => { timer = setTimeout(() => { t.classList.add('is-leaving'); setTimeout(() => t.remove(), reduced ? 0 : dur('toast-fade')); }, life); };
    t.addEventListener('mouseenter', () => clearTimeout(timer)); t.addEventListener('mouseleave', arm);
    if (life > 0) arm();
    return t;
  }

  /* ---------------- Lists: j/k, triage, picks, undo ---------------- */
  const undoStack = [];
  let holdTimer;
  function rows(list) { return [...list.querySelectorAll('[data-row]')].filter(r => !r.classList.contains('is-gone') && !r.classList.contains('is-held')); }
  function setCursor(list, row, opts = {}) {
    list.querySelectorAll('[data-row].is-cursor').forEach(r => { r.classList.remove('is-cursor'); r.removeAttribute('aria-selected'); });
    if (!row) return;
    row.classList.add('is-cursor'); row.setAttribute('aria-selected', 'true');
    if (!opts.noScroll) row.scrollIntoView({ block: 'nearest' });
    list.dispatchEvent(new CustomEvent('cursor', { detail: { row, index: rows(list).indexOf(row) } }));
  }
  function moveCursor(list, d) {
    const rs = rows(list); const i = rs.findIndex(r => r.classList.contains('is-cursor'));
    const n = rs[Math.max(0, Math.min(rs.length - 1, (i < 0 ? 0 : i + d)))]; setCursor(list, n);
  }
  function closeGaps(list) {
    const items = [...list.querySelectorAll(':scope > *, :scope > * > *')].filter(el => !el.classList.contains('is-held'));
    const first = new Map(items.map(el => [el, el.getBoundingClientRect().top]));
    list.querySelectorAll('.is-held').forEach(el => { el.classList.remove('is-held'); el.classList.add('is-gone'); el.style.display = 'none'; });
    if (reduced) return;
    items.forEach(el => { const d = first.get(el) - el.getBoundingClientRect().top; if (Math.abs(d) > 0.5) el.animate([{ transform: `translateY(${d}px)` }, { transform: 'none' }], { duration: dur('close'), easing: css('--ease-out') }); });
  }
  function triage(list, row, kind) {
    if (!row || row.dataset.noTriage !== undefined) return;
    const rs = rows(list); const i = rs.indexOf(row);
    const next = rs[i + 1] || rs[i - 1];
    // State commits first, focus moves in the same event, the ghost animates after (§5)
    row.classList.remove('is-cursor');
    row.classList.add(kind === 'later' ? 'is-leaving-later' : 'is-leaving-done');
    setTimeout(() => { row.classList.remove('is-leaving-done', 'is-leaving-later'); row.classList.add('is-held'); row.style.visibility = 'hidden'; }, reduced ? dur('reduced') : dur('carry'));
    setCursor(list, next);
    undoStack.push({ list, row, kind });
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => closeGaps(list), 450);
    const who = row.querySelector('.sender')?.textContent || 'Email';
    if (kind === 'done') toast({ icon: 'check', tone: 'c-hill', text: 'Done', actions: [['Undo', 'Z']] });
    else if (kind === 'later') toast({ icon: 'clock', tone: 'c-dusk', text: 'Moved to Later', actions: [['Set a date', 'D'], ['Undo', 'Z']] });
    else if (kind === 'trash') toast({ icon: 'trash', text: 'Moved to Trash', actions: [['Undo', 'Z']] });
    list.dispatchEvent(new CustomEvent('triage', { detail: { row, kind, who } }));
  }
  function undo() {
    const u = undoStack.pop(); if (!u) return false;
    clearTimeout(holdTimer);
    u.row.classList.remove('is-gone', 'is-held'); u.row.style.display = ''; u.row.style.visibility = '';
    u.row.classList.remove('arrive'); void u.row.offsetWidth; u.row.classList.add('arrive');
    setCursor(u.list, u.row);
    toast({ icon: 'undo', text: 'Undone' , ms: dur('toast') });
    u.list.dispatchEvent(new CustomEvent('undo', { detail: u }));
    return true;
  }
  function pick(list, row) {
    if (!row) return;
    row.classList.toggle('is-picked');
    const n = list.querySelectorAll('.is-picked').length;
    list.classList.toggle('has-picks', n > 0);
    document.dispatchEvent(new CustomEvent('picks', { detail: { list, n } }));
  }
  function clearPicks(list) { list.querySelectorAll('.is-picked').forEach(r => r.classList.remove('is-picked')); list.classList.remove('has-picks'); document.dispatchEvent(new CustomEvent('picks', { detail: { list, n: 0 } })); }

  /* ---------------- Keys ---------------- */
  const handlers = [];
  const inField = e => e.target.closest('input, textarea, [contenteditable="true"]');
  const ROUTES = { '1': 'home.html', '2': 'later.html', '3': 'inbox.html', '4': 'empty.html?state=drafts', '5': 'inbox.html', '6': 'calendar-week.html', '7': 'empty.html?state=trash', '8': 'empty.html?state=spam' };
  function go(href) { if (href && href !== '#') location.href = href; }
  function onKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Meta') html.classList.add('cmd-held');
    for (const h of handlers) if (h(e) === true) { e.preventDefault(); return; }
    if (e.metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); return go('palette.html'); }
    if (e.metaKey && e.key === ',') { e.preventDefault(); return go('settings-appearance.html'); }
    if (e.metaKey && e.key.toLowerCase() === 'j') { const d = document.querySelector('.dock'); e.preventDefault(); return d ? toggleDock(d) : go('ask.html'); }
    if (e.ctrlKey && ROUTES[e.key]) { e.preventDefault(); return go(ROUTES[e.key]); }
    if (e.key === 'Escape') {
      const list = document.querySelector('[data-list].has-picks'); if (list) { clearPicks(list); return; }
      if (inField(e)) { e.target.blur(); return; }
      if (html.dataset.esc) return go(html.dataset.esc);
      return;
    }
    if (inField(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    const list = document.querySelector('[data-list]');
    const cur = list && list.querySelector('[data-row].is-cursor');
    const k = e.key;
    if (list && html.dataset.window !== 'onboarding') {
      if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); return moveCursor(list, 1); }
      if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); return moveCursor(list, -1); }
      if ((k === 'Enter' || k === 'o') && cur) { if (cur.dataset.href) { e.preventDefault(); return go(cur.dataset.href); } }
      if (k === 'e') return triage(list, cur, 'done');
      if (k === 'l') return triage(list, cur, 'later');
      if (k === '#') return triage(list, cur, 'trash');
      if (k === 'x') return pick(list, cur);
      if (k === 'X') { e.preventDefault(); rows(list).forEach(r => r.classList.contains('is-picked') || pick(list, r)); return; }
      if (k === 'd' && cur) return go('later-picker.html');
    }
    if (k === 'z') return undo();
    if (k === '/') { e.preventDefault(); return go('search.html'); }
    if (k === '?') return go('shortcuts.html');
    if (k === 'c') return go('compose.html');
    if (k === 'a') { const f = document.querySelector('.dock .ask-field textarea, .dock .ask-field input'); if (f) { e.preventDefault(); f.focus(); return; } return go('ask.html'); }
    if (k === 'A') return go('ask.html?state=today');
  }
  function toggleDock(d) {
    if (d.hidden) { d.hidden = false; d.classList.remove('is-closing'); const i = d.querySelector('.dock-inner'); if (i) { i.style.animation = 'none'; void i.offsetWidth; i.style.animation = ''; } return; }
    d.classList.add('is-closing'); setTimeout(() => { d.hidden = true; d.classList.remove('is-closing'); }, reduced ? 0 : dur('dock-out'));
  }

  /* ---------------- Sky scene + app icon ---------------- */
  function sky(el) { el.remove(); }  // revision 2: the drawn sky is gone
  let iconN = 0;
  function appIcon(el) {
    const id = 'ai' + (iconN++);
    el.innerHTML = `<svg viewBox="0 0 120 120" class="app-icon" role="img" aria-label="Aplos icon: a striped letter over a green hill under a clear sky">
      <defs>
        <linearGradient id="${id}s" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--icon-sky-top)"/><stop offset="1" stop-color="var(--icon-sky-bottom)"/></linearGradient>
        <pattern id="${id}p" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="3" height="10" fill="var(--icon-post-red)"/><rect x="5" width="3.6" height="10" fill="var(--icon-post-blue)"/></pattern>
        <clipPath id="${id}c"><rect width="120" height="120" rx="27"/></clipPath>
      </defs>
      <g clip-path="url(#${id}c)">
        <rect width="120" height="120" fill="url(#${id}s)"/>
        <path d="M14 34 C 34 26, 52 40, 80 30" fill="none" stroke="var(--icon-wind)" stroke-width="1.6" stroke-linecap="round"/>
        <path d="M0 96 C 26 84, 58 82, 84 90 S 112 96, 120 92 V120 H0Z" fill="var(--icon-hill-far)"/>
        <path d="M0 104 C 30 94, 64 96, 92 104 S 114 108, 120 106 V120 H0Z" fill="var(--icon-hill)"/>
        <g transform="translate(60 58) rotate(-11)">
          <rect x="-34" y="-22" width="68" height="44" rx="4" fill="url(#${id}p)"/>
          <rect x="-30" y="-18" width="60" height="36" rx="2" fill="var(--icon-paper)"/>
          <path d="M-22 -8 h22 M-22 -2 h16 M-22 4 h19" stroke="var(--icon-lines)" stroke-width="2" stroke-linecap="round"/>
          <rect x="14" y="-12" width="10" height="12" rx="1.5" fill="none" stroke="var(--icon-post-blue)" stroke-width="1.6"/>
        </g>
      </g>
    </svg>`;
  }

  /* ---------------- Mockup control bar ---------------- */
  function mockbar() {
    const bar = document.createElement('div'); bar.className = 'mockbar float';
    const t = html.dataset.theme;
    const link = s => { const u = new URL(location.href); u.searchParams.set('state', s); return u.pathname.split('/').pop() + u.search; };
    bar.innerHTML = `<a href="index.html">${icon('chevl')} Gallery</a><span class="sep"></span>
      <button data-theme-set="light" class="${t === 'light' ? 'on' : ''}">${icon('sun')} Light</button><button data-theme-set="dark" class="${t === 'dark' ? 'on' : ''}">${icon('moon')} Dark</button>
      ${states.length > 1 ? `<span class="sep"></span>${states.map(s => `<a href="${link(s)}" class="${s === state ? 'on' : ''}">${s}</a>`).join('')}` : ''}
      <span class="sep"></span><button data-hints class="${html.classList.contains('show-hints') ? 'on' : ''}" title="Show all key hints">${icon('keyboard')}</button>`;
    bar.addEventListener('click', e => {
      const b = e.target.closest('[data-theme-set]');
      if (b) { setTheme(b.dataset.themeSet); bar.querySelectorAll('[data-theme-set]').forEach(x => x.classList.toggle('on', x === b)); }
      if (e.target.closest('[data-hints]')) { html.classList.toggle('show-hints'); e.target.closest('[data-hints]').classList.toggle('on'); }
    });
    document.body.append(bar);
  }
  function setTheme(t) {
    html.classList.add('theme-switching'); html.dataset.theme = t;
    try { localStorage.setItem('aplos-mock-theme', t); } catch {}
    requestAnimationFrame(() => requestAnimationFrame(() => html.classList.remove('theme-switching')));
  }
  function fit() {
    if (html.classList.contains('shot')) return;
    const w = document.querySelector('.window'); if (!w) return;
    const s = Math.min(1, (innerWidth - 32) / w.offsetWidth, (innerHeight - 32) / w.offsetHeight);
    document.body.style.zoom = s < 1 ? s : '';
  }

  window.Mock = { toast, onKey: h => handlers.push(h), dur, css, reduced, state, states, icon, setCursor, moveCursor, triage, undo, rows, closeGaps, go, toggleDock, sky, appIcon, setTheme };

  document.addEventListener('DOMContentLoaded', () => {
    sprite();
    document.querySelectorAll('.traffic').forEach(t => { t.innerHTML = '<i></i><i></i><i></i>'; t.setAttribute('aria-hidden', 'true'); });
    document.querySelectorAll('.sidebar[data-active]').forEach(sidebar);
    document.querySelectorAll('.skyscene').forEach(sky);
    document.querySelectorAll('[data-app-icon]').forEach(appIcon);
    document.querySelectorAll('[data-list]').forEach(list => {
      const c = list.querySelector('[data-row].is-cursor') || rows(list)[0];
      if (c && !list.hasAttribute('data-no-initial')) setCursor(list, c, { noScroll: true });
      list.addEventListener('click', e => { const r = e.target.closest('[data-row]'); if (r && !e.target.closest('button, a')) setCursor(list, r); });
      list.addEventListener('dblclick', e => { const r = e.target.closest('[data-row]'); if (r?.dataset.href) go(r.dataset.href); });
      list.addEventListener('click', e => {
        const b = e.target.closest('[data-act]'); if (!b) return; const r = b.closest('[data-row]');
        e.stopPropagation(); triage(list, r, b.dataset.act);
      });
    });
    // the calendar button sits top right of the main pane, next to Ask (owner, revision 2b)
    document.querySelectorAll('.main > .toolbar .tools').forEach(t => {
      if (t.querySelector('[data-today]')) return;
      t.insertAdjacentHTML('beforeend', `<a class="btn btn-icon" data-today href="ask.html?state=today" data-tip="Today" data-key="⇧A" aria-label="Today" ${location.pathname.endsWith('ask.html') && state === 'today' ? 'aria-pressed="true"' : ''}>${icon('today')}</a>`);
    });
    if ((document.querySelector('.sidebar')?.dataset.accounts || 'all') !== 'all') html.classList.add('one-account');
    document.querySelectorAll('.workspace').forEach(w => { const t = w.previousElementSibling; if (t?.classList.contains('toolbar')) w.addEventListener('scroll', () => t.classList.toggle('is-scrolled', w.scrollTop > 2), { passive: true }); });
    tooltips(); mockbar(); fit();
    addEventListener('resize', fit);
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', e => { if (e.key === 'Meta') html.classList.remove('cmd-held'); });
    addEventListener('blur', () => html.classList.remove('cmd-held'));
  });
})();
