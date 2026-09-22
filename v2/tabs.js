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

  // Inline SVG icons (24-box, stroked, currentColor) so the toolbar, rows and
  // tab strips share one vocabulary instead of whatever glyphs a font has.
  const ICONS = {
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
    fork: '<circle cx="12" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><path d="M18 9v2c0 .6-.4 1-1 1H7c-.6 0-1-.4-1-1V9"/><path d="M12 12v3"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" x2="12" y1="3" y2="15"/>',
    refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    popout: '<path d="M21 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h6"/><path d="m21 3-9 9"/><path d="M15 3h6v6"/>',
    home: '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    service: '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    logs: '<line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="14" y1="18" y2="18"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  };
  Hub.ICONS = ICONS;
  Hub.icon = function icon(name, cls) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('class', 'ic' + (cls ? ' ' + cls : ''));
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = ICONS[name] || '';
    return svg;
  };
  // "<icon> +" — the new-thing buttons all read the same way.
  Hub.iconPlus = function iconPlus(name) {
    return [Hub.icon(name), Hub.el('span', { class: 'plus' }, '+')];
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
    icon: 'terminal',
    title: (t) => t.title || (t.cwd ? Hub.basename(t.cwd) : '~/projects'),
    mount(tab, el) {
      const f = iframe(tab.termUrl);
      el.append(f);
      return { refresh: () => { f.src = tab.termUrl; } };
    },
  });

  // ---- url: any site in an iframe with a thin bar ----
  Hub.registerKind('url', {
    icon: 'globe',
    title: (t) => t.title || t.url,
    mount(tab, el) {
      const f = iframe(tab.url);
      el.append(Hub.el('div', { class: 'tabbar' },
        Hub.el('span', { class: 'path mono', title: tab.url }, tab.url),
        Hub.el('span', { class: 'spacer' }),
        Hub.el('button', { class: 'btn muted', title: 'Reload', onclick: () => { f.src = tab.url; } }, Hub.icon('refresh')),
        Hub.el('a', { class: 'btn muted', href: tab.url, target: '_blank', rel: 'noopener', title: 'Open in a new browser tab' }, Hub.icon('popout'))), f);
      return { refresh: () => { f.src = tab.url; } };
    },
  });

  // ---- service: Site (when it serves one) / Unit file / Logs, plus
  // start · stop · restart in the bar — the only place these live (V93) ----
  Hub.registerKind('service', {
    icon: 'service',
    title: (t) => t.title || t.unit,
    mount(tab, root, ctx) {
      const { el, api, toast } = Hub;
      let mode = tab.mode || (tab.url ? 'site' : 'unit');
      let state = { active: tab.active || 'unknown', sub: '' };
      const dot = el('span', { class: 'dot' });
      const btns = {};
      const seg = el('div', { class: 'seg' }, ...[['site', 'Site'], ['unit', 'Unit'], ['logs', 'Logs']].map(([m, l]) => (btns[m] = el('button', { onclick: () => setMode(m) }, l))));
      btns.site.disabled = !tab.url;
      const startStop = el('button', { class: 'btn muted', onclick: () => act(state.active === 'active' ? 'stop' : 'start') });
      const restart = el('button', { class: 'btn muted', title: 'Restart', onclick: () => act('restart') }, Hub.icon('refresh'), ' Restart');
      const status = el('span', { class: 'hint' });
      const bar = el('div', { class: 'tabbar' }, seg, dot, el('span', { class: 'path mono', title: tab.unit }, tab.unit), status, el('span', { class: 'spacer' }), startStop, restart,
        tab.url ? el('a', { class: 'btn muted', href: tab.url, target: '_blank', rel: 'noopener', title: 'Open the site in a new browser tab' }, Hub.icon('popout')) : null);
      const view = el('div', { class: 'view' });
      root.append(el('div', { class: 'filetab' }, bar, view));
      let siteFrame = null; let logsTimer = null;

      function paintState() {
        dot.className = 'dot' + (state.active === 'active' ? ' on' : state.active === 'failed' ? ' bad' : '');
        startStop.replaceChildren(Hub.icon(state.active === 'active' ? 'stop' : 'play'), ' ', state.active === 'active' ? 'Stop' : 'Start');
        status.textContent = state.sub ? state.sub : '';
      }
      async function refreshState() {
        try {
          const d = await api('/api/v2/services');
          const me = d.services.find((x) => x.unit === tab.unit);
          if (me) { state = { active: me.active, sub: me.sub }; ctx.update({ active: me.active }, { silent: true }); }
          paintState();
        } catch {}
      }
      async function act(action) {
        startStop.disabled = restart.disabled = true;
        try {
          await api(`/api/v2/services/${encodeURIComponent(tab.unit)}/${action}`, { method: 'POST', body: {} });
          toast(action + ' ' + tab.unit);
          setTimeout(() => { refreshState(); if (mode === 'site' && siteFrame && action !== 'stop') siteFrame.src = tab.url; }, 1200);
        } catch (e) { toast(e.message, true); }
        finally { startStop.disabled = restart.disabled = false; }
      }
      function setMode(m) {
        if (m === 'site' && !tab.url) m = 'unit';
        mode = m;
        ctx.update({ mode: m }, { silent: true });
        for (const [k, b] of Object.entries(btns)) b.classList.toggle('on', k === m);
        clearInterval(logsTimer); logsTimer = null;
        // The site iframe stays mounted (hidden) so switching to Logs and back never reloads it.
        for (const c of Array.from(view.children)) { if (c === siteFrame) c.hidden = true; else c.remove(); }
        if (m === 'site') showSite();
        else if (m === 'unit') showUnit();
        else showLogs();
      }
      function showSite() {
        if (!siteFrame) { siteFrame = iframe(tab.url); view.append(siteFrame); }
        siteFrame.hidden = false;
      }
      async function showUnit() {
        const pre = el('pre', { class: 'code' }, 'loading…');
        view.append(pre);
        try {
          const u = await api(`/api/v2/services/${encodeURIComponent(tab.unit)}/unit`);
          const code = el('code', { class: 'language-ini' }, u.content);
          pre.innerHTML = ''; pre.append(code);
          status.textContent = u.path;
          const h = await (Hub.loadHljs ? Hub.loadHljs() : null);
          if (h) h.highlightElement(code);
        } catch (e) { pre.textContent = e.message; }
      }
      function showLogs() {
        const pre = el('pre', { class: 'code logs' }, 'loading…');
        view.append(pre);
        let last = '';
        const tick = async () => {
          try {
            const d = await api(`/api/v2/services/${encodeURIComponent(tab.unit)}/logs?n=400`);
            const text = d.lines.join('\n') || '(no output)';
            if (text !== last) { const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8; pre.textContent = text; last = text; if (atEnd) pre.scrollTop = pre.scrollHeight; }
          } catch (e) { pre.textContent = e.message; }
        };
        tick().then(() => { pre.scrollTop = pre.scrollHeight; });
        logsTimer = setInterval(() => { if (root.classList.contains('shown')) tick(); }, 3000);
      }
      paintState();
      refreshState();
      setMode(mode);
      return { refresh: () => { refreshState(); if (mode === 'site' && siteFrame) siteFrame.src = tab.url; }, onShow: refreshState, destroy: () => clearInterval(logsTimer) };
    },
  });
})();
