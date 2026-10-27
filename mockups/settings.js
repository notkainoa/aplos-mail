/* Shared helpers for the settings pages. Rows are generated so the four pages cannot drift apart. */
(function () {
  const ic = (n, c = '') => Mock.icon(n, c);
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const NAV = [['General', 'settings-appearance.html', 'settings'], ['Mail', '#', 'mail'], ['Calendar', '#', 'calendar'], ['AI', 'settings-ai.html', 'bubble'], ['Notifications', '#', 'bell'], ['Accounts', 'settings-accounts.html', 'user'], ['Keyboard', 'settings-keyboard.html', 'keyboard'], ['Help & about', '#', 'help']];
  function nav(active) {
    const el = document.getElementById('snav');
    el.innerHTML = `<span class="puck" aria-hidden="true"></span>` + NAV.map(([l, h, i]) => `<a class="nav-item" href="${h}" ${l === active ? 'aria-current="page"' : ''}>${ic(i)}<span>${l}</span></a>`).join('');
    el.setAttribute('aria-label', 'Settings sections');
    el.querySelectorAll('a[href="#"]').forEach(a => a.addEventListener('click', e => e.preventDefault()));
    const cur = el.querySelector('[aria-current="page"]'), puck = el.querySelector('.puck');
    puck.style.transition = 'none'; puck.style.transform = `translateY(${cur.offsetTop}px)`; void puck.offsetWidth; puck.style.transition = '';
    el.addEventListener('pointerdown', e => { const n = e.target.closest('.nav-item'); if (n) puck.style.transform = `translateY(${n.offsetTop}px)`; });
  }

  const page = (title, sub = '') => `<div class="page-head"><div><h1 class="page-title">${title}</h1>${sub ? `<p class="page-sub">${sub}</p>` : ''}</div></div>`;
  const group = (label, body, right = '') => `<div class="section-head"><span class="label">${label}</span>${right}</div>${body}`;
  const row = ({ label, hint = '', control = '', cls = '', tag = '' }) =>
    `<div class="srow ${hint ? 'has-h' : ''} ${cls}"><div><div class="l">${label}${tag ? `<span class="tag">${tag}</span>` : ''}</div>${hint ? `<div class="h">${hint}</div>` : ''}</div><div class="c">${control}</div></div>`;
  /* A folded row: the long text opens beneath it */
  const disclosure = (id, label, hint, body) =>
    `<button class="srow has-h is-disclosure" data-disclose="${id}" aria-expanded="false" aria-controls="${id}"><div><div class="l">${label}</div><div class="h">${hint}</div></div><div class="c">${ic('chevd')}</div></button><div class="privacy" id="${id}" hidden>${body}</div>`;
  const sw = (id, on, label) => `<button class="switch" role="switch" aria-checked="${!!on}" aria-label="${esc(label)}" data-switch="${id}"></button>`;
  const seg = (id, opts, sel) => `<div class="seg" data-seg="${id}" role="tablist" aria-label="${esc(id)}">${opts.map(([v, l]) => `<button role="tab" data-v="${v}" aria-selected="${v === sel}">${l}</button>`).join('')}</div>`;
  const select = (id, value, options, label) => `<button class="select" data-select="${id}" data-options='${esc(JSON.stringify(options))}' aria-haspopup="listbox" aria-expanded="false" aria-label="${esc(label || id)}"><span>${value}</span>${ic('chevd')}</button>`;

  function placePuck(s) {
    let p = s.querySelector('.seg-puck');
    if (!p) { p = document.createElement('span'); p.className = 'seg-puck'; p.setAttribute('aria-hidden', 'true'); s.prepend(p); }
    const sel = s.querySelector('[aria-selected="true"]');
    if (!sel) { p.style.display = 'none'; return; }
    p.style.display = ''; p.style.width = sel.offsetWidth + 'px'; p.style.transform = `translateX(${sel.offsetLeft}px)`;
  }
  function initSegs(root = document) {
    root.querySelectorAll('.seg').forEach(s => { placePuck(s); const p = s.querySelector('.seg-puck'); if (p) { p.style.transition = 'none'; placePuck(s); void p.offsetWidth; p.style.transition = ''; } });
  }

  const pos = (el, anc) => { let x = 0, y = 0; for (let n = el; n && n !== anc; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; } return { x, y }; };
  let menu = null, menuFor = null;
  function closeMenu() { if (!menu) return false; menu.remove(); menuFor?.setAttribute('aria-expanded', 'false'); menu = menuFor = null; return true; }
  function openMenu(btn) {
    closeMenu();
    const ws = document.querySelector('.workspace');
    const opts = JSON.parse(btn.dataset.options);
    const cur = btn.querySelector('span').textContent;
    menu = document.createElement('div');
    menu.className = 'float menu set-menu reveal'; menu.setAttribute('role', 'listbox');
    menu.innerHTML = opts.map(o => `<button class="menu-item" role="option" aria-selected="${o === cur}" data-o="${esc(o)}"><span class="ck">${o === cur ? ic('check') : ''}</span>${o}</button>`).join('');
    ws.append(menu); menuFor = btn; btn.setAttribute('aria-expanded', 'true');
    const p = pos(btn, ws);
    menu.style.left = Math.max(0, p.x + btn.offsetWidth - menu.offsetWidth) + 'px';
    menu.style.top = (p.y + btn.offsetHeight + parseFloat(Mock.css('--space-1'))) + 'px';
  }

  document.addEventListener('click', e => {
    const dz = e.target.closest('[data-disclose]');
    if (dz) { const open = dz.getAttribute('aria-expanded') !== 'true'; dz.setAttribute('aria-expanded', String(open)); document.getElementById(dz.dataset.disclose).hidden = !open; return; }
    const s = e.target.closest('.switch[role="switch"]');
    if (s) { const on = s.getAttribute('aria-checked') !== 'true'; s.setAttribute('aria-checked', String(on)); document.dispatchEvent(new CustomEvent('settings:switch', { detail: { id: s.dataset.switch, on, el: s } })); return; }
    const b = e.target.closest('.seg[data-seg] button');
    if (b) { const g = b.closest('.seg'); g.querySelectorAll('button').forEach(x => x.setAttribute('aria-selected', String(x === b))); placePuck(g); document.dispatchEvent(new CustomEvent('settings:seg', { detail: { id: g.dataset.seg, v: b.dataset.v } })); return; }
    const sel = e.target.closest('.select[data-select]');
    if (sel) { menuFor === sel ? closeMenu() : openMenu(sel); return; }
    const o = e.target.closest('.set-menu [data-o]');
    if (o) { const btn = menuFor; btn.querySelector('span').textContent = o.dataset.o; document.dispatchEvent(new CustomEvent('settings:select', { detail: { id: btn.dataset.select, v: o.dataset.o, el: btn } })); closeMenu(); return; }
    closeMenu();
  });
  Mock.onKey(e => { if (e.key === 'Escape' && closeMenu()) return true; });

  window.S = { nav, page, group, row, disclosure, sw, seg, select, initSegs, placePuck, esc, closeMenu };
})();
