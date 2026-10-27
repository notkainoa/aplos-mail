/* Home, drawn behind overlays (compose, ask, palette, shortcuts).
   Shared by the MAIL CORE overlay pages only. Mirrors home.html (same items, same rows, same focus letter)
   with the minimum behaviour that keeps it usable: j/k move, E/L commit, Z undo, Space/Return open.
   Usage: HomeBackdrop.mount(document.getElementById('home'), { focus: 1, keys: true, quiet: false });
   quiet: true draws the focus letter's Space action as a text button, so another surface can own the one filled button.
   All values are tokens; the style block below is injected once. */
(function () {
  const css = `
    .column { position: relative; padding-top: var(--space-1); }
    /* INVENTED: Home uses a 140 px sender column (same value as home.html), narrower than the shell default */
    .home-row { --sender-w: var(--sender-w-home); cursor: default; }
    .home-row .chip { margin-right: var(--space-1); }
  `;
  const style = document.createElement('style'); style.textContent = css; document.head.append(style);

  const ITEMS = [
    { sec: 'new', sender: 'Jordan Park', unread: 1, date: '10:00 AM', act: ['reply', 'Reply'], href: 'reply.html',
      sum: 'Two layout directions for the Hollow Creek site are ready, and Jordan wants your pick by tomorrow so the build can start Monday.' },
    { sec: 'new', sender: 'Drew Bell', unread: 1, date: 'Yesterday', act: ['paperclip', 'View invoice'],
      sum: 'October illustrations are finished. Approve the $1,840 invoice to close out the month.' },
    { sec: 'new', sender: 'Maple Library', unread: 1, date: 'Yesterday', act: ['clock', 'Remind me Saturday'],
      sum: 'Two holds are waiting at the front desk until Saturday: “The Overstory” and a field guide to mosses.' },
    { sec: 'new', sender: 'Leah Okafor', date: 'Tuesday', act: ['reply', 'Reply with a spot'],
      sum: 'Lunch for six on Friday. Leah asks you to pick somewhere quiet with vegetarian options.' },
    { sec: 'new', sender: 'Rowan Pottery', date: 'Tuesday', act: ['reply', 'Reply to reserve'],
      sum: 'A seat opened in the Tuesday evening wheel class. Reply by Sunday to keep it.' },
    { sec: 'new', sender: 'Sami Haddad', date: 'Monday', act: ['paperclip', 'View lease'],
      sum: 'The lease renewal is attached and needs your signature by November 4. Rent stays the same.' },
    { sec: 'low' },
    { sec: 'due', sender: 'Northwind Dental', date: 'Oct 22', due: 'Due today', act: ['calendar', 'Add to calendar'],
      sum: 'Your cleaning is Thursday at 9:30 AM. Confirm or reschedule by today.' },
    { sec: 'due', sender: 'Priya Raman', date: 'Oct 23', due: 'Due today', act: ['reply', 'Reply'],
      sum: 'Priya needs the revised deck today so she can review it before Friday’s meeting.' },
    { sec: 'wait', sender: 'To Studio Kettle', date: 'Oct 24', act: ['reply', 'Write a nudge'],
      sum: 'You sent the signed statement of work. No reply in four days.' },
  ];
  const SECTIONS = {
    new: ['New', `<button class="btn btn-text" data-tip="Open each letter in turn">Go one by one <span class="kbd hint">S</span></button>`],
    due: ['Due now', `<button class="btn btn-text">Clear from Home</button>`],
    wait: ['Waiting on others', ''],
  };

  function mount(el, opts = {}) {
    const ic = Mock.icon;
    const items = ITEMS.map((x, i) => ({ ...x, id: i }));
    let focus = opts.focus ?? 1;
    const undoBuf = [];

    const row = (it, dist) => {
      if (it.sec === 'low') return `<div class="low-band ${dist === 0 ? 'is-cursor' : ''}" data-row role="option"><span class="label">Low importance</span><span class="names">Parcel Trail, Field Notes, Cedar Market and 3 more</span><span class="n">6</span></div>`;
      const ramp = dist <= 2 ? 'near' : 'far';
      return `<div class="row home-row ${it.unread ? 'unread' : ''} ${ramp}" data-row data-i="${it.id}" role="option">
        <span class="dot"></span><span class="sender ellipsis">${it.sender}</span>
        <span class="line">${it.due ? `<span class="chip due">${ic('clock')}${it.due}</span>` : ''}<span class="ellipsis">${it.sum}</span></span>
        <span class="meta">${it.date}</span></div>`;
    };
    const letter = it => `<article class="paper focus-letter" data-row data-i="${it.id}" role="option" aria-selected="true" aria-label="${it.sender}">
      <div class="meta-line"><span class="sender">${it.sender}</span>${it.due ? `<span class="chip overdue">${ic('clock')}${it.due}</span>` : ''}<span class="date">${it.date}</span></div>
      <p class="summary t-summary">${it.sum}</p>
      <div class="actions">
        <button class="btn ${opts.quiet ? 'btn-text' : 'btn-filled'} md" data-go="space">${ic(it.act[0])}${it.act[1]}${opts.quiet ? '' : '<span class="kbd">Space</span>'}</button>
        <button class="btn btn-text md" data-go="later">${ic('clock')}Later<span class="kbd hint">L</span></button>
        <button class="btn btn-text md" data-go="done">${ic('check')}Done<span class="kbd hint">E</span></button>
        <button class="btn btn-icon md" data-tip="Bookmark" data-key="B" aria-label="Bookmark">${ic('bookmark')}</button>
        <button class="btn btn-icon md" data-tip="More" data-key="." aria-label="More">${ic('more')}</button>
      </div></article>`;

    function render() {
      let html = '', last = null;
      items.forEach((it, i) => {
        if (it.sec !== last && SECTIONS[it.sec]) {
          const n = items.filter(x => x.sec === it.sec).length;
          html += `<div class="section-head"><span class="label">${SECTIONS[it.sec][0]}</span><span class="n">${n}</span>${SECTIONS[it.sec][1]}</div>`;
        }
        last = it.sec;
        html += i === focus && it.sec !== 'low' ? letter(it) : row(it, Math.abs(i - focus));
      });
      el.innerHTML = html;
    }
    function move(d) { focus = Math.max(0, Math.min(items.length - 1, focus + d)); render(); }
    function commit(kind) {
      const it = items[focus]; if (!it || it.sec === 'low') return;
      items.splice(focus, 1);
      if (focus >= items.length) focus = items.length - 1;
      if (items[focus]?.sec === 'low') focus = Math.min(items.length - 1, focus + 1);
      render();
      undoBuf.push({ it, at: focus });
      if (kind === 'done') Mock.toast({ icon: 'check', tone: 'c-hill', text: 'Done', actions: [['Undo', 'Z']] });
      else Mock.toast({ icon: 'clock', tone: 'c-dusk', text: 'Moved to Later', actions: [['Set a date', 'D'], ['Undo', 'Z']] });
    }
    el.addEventListener('click', e => {
      const b = e.target.closest('[data-go]');
      if (b) { const g = b.dataset.go; if (g === 'done' || g === 'later') commit(g); else Mock.go(items[focus].href || 'reader.html'); return; }
      const r = e.target.closest('[data-row]');
      if (r && !r.classList.contains('focus-letter')) { focus = [...el.querySelectorAll('[data-row]')].indexOf(r); render(); }
    });
    if (opts.keys !== false) {
      Mock.onKey(e => {
        if (e.target.closest('input,textarea,[contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
        if (opts.enabled && !opts.enabled()) return;
        const k = e.key;
        if (k === 'j' || k === 'ArrowDown') { move(1); return true; }
        if (k === 'k' || k === 'ArrowUp') { move(-1); return true; }
        if (k === 'e') { commit('done'); return true; }
        if (k === 'l') { commit('later'); return true; }
        if (k === 'z') { const u = undoBuf.pop(); if (u) { items.splice(u.at, 0, u.it); focus = u.at; render(); Mock.toast({ icon: 'undo', text: 'Undone' }); } return true; }
        if (k === ' ') { Mock.go(items[focus].href || 'reader.html'); return true; }
        if (k === 'Enter' || k === 'o') { Mock.go('reader.html'); return true; }
      });
    }
    render();
    return { render, move, commit, get focus() { return focus; }, get item() { return items[focus]; } };
  }
  window.HomeBackdrop = { mount };
})();
