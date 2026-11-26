// Pure helpers shared by the reminder sender (no Firebase here, so they can be tested on their own).
export const DEFAULT_REMINDER = 'Hi {name}, your chit instalment for {months} ({amount}) is pending. Please pay at the earliest.';
export function normEmail(e){ return (e || '').trim().toLowerCase(); }
export function nameKey(n){ return (n || '').trim().toLowerCase(); }
export function emailKey(e){ return normEmail(e).replace(/\./g, '(dot)'); }
export function addMonths(ym, n){
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
export function monthLabel(ym){
  const [y, m] = ym.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}
export function rupees(n){ return '₹' + Math.round(n || 0).toLocaleString('en-IN'); }
export function monthlyAmount(chit){ return chit.totalMembers ? chit.chitValue / chit.totalMembers : 0; }
// Who owes what: people with "pending" marks (the Kovil seat never owes). Same rule as the app.
export function pendingByPerson(state){
  const map = {};
  (state.chits || []).forEach(c => {
    if (c.closed) return;
    const mAmt = monthlyAmount(c);
    (c.members || []).forEach(m => {
      if (m.isOrg) return;
      const p = (state.people || []).find(x => x.id === m.personId);
      if (!p) return;
      const pend = Object.keys(m.payments || {}).filter(mk => m.payments[mk] === 'pending').sort();
      if (!pend.length) return;
      const o = map[p.id] || (map[p.id] = { person: p, months: [], amount: 0, groups: [] });
      pend.forEach(mk => o.months.push(monthLabel(mk)));
      o.amount += pend.length * mAmt;
      if (!o.groups.includes(c.name)) o.groups.push(c.name);
    });
  });
  return Object.values(map);
}
export function fillTemplate(tpl, t){
  return (tpl || '').replace(/\{name\}/g, t.name || '').replace(/\{months\}/g, t.months || '')
    .replace(/\{amount\}/g, t.amount ? rupees(t.amount) : '').replace(/\{group\}/g, t.group || '');
}
// ---- chit dates ----
export function istToday(now){ return new Date((now === undefined ? Date.now() : now) + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }
export function addDays(ymd, n){ const d = new Date(ymd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
export function daysInMonth(ym){ const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
export function chitDateFor(c, monthKey){
  const day = Math.min(Number(c.chitDay) || 1, daysInMonth(monthKey));
  return monthKey + '-' + String(day).padStart(2, '0');
}
export function prettyDate(ymd){
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
// Groups whose chit date is today or `daysBefore` days from today.
export function chitDateEvents(state, todayYmd, daysBefore){
  const out = [];
  (state.chits || []).forEach(c => {
    if (c.closed || !c.chitDay) return;
    for (let i = 0; i < (Number(c.durationMonths) || 0); i++) {
      const date = chitDateFor(c, addMonths(c.startMonth, i));
      if (date === todayYmd) out.push({ kind: 'today', chit: c, date, chitNo: i + 1 });
      if (date === addDays(todayYmd, daysBefore)) out.push({ kind: 'before', chit: c, date, chitNo: i + 1 });
    }
  });
  return out;
}

// The automatic daily reminders, according to the switches on the Reminders page.
export function autoMessages(state, now){
  const out = autoPendingMessages(state);
  const s = state.reminderSettings || {};
  if (s.autoBeforeChit || s.autoChitDay) {
    const daysBefore = Number(s.remindDaysBefore) || 2;
    chitDateEvents(state, istToday(now), daysBefore).forEach(ev => {
      if (ev.kind === 'before' && !s.autoBeforeChit) return;
      if (ev.kind === 'today' && !s.autoChitDay) return;
      const mAmt = monthlyAmount(ev.chit);
      (ev.chit.members || []).forEach(m => {
        if (m.isOrg) return;
        const p = (state.people || []).find(x => x.id === m.personId);
        if (!p || !p.portalEmail) return;
        out.push(ev.kind === 'before'
          ? { email: p.portalEmail, title: 'Chit day coming up',
              body: 'Hi ' + p.name + ', the ' + ev.chit.name + ' chit is on ' + prettyDate(ev.date) + ' (in ' + daysBefore + ' days). Your instalment: ' + rupees(mAmt) + '.' }
          : { email: p.portalEmail, title: 'Chit day today',
              body: 'Good morning ' + p.name + '! Today is the ' + ev.chit.name + ' chit day. Please pay your instalment of ' + rupees(mAmt) + '.' });
      });
    });
  }
  return out;
}

function autoPendingMessages(state){
  const s = state.reminderSettings || {};
  const out = [];
  const per = pendingByPerson(state);
  if (s.autoMembers) {
    per.forEach(o => {
      if (!o.person.portalEmail) return;
      out.push({ email: o.person.portalEmail, title: 'Chit reminder',
        body: fillTemplate(DEFAULT_REMINDER, { name: o.person.name, months: o.months.join(', '), amount: o.amount, group: o.groups.join(', ') }) });
    });
  }
  if (s.autoGroupAdmins) {
    (state.refs || []).forEach(r => {
      if (!r.portalEmail) return;
      const mine = per.filter(o => nameKey(o.person.refBy) === nameKey(r.name));
      if (!mine.length) return;
      const total = mine.reduce((a, o) => a + o.amount, 0);
      out.push({ email: r.portalEmail, title: 'Group reminder',
        body: mine.length + ' member' + (mine.length === 1 ? '' : 's') + ' in your group ' + (mine.length === 1 ? 'has' : 'have') + ' pending dues (' + rupees(total) + ').' });
    });
  }
  return out;
}
