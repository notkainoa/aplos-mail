/* Shared Home rendering for the state pages (later-picker, errors, toasts, demo).
   Same markup, same classes and same commit motion as home.html; only the data is a parameter.
   Usage (after shell.js, inside the body, before DOMContentLoaded):
     const home = HomeView(document.getElementById('home'), { items, low: { names, n }, noAI, focus, onKey, toasts });
   Items: { sec: 'new'|'due'|'wait'|'low', sender, unread, date, act: [icon, label], href, sum, subj, due, err }
   Tokens only; no raw values. */
(function () {
  const css = document.createElement('style');
  css.textContent = `
    .column { position: relative; padding-top: var(--space-1); }
    .home-row { --sender-w: var(--sender-w-home); cursor: default; }
    .home-row .chip { margin-right: var(--space-1); }
    .ghost-paper { position: absolute; left: 0; right: 0; z-index: 30; pointer-events: none; }
  `;
  document.head.append(css);

  const SECTIONS = {
    new: ['New', `<button class="btn btn-text" data-tip="Open each letter in turn">Go one by one <span class="kbd hint">S</span></button>`],
    due: ['Due now', `<button class="btn btn-text">Clear from Home</button>`],
    wait: ['Waiting on others', ''],
  };


  // Home's dataset (same as home.html), shared by the state pages
  const DEFAULT_ITEMS = [
    { sec: 'new', sender: 'Jordan Park', unread: 1, date: '10:00 AM', act: ['reply', 'Reply'], href: 'reply.html',
      sum: 'Two layout directions for the Hollow Creek site are ready, and Jordan wants your pick by tomorrow so the build can start Monday.',
      subj: 'A quieter home for the Hollow Creek site' },
    { sec: 'new', sender: 'Drew Bell', unread: 1, date: 'Yesterday', act: ['paperclip', 'View invoice'],
      sum: 'October illustrations are finished. Approve the $1,840 invoice to close out the month.',
      subj: 'Invoice #0412 · October illustrations' },
    { sec: 'new', sender: 'Maple Library', unread: 1, date: 'Yesterday', act: ['clock', 'Remind me Saturday'],
      sum: 'Two holds are waiting at the front desk until Saturday: “The Overstory” and a field guide to mosses.',
      subj: 'Items ready for pickup' },
    { sec: 'new', sender: 'Leah Okafor', date: 'Tuesday', act: ['reply', 'Reply with a spot'],
      sum: 'Lunch for six on Friday. Leah asks you to pick somewhere quiet with vegetarian options.',
      subj: 'Friday lunch?' },
    { sec: 'new', sender: 'Rowan Pottery', date: 'Tuesday', act: ['reply', 'Reply to reserve'],
      sum: 'A seat opened in the Tuesday evening wheel class. Reply by Sunday to keep it.',
      subj: 'A seat opened up' },
    { sec: 'new', sender: 'Sami Haddad', date: 'Monday', act: ['paperclip', 'View lease'],
      sum: 'The lease renewal is attached and needs your signature by November 4. Rent stays the same.',
      subj: 'Lease renewal, unit 3B' },
    { sec: 'low' },
    { sec: 'due', sender: 'Northwind Dental', date: 'Oct 22', due: 'Due today', act: ['calendar', 'Add to calendar'],
      sum: 'Your cleaning is Thursday at 9:30 AM. Confirm or reschedule by today.',
      subj: 'Appointment reminder' },
    { sec: 'due', sender: 'Priya Raman', date: 'Oct 23', due: 'Due today', act: ['reply', 'Reply'],
      sum: 'Priya needs the revised deck today so she can review it before Friday’s meeting.',
      subj: 'Re: Q4 review deck' },
    { sec: 'wait', sender: 'To Studio Kettle', date: 'Oct 24', act: ['reply', 'Write a nudge'],
      sum: 'You sent the signed statement of work. No reply in four days.',
      subj: 'Signed SOW attached' },
  ];

  window.HomeView = function (el, o) {
    const ic = Mock.icon;
    const items = o.items.map((x, i) => ({ ...x, id: i }));
    const state = { items, focus: o.focus ?? 1 };
    const noAI = !!o.noAI;
    const low = o.low || { names: 'Parcel Trail, Field Notes, Cedar Market and 3 more', n: 6 };
    const undoBuf = [];
    let hold;
    let live = document.getElementById('live');
    if (!live) { live = document.createElement('p'); live.className = 'sr-only'; live.id = 'live'; live.setAttribute('role', 'status'); (document.querySelector('.main') || document.body).append(live); }

    const text = it => (noAI ? it.subj : it.sum);

    function row(it, dist) {
      if (it.sec === 'low') return `<div class="low-band ${dist === 0 ? 'is-cursor' : ''}" data-row role="option" data-tip="Open low importance" data-key="Return">
        <span class="label">Low importance</span><span class="names">${low.names}</span><span class="n">${low.n}</span></div>`;
      const ramp = dist <= 2 ? 'near' : 'far';
      const line = it.err
        ? `<span class="row-err">${ic('alert')}<span class="ellipsis">${it.err}</span></span><button class="btn btn-text xs" data-retry="${it.id}">Retry</button>`
        : `${it.due ? `<span class="chip due">${ic('clock')}${it.due}</span>` : ''}<span class="ellipsis">${text(it)}</span>`;
      return `<div class="row home-row ${it.unread ? 'unread' : ''} ${it.err ? 'is-error' : ''} ${ramp}" data-row data-i="${it.id}" role="option">
        <span class="dot"></span><span class="sender ellipsis">${it.sender}</span>
        <span class="line">${line}</span>
        <span class="meta">${it.date}</span>
        <span class="row-actions"><button class="btn btn-icon" data-tip="Later" data-key="L" aria-label="Later">${ic('clock')}</button><button class="btn btn-icon" data-tip="Done" data-key="E" aria-label="Done">${ic('check')}</button></span>
      </div>`;
    }
    function letter(it) {
      return `<article class="paper focus-letter" data-row data-i="${it.id}" role="option" aria-selected="true" aria-label="${it.sender}">
        <div class="deal-in" style="display:flex;flex-direction:column;height:100%">
          <div class="meta-line"><span class="sender">${it.sender}</span>${it.due ? `<span class="chip overdue">${ic('clock')}${it.due}</span>` : ''}<span class="date">${it.date}</span></div>
          <p class="summary t-summary">${text(it)}</p>
          <div class="actions">
            <button class="btn btn-filled md" data-go="space">${ic(it.act[0])}${it.act[1]}<span class="kbd">Space</span></button>
            <button class="btn btn-text md" data-go="later" data-later>${ic('clock')}Later<span class="kbd hint">L</span></button>
            <button class="btn btn-text md" data-go="done">${ic('check')}Done<span class="kbd hint">E</span></button>
            <button class="btn btn-icon md" data-tip="Bookmark" data-key="B" aria-label="Bookmark">${ic('bookmark')}</button>
            <button class="btn btn-icon md" data-tip="More" data-key="." aria-label="More">${ic('more')}</button>
          </div>
        </div>
      </article>`;
    }
    function render(opts = {}) {
      let html = '', last = null;
      items.forEach((it, i) => {
        if (it.sec !== last && SECTIONS[it.sec]) {
          const n = items.filter(x => x.sec === it.sec).length;
          html += `<div class="section-head"><span class="label">${SECTIONS[it.sec][0]}</span><span class="n">${n}</span>${SECTIONS[it.sec][1]}</div>`;
        }
        last = it.sec;
        if (opts.holdAt === i) html += `<div class="is-held" style="height:var(--row)"></div>`;
        html += i === state.focus && it.sec !== 'low' ? letter(it) : row(it, Math.abs(i - state.focus));
      });
      el.innerHTML = html;
      if (opts.deal) { const f = el.querySelector('.focus-letter'); f.classList.add('is-dealing'); f.querySelector('.deal-in').style.animationDelay = Mock.dur('commit') + 'ms'; }
      if (o.afterRender) o.afterRender(api);
    }
    function commit(kind, over = {}) {
      const it = items[state.focus]; if (!it || it.sec === 'low') return;
      const paper = el.querySelector('.focus-letter');
      const ghost = paper.cloneNode(true);
      ghost.classList.add('ghost-paper'); ghost.style.top = paper.offsetTop + 'px'; ghost.style.margin = '0';
      const label = { done: 'Done', later: 'Later', trash: 'Trash' }[kind];
      ghost.insertAdjacentHTML('beforeend', `<span class="commit-edge ${kind}"></span><span class="commit-chip ${kind}">${ic(kind === 'done' ? 'check' : kind === 'trash' ? 'trash' : 'clock')}${label}</span>`);
      items.splice(state.focus, 1);
      if (state.focus >= items.length || items[state.focus].sec === 'low' && state.focus === items.length - 1) state.focus = Math.max(0, state.focus - 1);
      if (items[state.focus]?.sec === 'low') state.focus = Math.min(items.length - 1, state.focus + 1);
      render({ deal: true, holdAt: state.focus + 1 });
      el.append(ghost);
      const right = kind !== 'later';
      const dx = parseFloat(Mock.css('--flight-x')) * (right ? 1 : -1), dy = parseFloat(Mock.css('--flight-y')) * (right ? -1 : 1);
      const rot = parseFloat(Mock.css('--flight-rot')) * (right ? 1 : -1);
      const a = Mock.reduced
        ? ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: Mock.dur('reduced'), fill: 'forwards' })
        : ghost.animate([{ transform: 'none', opacity: 1 }, { opacity: 1, offset: .4 }, { transform: `translate(${dx}px, ${dy}px) rotate(${rot}deg)`, opacity: 0 }],
            { duration: Mock.dur('flight'), delay: 40, easing: Mock.css('--ease-carry'), fill: 'forwards' });
      a.onfinish = () => ghost.remove();
      clearTimeout(hold); hold = setTimeout(() => Mock.closeGaps(el), 450);
      const next = items[state.focus];
      live.textContent = `${kind === 'done' ? 'Done' : kind === 'trash' ? 'Moved to Trash' : 'Moved to Later'}. Next: ${next?.sender || 'nothing'}.`;
      if (over.toast) Mock.toast(over.toast);
      else if (kind === 'done') Mock.toast({ icon: 'check', tone: 'c-hill', text: 'Done', actions: it.sec === 'wait' ? [['Remind me if no reply', 'R'], ['Undo', 'Z']] : [['Undo', 'Z']] });
      else if (kind === 'trash') Mock.toast({ icon: 'trash', text: 'Moved to Trash', actions: [['Undo', 'Z']] });
      else Mock.toast({ icon: 'clock', tone: 'c-dusk', text: 'Moved to Later', actions: [['Set a date', 'D'], ['Undo', 'Z']] });
      undoBuf.push({ it, at: items.indexOf(next) < 0 ? items.length : items.indexOf(next) });
      if (o.onCommit) o.onCommit(kind, it, api);
    }
    function move(d) {
      state.focus = Math.max(0, Math.min(items.length - 1, state.focus + d)); render();
      el.querySelector('[aria-selected="true"], .low-band.is-cursor')?.scrollIntoView({ block: 'nearest' });
    }
    const api = { state, items, render, commit, move };

    Mock.onKey(e => {
      if (e.target.closest('input,textarea') || e.metaKey || e.ctrlKey) return;
      if (o.onKey && o.onKey(e, api) === true) return true;
      const k = e.key;
      if (k === 'j' || k === 'ArrowDown') { move(1); return true; }
      if (k === 'k' || k === 'ArrowUp') { move(-1); return true; }
      if (k === 'Tab') { const order = ['new', 'due', 'wait']; const cur = items[state.focus].sec; const i = order.indexOf(cur === 'low' ? 'new' : cur); const t = order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length]; state.focus = items.findIndex(x => x.sec === t); render(); return true; }
      if (k === 'e' || k === 'ArrowRight') { commit('done'); return true; }
      if (k === 'l' || k === 'ArrowLeft') { commit('later'); return true; }
      if (k === '#') { commit('trash'); return true; }
      if (k === 'z') { const u = undoBuf.pop(); if (!u) return true; items.splice(u.at, 0, u.it); state.focus = u.at; render({ deal: true }); Mock.toast({ icon: 'undo', text: 'Undone' }); return true; }
      if (k === ' ') { const it = items[state.focus]; if (it.href) Mock.go(it.href); else Mock.toast({ icon: it.act[0], text: `${it.act[1]}…` }); return true; }
      if (k === 'Enter' || k === 'o') { Mock.go('reader.html'); return true; }
      if (k === 'd') { Mock.go('later-picker.html'); return true; }
      if (k === 's') { Mock.go('reader.html'); return true; }
    });
    el.addEventListener('click', e => {
      const rt = e.target.closest('[data-retry]');
      if (rt) { if (o.onRetry) o.onRetry(+rt.dataset.retry, api); return; }
      const b = e.target.closest('[data-go]');
      if (b) {
        const g = b.dataset.go;
        if (g === 'later' && o.onLaterButton) return o.onLaterButton(api, b);
        if (g === 'done' || g === 'later') commit(g);
        else if (g === 'space') { const it = items[state.focus]; it.href ? Mock.go(it.href) : Mock.toast({ icon: it.act[0], text: `${it.act[1]}…` }); }
        return;
      }
      const r = e.target.closest('[data-row]');
      if (r && !r.classList.contains('focus-letter')) { state.focus = [...el.querySelectorAll('[data-row]')].indexOf(r); render(); }
    });
    el.addEventListener('dblclick', e => { if (e.target.closest('[data-row]')) Mock.go('reader.html'); });
    render();
    return api;
  };
  window.HomeView.DEFAULT_ITEMS = DEFAULT_ITEMS;
})();
