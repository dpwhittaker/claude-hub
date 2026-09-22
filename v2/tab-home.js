// Hub v2 — the Home tab (a new tab's launcher: sessions + services on top,
// a file browser below) and the standalone Browse tab. The browser is a
// component so both use one implementation.
(function () {
  'use strict';
  const Hub = window.Hub;
  const { el, api, toast } = Hub;

  // ---------- file browser ----------
  // opts: { path, onOpenFile(entry), onOpenFolderTab(path), onPathChange(path) }
  Hub.makeBrowser = function makeBrowser(opts) {
    let cur = opts.path || '';
    const root = el('div', { class: 'browser' });
    const crumbs = el('div', { class: 'crumbs' });
    const list = el('ul', { class: 'entries' });
    root.append(crumbs, list);
    let lastData = null;

    async function load(p) {
      cur = p || '';
      if (opts.onPathChange) opts.onPathChange(cur);
      list.innerHTML = '';
      list.append(el('li', { class: 'empty-note' }, 'loading…'));
      try {
        lastData = await api('/api/v2/fs/list?path=' + encodeURIComponent(cur));
        render();
      } catch (e) {
        list.innerHTML = '';
        list.append(el('li', { class: 'err' }, e.message));
        renderCrumbs();
      }
    }

    function renderCrumbs() {
      crumbs.innerHTML = '';
      const segs = cur ? cur.split('/') : [];
      crumbs.append(el('button', { class: segs.length ? '' : 'cur', onclick: () => load('') }, '~/projects'));
      let acc = '';
      segs.forEach((s, i) => {
        acc += (acc ? '/' : '') + s;
        const target = acc;
        crumbs.append(el('span', { class: 'sep' }, '/'), el('button', { class: i === segs.length - 1 ? 'cur' : '', onclick: () => load(target) }, s));
      });
      crumbs.append(el('span', { class: 'spacer' }));
      const tools = el('span', { class: 'tools' },
        el('button', { title: 'New folder', onclick: newFolder }, '📁+'),
        el('button', { title: 'New file (opens in the editor)', onclick: newFile }, '📄+'),
        el('button', { title: 'Upload files here', onclick: upload }, '⬆'),
        cur === '' ? el('button', { title: 'New repo from a template, clone, or onboard a folder', onclick: () => Hub.newRepoDialog(() => load(cur)) }, '✚ repo') : null,
        el('button', { title: 'Open a Claude / Codex / shell session here', onclick: () => Hub.newSessionDialog({ cwd: cur }) }, '▤+'),
        opts.onOpenFolderTab ? el('button', { title: 'Open this folder as its own tab', onclick: () => opts.onOpenFolderTab(cur) }, '⧉') : null,
        el('button', { title: 'Refresh', onclick: () => load(cur) }, '⟳'),
      );
      crumbs.append(tools);
    }

    function render() {
      renderCrumbs();
      list.innerHTML = '';
      if (cur) {
        const up = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/')) : '';
        list.append(el('li', { class: 'entry dir', onclick: () => load(up) }, el('span', { class: 'ico' }, '↑'), el('span', { class: 'nm' }, '..')));
      }
      if (!lastData.entries.length) list.append(el('li', { class: 'empty-note' }, 'empty folder'));
      for (const e of lastData.entries) {
        const cls = ['entry', e.kind, e.dim ? 'dim' : '', e.git ? 'git-' + e.git : ''].join(' ');
        const li = el('li', { class: cls, title: e.path });
        if (e.kind === 'dir') {
          Hub.append(li, el('span', { class: 'ico' }, e.repo ? '◆' : '▶'), el('span', { class: 'nm' }, e.name),
            e.project ? el('span', { class: 'badge' }, 'project') : null,
            el('span', { class: 'acts' },
              el('button', { title: 'Session here', onclick: (ev) => { ev.stopPropagation(); Hub.newSessionDialog({ cwd: e.path }); } }, '▤+'),
              el('button', { title: 'Open as tab', onclick: (ev) => { ev.stopPropagation(); Hub.openTab({ kind: 'browse', path: e.path }); } }, '⧉')));
          li.onclick = () => load(e.path);
        } else {
          Hub.append(li, el('span', { class: 'ico' }, '◈'), el('span', { class: 'nm' }, e.name),
            el('span', { class: 'meta' }, Hub.fmtSize(e.size)),
            el('span', { class: 'acts' },
              ...e.modes.filter((m) => m !== e.defaultMode).map((m) => el('button', { title: m, onclick: (ev) => { ev.stopPropagation(); open(e, m); } }, m))));
          li.onclick = () => open(e, e.defaultMode);
        }
        list.append(li);
      }
    }

    function open(e, mode) {
      if (opts.onOpenFile) opts.onOpenFile(e, mode);
      else Hub.openTab({ kind: 'file', path: e.path, mode });
    }

    async function newFolder() {
      const name = await Hub.ask({ title: 'New folder', label: 'Name', placeholder: 'folder-name' });
      if (!name) return;
      try { await api('/api/v2/fs/mkdir', { method: 'POST', body: { path: (cur ? cur + '/' : '') + name.trim() } }); load(cur); }
      catch (e) { toast(e.message, true); }
    }
    async function newFile() {
      const name = await Hub.ask({ title: 'New file', label: 'Name', placeholder: 'notes.md' });
      if (!name) return;
      const p = (cur ? cur + '/' : '') + name.trim();
      try { await api('/api/v2/fs/create', { method: 'POST', body: { path: p } }); load(cur); Hub.openTab({ kind: 'file', path: p, mode: 'edit' }); }
      catch (e) { toast(e.message, true); }
    }
    function upload() {
      if (!cur) { toast('pick a folder first — uploads cannot land in ~/projects itself', true); return; }
      const input = el('input', { type: 'file', multiple: true, style: { display: 'none' } });
      input.onchange = async () => {
        for (const f of input.files) {
          const fd = new FormData();
          fd.append('path', cur); fd.append('file', f, f.name);
          try {
            const r = await fetch('/api/upload-anywhere', { method: 'POST', body: fd });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || r.statusText);
          } catch (e) { toast(f.name + ': ' + e.message, true); }
        }
        toast('uploaded ' + input.files.length + ' file(s)');
        load(cur);
      };
      document.body.append(input);
      input.click();
      setTimeout(() => input.remove(), 60000);
    }

    load(cur);
    return { el: root, load, get path() { return cur; } };
  };

  // ---------- dialogs ----------
  Hub.newSessionDialog = function newSessionDialog({ cwd = '' } = {}) {
    Hub.sheet((card, close) => {
      const cwdInp = el('input', { class: 'inp', type: 'text', value: cwd, placeholder: '(root of ~/projects)' });
      const promptInp = el('textarea', { class: 'inp', rows: 3, placeholder: 'optional — typed into the session once it starts' });
      const err = el('div', { class: 'err' });
      let agent = 'claude';
      const radios = el('div', { class: 'radios' }, ...['claude', 'codex', 'shell'].map((a, i) => el('label', null,
        el('input', { type: 'radio', name: 'agent', value: a, checked: i === 0, onchange: () => { agent = a; } }), a === 'shell' ? 'Shell (bash)' : a[0].toUpperCase() + a.slice(1))));
      const go = el('button', { class: 'btn', onclick: async () => {
        go.disabled = true; err.textContent = '';
        try {
          const s = await api('/api/v2/sessions', { method: 'POST', body: { cwd: cwdInp.value.trim(), agent, profile: Hub.state.profile.id, prompt: promptInp.value || undefined } });
          close();
          Hub.openTab({ kind: 'term', sessionId: s.id, termUrl: s.termUrl, termKey: s.termKey, cwd: s.cwd, agent: s.agent, title: null });
        } catch (e) { err.textContent = e.message; go.disabled = false; }
      } }, 'Launch');
      card.append(
        el('h2', null, 'New session'),
        el('label', { class: 'field' }, el('span', null, 'Folder (under ~/projects)'), cwdInp),
        el('label', { class: 'field' }, el('span', null, 'Agent'), radios),
        el('label', { class: 'field' }, el('span', null, 'First prompt'), promptInp),
        el('p', { class: 'hint' }, `Profile "${Hub.state.profile.name}" — its instructions are appended to Claude sessions.`),
        err,
        el('div', { class: 'buttons' }, el('button', { class: 'btn muted', onclick: close }, 'Cancel'), go),
      );
      setTimeout(() => cwdInp.focus(), 0);
    });
  };

  // The v1 create-project dialog, rebuilt on the sheet. Same POST /api/projects.
  Hub.newRepoDialog = function newRepoDialog(onDone) {
    Hub.sheet((card, close) => {
      const name = el('input', { class: 'inp', type: 'text', placeholder: 'my-project' });
      const err = el('div', { class: 'err' });
      let ghMode = 'skip'; let template = 'vite';
      const cloneSel = el('select', { class: 'sel' }, el('option', { value: '' }, '— pick a repo —'));
      const cloneTxt = el('input', { class: 'inp', type: 'text', placeholder: 'owner/repo or URL', hidden: true });
      const onboardSel = el('select', { class: 'sel' }, el('option', { value: '' }, '— pick a folder —'));
      const vis = el('select', { class: 'sel' }, el('option', { value: 'private' }, 'private'), el('option', { value: 'public' }, 'public'));
      const firebase = el('input', { type: 'checkbox' });
      const subs = {};
      const ghGroup = el('div', { class: 'group' });
      const templates = [['vite', 'Vite (React + TS)'], ['game-2d', 'Phaser 2D'], ['game-3d', 'Simple 3D (R3F)'], ['game-3d-complex', 'Complex 3D (Babylon)'], ['jekyll', 'Jekyll site'], ['evenhub', 'G2 glasses app'], ['none', 'None (bare)']];
      const tplGroup = el('div', { class: 'group radios' }, ...templates.map(([v, l], i) => el('label', null, el('input', { type: 'radio', name: 'tpl', value: v, checked: i === 0, onchange: () => { template = v; sync(); } }), l)));
      const fbRow = el('label', { class: 'field' }, el('span', null, ''), el('span', { class: 'radios' }, el('label', null, firebase, 'Add Firebase (web SDK + hosting config)')));
      for (const [v, l, sub] of [['skip', 'No GitHub'], ['create', 'Create a GitHub repo', el('div', { class: 'sub' }, vis)], ['clone', 'Clone', el('div', { class: 'sub' }, cloneSel, cloneTxt)], ['onboard', 'Onboard an existing folder', el('div', { class: 'sub' }, onboardSel)]]) {
        ghGroup.append(el('label', { class: 'radios', style: { display: 'flex', padding: '4px 6px' } }, el('input', { type: 'radio', name: 'gh', value: v, checked: v === 'skip', onchange: () => { ghMode = v; sync(); } }), l));
        if (sub) { subs[v] = sub; ghGroup.append(sub); }
      }
      function sync() {
        for (const [k, s] of Object.entries(subs)) s.classList.toggle('visible', k === ghMode);
        const noTpl = ghMode === 'clone' || ghMode === 'onboard';
        tplGroup.style.display = noTpl ? 'none' : '';
        const fbOff = noTpl || template === 'none' || template === 'jekyll';
        firebase.disabled = fbOff; if (fbOff) firebase.checked = false; fbRow.style.opacity = fbOff ? '0.45' : '';
      }
      sync();
      api('/api/gh/repos').then((d) => {
        if (!d.repos || !d.repos.length) throw new Error();
        for (const r of d.repos) cloneSel.append(el('option', { value: r.nameWithOwner, title: r.description || '' }, r.nameWithOwner + (r.isFork ? ' [fork]' : r.isPrivate ? ' [private]' : '')));
      }).catch(() => { cloneSel.hidden = true; cloneTxt.hidden = false; });
      api('/api/projects/orphans').then((d) => { for (const f of d.folders || []) onboardSel.append(el('option', { value: f }, f)); }).catch(() => {});
      onboardSel.onchange = () => { if (onboardSel.value) name.value = onboardSel.value; };
      const go = el('button', { class: 'btn', onclick: async () => {
        err.textContent = '';
        const n = name.value.trim();
        if (!n) { err.textContent = 'Name required.'; return; }
        const payload = { name: n, template, firebase: firebase.checked && !firebase.disabled };
        if (ghMode === 'clone') {
          const source = (cloneSel.hidden ? cloneTxt.value : cloneSel.value).trim();
          if (!source) { err.textContent = 'Pick a repo to clone.'; return; }
          payload.github = { mode: 'clone', source };
        } else if (ghMode === 'onboard') {
          if (!onboardSel.value) { err.textContent = 'Pick a folder.'; return; }
          if (onboardSel.value !== n) { err.textContent = 'Name must match the folder.'; return; }
          payload.github = { mode: 'onboard' };
        } else if (ghMode === 'create') payload.github = { mode: 'create', visibility: vis.value };
        else payload.github = { mode: 'skip' };
        go.disabled = true; go.textContent = 'Working… (a scaffold can take a minute)';
        try {
          const r = await api('/api/projects', { method: 'POST', body: payload });
          close();
          toast('created ' + r.name);
          if (onDone) onDone(r);
          Hub.openTab({ kind: 'term', sessionId: null, termUrl: r.termUrl, termKey: r.termUrl.split('/')[2], cwd: r.name, agent: 'claude', title: null });
        } catch (e) { err.textContent = e.message; go.disabled = false; go.textContent = 'Create'; }
      } }, 'Create');
      card.append(
        el('h2', null, 'New repo in ~/projects'),
        el('label', { class: 'field' }, el('span', null, 'Name (becomes ~/projects/<name>)'), name),
        el('h4', null, 'GitHub'), ghGroup,
        el('h4', null, 'Template'), tplGroup, fbRow,
        err,
        el('div', { class: 'buttons' }, el('button', { class: 'btn muted', onclick: close }, 'Cancel'), go),
      );
      setTimeout(() => name.focus(), 0);
    });
  };

  Hub.showLogs = async function showLogs(unit) {
    Hub.sheet(async (card, close) => {
      const pre = el('pre', { class: 'code mono', style: { fontSize: '11px', maxHeight: '60vh', overflow: 'auto', whiteSpace: 'pre-wrap' } }, 'loading…');
      card.append(el('h2', null, unit), pre, el('div', { class: 'buttons' }, el('button', { class: 'btn muted', onclick: close }, 'Close')));
      try { const d = await api(`/api/v2/services/${encodeURIComponent(unit)}/logs?n=300`); pre.textContent = d.lines.join('\n') || '(no output)'; pre.scrollTop = pre.scrollHeight; }
      catch (e) { pre.textContent = e.message; }
    });
  };

  // ---------- home tab ----------
  Hub.registerKind('home', {
    icon: '⌂',
    title: () => 'Home',
    mount(tab, root, ctx) {
      const sessionsUl = el('ul', { class: 'rows' });
      const servicesUl = el('ul', { class: 'rows' });
      const tailnetUl = el('ul', { class: 'rows' });
      const browser = Hub.makeBrowser({
        path: tab.path || '',
        onPathChange: (p) => ctx.update({ path: p }, { silent: true }),
        onOpenFolderTab: (p) => Hub.openTab({ kind: 'browse', path: p }),
      });
      const home = el('div', { class: 'home' },
        el('div', { class: 'launch' },
          el('div', { class: 'col' },
            el('h3', null, 'Sessions', el('span', { class: 'spacer' }), el('button', { class: 'btn', onclick: () => Hub.newSessionDialog({ cwd: browser.path }) }, '+ New')),
            sessionsUl),
          el('div', { class: 'col' },
            el('h3', null, 'Services', el('span', { class: 'spacer' }), el('button', { class: 'btn muted', onclick: () => refresh() }, '⟳')),
            servicesUl,
            el('h3', { style: { marginTop: '14px' } }, 'Tailnet'),
            tailnetUl)),
        el('div', { class: 'files' }, browser.el));
      root.append(home);

      function sessionRow(s) {
        const title = s.title || (s.cwd ? Hub.basename(s.cwd) : '~/projects');
        const sub = (s.cwd ? '~/projects/' + s.cwd : '~/projects') + (s.title ? '' : '');
        const row = el('li', { class: 'row', title: s.termKey },
          el('span', { class: 'dot' + (s.running ? ' on' : '') }),
          el('span', { class: 'badge ' + s.agent }, s.agent),
          el('span', { class: 'main' }, el('span', { class: 't' }, title), el('span', { class: 's' }, sub + (s.kind === 'legacy' ? ' · v1 tab' : ''))),
          el('span', { class: 'acts' },
            el('button', { title: 'Rename', onclick: async (ev) => { ev.stopPropagation(); if (s.kind !== 'hub') { toast('v1 tabs are named by Claude', true); return; } const t = await Hub.ask({ title: 'Session title', value: s.title || '' }); if (t === null) return; try { await api('/api/v2/sessions/' + s.id, { method: 'PATCH', body: { title: t || null } }); refresh(); } catch (e) { toast(e.message, true); } } }, '✎'),
            el('button', { title: s.kind === 'hub' ? 'End this session (kills the tmux session)' : 'v1 tabs are closed from the old Develop pane', onclick: async (ev) => { ev.stopPropagation(); if (s.kind !== 'hub') return; if (!(await Hub.confirm('End session?', 'The tmux session and its agent are killed. A Claude conversation can be resumed later by its id.', 'End', true))) return; try { await api('/api/v2/sessions/' + s.id, { method: 'DELETE' }); Hub.closeTabsWhere((t) => t.kind === 'term' && t.termKey === s.termKey); refresh(); } catch (e) { toast(e.message, true); } } }, '✕')));
        row.onclick = () => Hub.openTab({ kind: 'term', sessionId: s.kind === 'hub' ? s.id : null, termUrl: s.termUrl, termKey: s.termKey, cwd: s.cwd, agent: s.agent, title: s.title || null });
        return row;
      }

      function serviceRow(s) {
        const row = el('li', { class: 'row', title: s.description || s.unit },
          el('span', { class: 'dot' + (s.active === 'active' ? ' on' : s.active === 'failed' ? ' bad' : '') }),
          el('span', { class: 'main' }, el('span', { class: 't' }, s.title), el('span', { class: 's' }, (s.sub || s.active) + (s.project ? ' · ' + s.project : '') + (s.url ? ' · ' + s.url : ''))),
          el('span', { class: 'acts' },
            el('button', { title: 'Logs', onclick: (ev) => { ev.stopPropagation(); Hub.showLogs(s.unit); } }, '≡'),
            el('button', { title: 'Restart', onclick: (ev) => { ev.stopPropagation(); act(s.unit, 'restart'); } }, '↻'),
            el('button', { title: s.active === 'active' ? 'Stop' : 'Start', onclick: (ev) => { ev.stopPropagation(); act(s.unit, s.active === 'active' ? 'stop' : 'start'); } }, s.active === 'active' ? '■' : '▶')));
        row.onclick = () => { if (s.url) Hub.openTab({ kind: 'service', unit: s.unit, url: s.url, title: s.title, active: s.active }); else Hub.showLogs(s.unit); };
        return row;
      }

      async function act(unit, action) {
        try { await api(`/api/v2/services/${encodeURIComponent(unit)}/${action}`, { method: 'POST', body: {} }); toast(action + ' ' + unit); setTimeout(refresh, 800); }
        catch (e) { toast(e.message, true); }
      }

      let busy = false;
      async function refresh() {
        if (busy) return; busy = true;
        try {
          const [ss, sv] = await Promise.all([api('/api/v2/sessions'), api('/api/v2/services')]);
          sessionsUl.innerHTML = '';
          const list = ss.sessions.slice().sort((a, b) => (b.running - a.running) || (a.cwd || '').localeCompare(b.cwd || ''));
          if (!list.length) sessionsUl.append(el('li', { class: 'empty-note' }, 'no sessions yet — press + New'));
          for (const s of list) sessionsUl.append(sessionRow(s));
          servicesUl.innerHTML = '';
          for (const s of sv.services) servicesUl.append(serviceRow(s));
          tailnetUl.innerHTML = '';
          for (const t of sv.tailnet) for (const m of t.mounts) {
            const url = t.url + (m.path === '/' ? '/' : m.path);
            tailnetUl.append(el('li', { class: 'row', onclick: () => Hub.openTab({ kind: 'url', url, title: url.replace(/^https?:\/\//, '') }) },
              el('span', { class: 'dot on' }), el('span', { class: 'main' }, el('span', { class: 't mono' }, url), el('span', { class: 's' }, m.mode + ' → ' + m.target))));
          }
          if (!sv.tailnet.length) tailnetUl.append(el('li', { class: 'empty-note' }, 'nothing served on the tailnet'));
        } catch (e) { toast(e.message, true); }
        busy = false;
      }
      refresh();
      let timer = setInterval(() => { if (root.classList.contains('shown')) refresh(); }, 15000);
      return { refresh, onShow: refresh, destroy: () => clearInterval(timer) };
    },
  });

  // ---------- browse tab: just the browser ----------
  Hub.registerKind('browse', {
    icon: '▶',
    title: (t) => (t.path ? Hub.basename(t.path) : '~/projects') + '/',
    mount(tab, root, ctx) {
      const browser = Hub.makeBrowser({ path: tab.path || '', onPathChange: (p) => ctx.update({ path: p }) });
      root.append(browser.el);
      return { refresh: () => browser.load(browser.path) };
    },
  });
})();
