/* Calendar data and renderers shared by calendar-week.html, calendar-day.html, calendar-event.html.
   Fictional world only. Today is Thursday, October 29, 2026, 10:00 AM. */
(function () {
  const ic = (n, c = '') => Mock.icon(n, c);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const pad = n => String(n).padStart(2, '0');
  const D = (y, m, d) => new Date(y, m - 1, d);
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const add = (d, n) => D(d.getFullYear(), d.getMonth() + 1, d.getDate() + n);
  const sameDay = (a, b) => iso(a) === iso(b);
  const TODAY = D(2026, 10, 29);
  const NOW = 10; // 10:00 AM
  const H0 = 8, H1 = 20; // grid shows 8 AM to 8 PM

  const CALS = {
    work: { name: 'Work', c: '--tag-hill' },
    personal: { name: 'Personal', c: '--tag-sky' },
    hollow: { name: 'Hollow Creek', c: '--tag-ember' },
    family: { name: 'Family', c: '--tag-sand' },
  };

  // s/e are 'H:MM' in 24 h
  const FIXED = [
    { id: 'brunch', t: 'Brunch with Mom', cal: 'family', date: '2026-10-25', s: '10:00', e: '11:30' },
    { id: 'samples', t: 'Type samples with Mina', cal: 'hollow', date: '2026-10-26', s: '13:00', e: '14:00' },
    { id: 'planning', t: 'Hollow Creek planning', cal: 'hollow', date: '2026-10-27', s: '10:30', e: '11:30' },
    { id: 'pottery', t: 'Pottery wheel class', cal: 'personal', date: '2026-10-27', s: '18:30', e: '20:00' },
    { id: 'focus', t: 'Focus time', cal: 'work', date: '2026-10-28', s: '10:00', e: '12:00' },
    { id: 'sami', t: 'Call Sami about the lease', cal: 'personal', date: '2026-10-28', s: '15:00', e: '15:30' },
    { id: 'dental', t: 'Northwind Dental', cal: 'personal', date: '2026-10-29', s: '9:30', e: '10:30' },
    { id: 'design', t: 'Design review with Mina and Jordan', cal: 'hollow', date: '2026-10-29', s: '14:00', e: '14:30', own: true },
    { id: 'climb', t: 'Climbing with Theo', cal: 'personal', date: '2026-10-29', s: '17:30', e: '19:00', own: true },
    { id: 'q4', t: 'Q4 review', cal: 'work', date: '2026-10-30', s: '11:00', e: '12:00' },
    { id: 'lunch', t: 'Lunch with Leah', cal: 'personal', date: '2026-10-30', s: '12:30', e: '13:30', own: true },
    { id: 'launch', t: 'Hollow Creek launch prep', cal: 'hollow', date: '2026-10-30', s: '15:00', e: '16:30', plan: true },
    { id: 'garden', t: 'Garden shift with Ana', cal: 'personal', date: '2026-10-31', s: '10:00', e: '12:00', own: true },
    { id: 'lease', t: 'Lease renewal due', cal: 'personal', date: '2026-11-04', s: '9:00', e: '9:30' },
    { id: 'dinner', t: 'Birthday dinner for Mom', cal: 'family', date: '2026-11-07', s: '19:00', e: '21:00' },
  ];
  const EXTRA_OVERLAP = [{ id: 'oneone', t: '1:1 with Mina', cal: 'hollow', date: '2026-10-28', s: '11:00', e: '11:45' }];
  const standup = d => ({ id: 'standup-' + iso(d), t: 'Standup', cal: 'work', date: iso(d), s: '11:00', e: '11:15', own: true, base: 'standup' });

  const INFO = {
    design: {
      video: 'meet.fernworks.studio/design-review',
      guests: [['Alex Moreno', 'going', 'you, organizer'], ['Mina Cho', 'going'], ['Jordan Park', 'going']],
      desc: 'Walk through the two layout directions and pick one. Jordan needs a decision by Friday so the build can start Monday.',
    },
    q4: {
      video: 'meet.fernworks.studio/q4-review',
      guests: [['Priya Raman', 'going', 'organizer'], ['Mina Cho', 'maybe'], ['Alex Moreno', 'none', 'you']],
      desc: 'Walk through the Q4 deck and agree next quarter’s priorities. Bring the revised numbers.',
      invite: { from: 'Priya Raman' },
    },
    dental: { place: 'Northwind Dental, 14 Alder Street', desc: 'Cleaning. Arrive five minutes early.' },
    climb: { place: 'The climbing gym on Mill Road', guests: [['Alex Moreno', 'going', 'you, organizer'], ['Theo Lindqvist', 'going']] },
    lunch: { place: 'Somewhere quiet, still to pick', guests: [['Alex Moreno', 'going', 'you, organizer'], ['Leah Okafor', 'going']], desc: 'Lunch for six. Leah asked for vegetarian options.' },
    standup: { video: 'meet.fernworks.studio/standup', guests: [['Priya Raman', 'going', 'organizer'], ['Mina Cho', 'going'], ['Alex Moreno', 'going', 'you']] },
    launch: { desc: 'Found in Jordan Park’s email: “If we lock it by Friday, Mina can start the build on Monday.” Nothing is added until you confirm.' },
  };

  const hm = s => { const [h, m] = s.split(':').map(Number); return h + m / 60; };
  const meridiem = h => h >= 12 ? 'PM' : 'AM';
  const h12 = h => ((h + 11) % 12) + 1;
  const clock = s => { const [h, m] = s.split(':').map(Number); return `${h12(h)}:${pad(m)}`; };
  const timeFull = s => `${clock(s)} ${meridiem(+s.split(':')[0])}`;
  const range = (s, e) => meridiem(+s.split(':')[0]) === meridiem(+e.split(':')[0]) ? `${clock(s)} – ${clock(e)} ${meridiem(+e.split(':')[0])}` : `${timeFull(s)} – ${timeFull(e)}`;
  const longDay = d => `${DAYS[d.getDay()]}, ${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const dayTitle = d => `${longDay(d)}, ${d.getFullYear()}`;
  const weekStart = d => add(d, -d.getDay());
  const short = d => MONTHS[d.getMonth()].slice(0, 3);
  /* The big title is always the month; a week that crosses two months names both. The subtitle holds the range. */
  const weekTitle = s => {
    const e = add(s, 6);
    if (s.getMonth() === e.getMonth()) return `${MONTHS[s.getMonth()]} ${s.getFullYear()}`;
    return s.getFullYear() === e.getFullYear() ? `${short(s)} – ${short(e)} ${e.getFullYear()}` : `${short(s)} ${s.getFullYear()} – ${short(e)} ${e.getFullYear()}`;
  };
  const weekSub = s => {
    const e = add(s, 6);
    return s.getMonth() === e.getMonth() ? `${MONTHS[s.getMonth()]} ${s.getDate()} – ${e.getDate()}` : `${short(s)} ${s.getDate()} – ${short(e)} ${e.getDate()}`;
  };
  const monthTitle = d => `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
  const monthSub = (y, m) => { let n = 0; for (let i = 1; i <= 31; i++) { const d = D(y, m, i); if (d.getMonth() === m - 1) n += eventsOn(d).length; } return `${n} events`; };

  function eventsOn(d, opts = {}) {
    const k = iso(d);
    const list = FIXED.filter(e => e.date === k);
    if (opts.overlap) list.push(...EXTRA_OVERLAP.filter(e => e.date === k));
    const dow = d.getDay();
    if (dow >= 1 && dow <= 4 && d >= D(2026, 10, 5)) list.push(standup(d));
    return list.map(e => ({ ...e, d: hm(e.e) - hm(e.s), at: hm(e.s) }));
  }
  const findEvent = (id, opts) => {
    for (let n = -10; n < 45; n++) { const hit = eventsOn(add(D(2026, 10, 18), n), opts).find(e => e.id === id); if (hit) return hit; }
  };

  /* Lanes: overlapping events share a column; beyond maxLanes the rest fold into one "+N" stack. */
  function layout(evs, maxLanes) {
    const list = [...evs].sort((a, b) => a.at - b.at || b.d - a.d);
    const out = { items: [], stacks: [] };
    let cluster = [], end = -1;
    const flush = () => {
      if (!cluster.length) return;
      const lanesEnd = [];
      cluster.forEach(e => {
        let i = lanesEnd.findIndex(x => x <= e.at + 1e-6);
        if (i < 0) { i = lanesEnd.length; lanesEnd.push(0); }
        lanesEnd[i] = e.at + e.d; e.lane = i;
      });
      const n = lanesEnd.length;
      if (n <= maxLanes) cluster.forEach(e => out.items.push({ ev: e, lane: e.lane, lanes: n }));
      else {
        const folded = cluster.filter(e => e.lane >= maxLanes - 1);
        cluster.filter(e => e.lane < maxLanes - 1).forEach(e => out.items.push({ ev: e, lane: 0, lanes: 1, beside: true }));
        const s = Math.min(...folded.map(e => e.at)), t = Math.max(...folded.map(e => e.at + e.d));
        out.stacks.push({ evs: folded, at: s, d: t - s });
      }
      cluster = []; end = -1;
    };
    list.forEach(e => { if (e.at >= end - 1e-6) flush(); cluster.push(e); end = Math.max(end, e.at + e.d); });
    flush();
    return out;
  }

  const labelTime = ev => `${range(ev.s, ev.e)}`;
  function evHTML(it, { wide, selected }) {
    const e = it.ev, cal = CALS[e.cal];
    const tiny = e.d < 0.5, compact = e.d < 1;   // under 30 min: one line, title only; under an hour: one line
    const cls = ['ev', !e.plan && compact ? 'one' : '', e.plan ? 'is-plan' : '', it.beside ? 'beside' : '', selected === e.id ? 'is-selected' : ''].filter(Boolean).join(' ');
    const style = `--cal:var(${cal.c});--s:${e.at - H0};--d:${e.d};--lane:${it.lane};--lanes:${it.lanes}`;
    const lab = `${e.t}, ${labelTime(e)}, ${e.plan ? 'found in mail, not added yet' : cal.name}`;
    const place = INFO[e.base || e.id]?.place;
    let inner;
    if (e.plan) inner = `<span class="t">${e.t}</span><span class="from">${ic('mail', 'sm')}From mail</span>`;
    else if (tiny) inner = `<span class="t">${e.t}</span>`;
    else if (compact) inner = `<span class="t">${e.t}</span>${wide ? `<span class="w">${range(e.s, e.e)}</span>` : ''}`;
    else inner = `<span class="t">${e.t}</span><span class="w">${wide && place ? range(e.s, e.e) + ' · ' + place : range(e.s, e.e)}</span>`;
    return `<button class="${cls}" style="${style}" data-id="${e.id}" aria-label="${lab}" ${selected === e.id ? 'aria-pressed="true"' : ''}>${inner}</button>`;
  }
  function stackHTML(st, i, date) {
    const cal = CALS[st.evs[0].cal];
    return `<button class="ev-stack" style="--cal:var(${cal.c});--s:${st.at - H0};--d:${st.d}" data-stack="${date}:${i}" aria-expanded="false" aria-label="${st.evs.length} more events at ${timeFull(st.evs[0].s)}">+${st.evs.length}</button>`;
  }

  function hoursHTML() {
    let s = '';
    for (let h = H0; h <= H1; h++) s += `<span class="hl" style="--h:${h - H0}">${h12(h)} ${meridiem(h)}</span>`;
    return `<div class="hours">${s}</div>`;
  }
  function colHTML(d, o) {
    const today = sameDay(d, TODAY);
    const lay = layout(eventsOn(d, o), o.maxLanes);
    return `<div class="col ${today ? 'today' : ''} ${o.wide ? 'wide' : ''}" data-date="${iso(d)}">${lay.items.map(it => evHTML(it, o)).join('')}${lay.stacks.map((s, i) => stackHTML(s, i, iso(d))).join('')}${today ? `<span class="now" style="--now:${NOW - H0}" aria-hidden="true"></span>` : ''}</div>`;
  }
  function headHTML(d) {
    const today = sameDay(d, TODAY);
    return `<div class="dh ${today ? 'today' : ''}" ${today ? 'aria-current="date"' : ''}><span class="dow">${DAYS[d.getDay()].slice(0, 3)}</span><span class="num">${d.getDate()}</span></div>`;
  }

  /* Week grid. opts: { start, overlap, selected } */
  function week(mount, o = {}) {
    const start = o.start;
    const days = [...Array(7)].map((_, i) => add(start, i));
    const opts = { maxLanes: 2, overlap: o.overlap, selected: o.selected };
    mount.className = 'cal';
    mount.style.setProperty('--ncols', 7);
    mount.innerHTML = `<div class="cal-head"><div></div>${days.map(headHTML).join('')}</div>
      <div class="cal-scroll"><div class="cal-body" style="--nhours:${H1 - H0}">${hoursHTML()}${days.map(d => colHTML(d, opts)).join('')}</div></div>`;
    return mount;
  }
  /* Day grid. opts: { date, selected } */
  function day(mount, o = {}) {
    mount.className = 'cal';
    mount.style.setProperty('--ncols', 1);
    mount.innerHTML = `<div class="cal-head"><div></div>${headHTML(o.date)}</div>
      <div class="cal-scroll"><div class="cal-body" style="--nhours:${H1 - H0}">${hoursHTML()}${colHTML(o.date, { maxLanes: 6, wide: true, selected: o.selected, overlap: o.overlap })}</div></div>`;
    return mount;
  }
  /* Month grid. */
  function month(mount, o = {}) {
    const first = D(o.year, o.month, 1);
    const s = weekStart(first);
    let html = DAYS.map(d => `<div class="mh">${d.slice(0, 3)}</div>`).join('');
    for (let i = 0; i < 42; i++) {
      const d = add(s, i), out = d.getMonth() !== o.month - 1;
      const evs = eventsOn(d).sort((a, b) => a.at - b.at);
      const shown = evs.length <= 3 ? evs : evs.slice(0, 2), more = evs.length - shown.length;   // never a lonely "1 more"
      html += `<div class="mcell ${out ? 'out' : ''} ${sameDay(d, TODAY) ? 'today' : ''}"><span class="n">${d.getDate()}</span>${shown.map(e => `<div class="mev" style="--cal:var(${CALS[e.cal].c})"><i></i><span>${e.t}</span></div>`).join('')}${more > 0 ? `<div class="mev more">${more} more</div>` : ''}</div>`;
    }
    mount.className = 'cal';
    mount.innerHTML = `<div class="month">${html}</div>`;
    return mount;
  }

  /* Detail body shared by the day rail and the popover.
     o: { close, rsvp, invite, own } */
  const GUEST = { going: ['check', 'Going'], maybe: ['help', 'Maybe'], declined: ['x', 'Declined'], none: ['circle', 'No reply yet'] };
  /* Edit, delete and the like live behind the ⋯ button; the tooltip names what is inside. */
  function detail(ev, o = {}) {
    const info = INFO[ev.base || ev.id] || {};
    const cal = CALS[ev.cal];
    const d = new Date(ev.date.replace(/-/g, '/'));
    const guests = info.guests ? `<h3 class="d-label">Guests</h3><ul class="guests">${info.guests.map(([n, st, role]) => `<li><span>${n}${role ? `<span class="role">${role}</span>` : ''}</span><span class="st ${st === 'none' ? 'is-open' : ''}">${ic(GUEST[st][0])}${GUEST[st][1]}</span></li>`).join('')}</ul>` : '';
    const more = ev.own ? 'More: edit, delete' : info.invite ? 'More: change your reply, hide' : 'More: hide, copy link';
    return `<div class="detail">
      <div class="d-head"><h2>${ev.t}</h2>
        <button class="btn btn-icon" aria-label="More" data-tip="${more}" data-key=".">${ic('more')}</button>
        ${o.close ? `<button class="btn btn-icon" data-close aria-label="Close" data-tip="Close" data-key="Esc">${ic('x')}</button>` : ''}</div>
      <p class="d-when">${longDay(d)} · ${range(ev.s, ev.e)}</p>
      <ul class="d-rows">
        <li><span class="mk"><i style="background:var(${cal.c})"></i></span>${cal.name}</li>
        ${info.video ? `<li>${ic('video')}<a class="link ellipsis" href="#">${info.video}</a></li>` : ''}
        ${info.place ? `<li>${ic('pin')}<span class="ellipsis">${info.place}</span></li>` : ''}
        ${info.invite ? `<li>${ic('mail')}<a class="link ellipsis" href="reader.html" data-open-invite data-tip="Open the invite email" data-key="O">Invite from ${info.invite.from}</a></li>` : ''}
      </ul>
      ${o.rsvp ? o.rsvp : ''}
      ${guests}
      ${info.desc && !o.noDesc ? `<p class="d-desc">${info.desc}</p>` : ''}
    </div>`;
  }

  /* Puck for .seg controls */
  function placePuck(seg) {
    let puck = seg.querySelector('.seg-puck');
    const sel = seg.querySelector('[aria-selected="true"]');
    if (!puck) { puck = document.createElement('span'); puck.className = 'seg-puck'; puck.setAttribute('aria-hidden', 'true'); seg.prepend(puck); }
    if (!sel) { puck.style.display = 'none'; return; }
    puck.style.display = '';
    puck.style.width = sel.offsetWidth + 'px';
    puck.style.transform = `translateX(${sel.offsetLeft}px)`;
  }
  function segSelect(seg, btn) {
    seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', String(b === btn)));
    placePuck(seg);
  }
  function initSegs() {
    document.querySelectorAll('.seg').forEach(seg => {
      const p = seg.querySelector('.seg-puck') || (placePuck(seg), seg.querySelector('.seg-puck'));
      if (p) { p.style.transition = 'none'; placePuck(seg); void p.offsetWidth; p.style.transition = ''; }
    });
  }
  function pos(el, anc) { let x = 0, y = 0; for (let n = el; n && n !== anc; n = n.offsetParent) { x += n.offsetLeft; y += n.offsetTop; } return { x, y }; }

  window.Cal = { CALS, INFO, TODAY, NOW, MONTHS, DAYS, D, iso, add, sameDay, weekStart, weekTitle, weekSub, monthTitle, monthSub, dayTitle, longDay, range, timeFull, eventsOn, findEvent, layout, week, day, month, detail, placePuck, segSelect, initSegs, pos, GUEST };
})();
