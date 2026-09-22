// Hub v2 — shared helpers + the simple tab kinds (term, service, url).
// Every tab kind registers { icon, title(tab), mount(tab, el, ctx) } here;
// app.js owns the layout and calls mount once per tab, keeping the element
// alive for the tab's lifetime (V86). Home / browse live in tab-home.js and
// file in tab-file.js.
(function () {
  'use strict';
  const Hub = window.Hub = window.Hub || {};
  Hub.kinds = {};
  Hub.registerKind = (kind, def) => { Hub.kinds[kind] = def; };

  // ---- DOM + fetch helpers ----
  Hub.el = function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k in node && k !== 'list' && typeof v !== 'string') node[k] = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };

  // DOM append that skips null/false children (Element.append would print "null").
  Hub.append = function append(parent, ...kids) {
    for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) parent.append(k);
    return parent;
  };

  Hub.api = async function api(path, { method = 'GET', body, raw = false } = {}) {
    const init = { method, headers: {} };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    const r = await fetch(path, init);
    if (raw) return r;
    const text = await r.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = { error: text.slice(0, 200) }; }
    if (!r.ok) {
      const e = new Error((data && data.error) || (r.status + ' ' + r.statusText));
      e.status = r.status; e.data = data; throw e;
    }
    return data;
  };

  let toastTimer = null;
  Hub.toast = function toast(msg, bad) {
    const t = document.getElementById('toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.toggle('bad', !!bad);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, bad ? 6000 : 2600);
  };

  // A modal card. `render(card, close)` fills it. Returns close().
  Hub.sheet = function sheet(render) {
    const host = document.getElementById('sheet');
    host.innerHTML = '';
    const card = Hub.el('div', { class: 'card', role: 'dialog' });
    host.append(card);
    host.hidden = false;
    const close = () => { host.hidden = true; host.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    host.onclick = (e) => { if (e.target === host) close(); };
    render(card, close);
    return close;
  };

  // Tiny prompt/confirm built on the sheet so phones get a real input.
  Hub.ask = function ask({ title, label, value = '', placeholder = '', okLabel = 'OK', multiline = false }) {
    return new Promise((resolve) => {
      Hub.sheet((card, close) => {
        const inp = multiline
          ? Hub.el('textarea', { class: 'inp', rows: 6, placeholder })
          : Hub.el('input', { class: 'inp', type: 'text', placeholder, value });
        if (multiline) inp.value = value;
        const done = (v) => { close(); resolve(v); };
        card.append(
          Hub.el('h2', null, title),
          Hub.el('label', { class: 'field' }, label ? Hub.el('span', null, label) : null, inp),
          Hub.el('div', { class: 'buttons' },
            Hub.el('button', { class: 'btn muted', onclick: () => done(null) }, 'Cancel'),
            Hub.el('button', { class: 'btn', onclick: () => done(inp.value) }, okLabel)),
        );
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !multiline) { e.preventDefault(); done(inp.value); } });
        setTimeout(() => { inp.focus(); if (!multiline) inp.select(); }, 0);
      });
    });
  };

  Hub.confirm = function confirm(title, detail, okLabel = 'Confirm', danger = false) {
    return new Promise((resolve) => {
      Hub.sheet((card, close) => {
        const done = (v) => { close(); resolve(v); };
        Hub.append(card,
          Hub.el('h2', null, title),
          detail ? Hub.el('p', { class: 'hint' }, detail) : null,
          Hub.el('div', { class: 'buttons' },
            Hub.el('button', { class: 'btn muted', onclick: () => done(false) }, 'Cancel'),
            Hub.el('button', { class: 'btn' + (danger ? ' danger' : ''), onclick: () => done(true) }, okLabel)),
        );
      });
    });
  };

  Hub.basename = (p) => { const s = String(p || ''); const i = s.lastIndexOf('/'); return i < 0 ? s : s.slice(i + 1); };
  Hub.fmtSize = (n) => n == null ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  Hub.fmtAgo = (ms) => {
    if (!ms) return '';
    const d = Date.now() - ms;
    if (d < 60e3) return 'just now';
    if (d < 3600e3) return Math.floor(d / 60e3) + ' min ago';
    if (d < 86400e3) return Math.floor(d / 3600e3) + ' h ago';
    return Math.floor(d / 86400e3) + ' d ago';
  };

  function iframe(src, extra) {
    return Hub.el('iframe', { class: 'fill', src, allow: 'clipboard-read; clipboard-write; microphone', ...extra });
  }

  // ---- term: a live agent session ----
  Hub.registerKind('term', {
    icon: '▤',
    title: (t) => t.title || (t.cwd ? Hub.basename(t.cwd) : '~/projects'),
    mount(tab, el) {
      const f = iframe(tab.termUrl);
      el.append(f);
      return { refresh: () => { f.src = tab.termUrl; } };
    },
  });

  // ---- service / url: a live site in an iframe with a thin bar ----
  function urlKind(kind) {
    return {
      icon: kind === 'service' ? '◉' : '⧉',
      title: (t) => t.title || t.unit || t.url,
      mount(tab, el) {
        const f = iframe(tab.url);
        const state = Hub.el('span', { class: 'dot' + (tab.active === 'active' ? ' on' : '') });
        const bar = Hub.el('div', { class: 'tabbar' },
          kind === 'service' ? state : null,
          Hub.el('span', { class: 'path mono', title: tab.url }, kind === 'service' ? tab.unit : tab.url),
          Hub.el('span', { class: 'spacer' }),
          kind === 'service' ? Hub.el('button', { class: 'btn muted', title: 'Restart the unit', onclick: async (e) => {
            e.target.disabled = true;
            try { await Hub.api(`/api/v2/services/${encodeURIComponent(tab.unit)}/restart`, { method: 'POST', body: {} }); Hub.toast('restarted ' + tab.unit); setTimeout(() => { f.src = tab.url; }, 1500); }
            catch (err) { Hub.toast(err.message, true); }
            e.target.disabled = false;
          } }, '↻ restart') : null,
          Hub.el('button', { class: 'btn muted', title: 'Reload', onclick: () => { f.src = tab.url; } }, '⟳'),
          Hub.el('a', { class: 'btn muted', href: tab.url, target: '_blank', rel: 'noopener', title: 'Open in a new browser tab' }, '↗'),
        );
        el.append(bar, f);
        return { refresh: () => { f.src = tab.url; } };
      },
    };
  }
  Hub.registerKind('service', urlKind('service'));
  Hub.registerKind('url', urlKind('url'));
})();
