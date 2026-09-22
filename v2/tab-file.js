// Hub v2 — the file tab: Raw / View / Edit / Diff on any file under
// ~/projects (V81). Raw is highlighted source, View is the rendered thing
// (markdown, image, pdf, the live page for html behind a dev server), Edit is
// CodeMirror 6 (loaded from esm.sh on first use, textarea fallback) with a
// fill-in-the-middle completion from the local claude CLI, Diff is the
// working tree against HEAD or any commit that touched the file.
(function () {
  'use strict';
  const Hub = window.Hub;
  const { el, api, toast } = Hub;

  const HLJS = 'https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11/build';
  let hljsReady = null;
  function loadHljs() {
    if (hljsReady) return hljsReady;
    hljsReady = new Promise((resolve) => {
      if (window.hljs) return resolve(window.hljs);
      document.head.append(el('link', { rel: 'stylesheet', href: HLJS + '/styles/atom-one-dark.min.css' }));
      const s = el('script', { src: HLJS + '/highlight.min.js' });
      s.onload = () => resolve(window.hljs);
      s.onerror = () => resolve(null);
      document.head.append(s);
    });
    return hljsReady;
  }

  // CodeMirror from esm.sh. One import graph per page; a failure falls back
  // to a textarea so editing never depends on the CDN.
  const ESM = 'https://esm.sh';
  const LANG_PKG = {
    javascript: ['@codemirror/lang-javascript', (m, ext) => m.javascript({ jsx: /x$/.test(ext), typescript: /^\.tsx?$/.test(ext) })],
    typescript: ['@codemirror/lang-javascript', (m, ext) => m.javascript({ jsx: /x$/.test(ext), typescript: true })],
    markdown: ['@codemirror/lang-markdown', (m) => m.markdown()],
    css: ['@codemirror/lang-css', (m) => m.css()], scss: ['@codemirror/lang-css', (m) => m.css()],
    xml: ['@codemirror/lang-html', (m) => m.html()], json: ['@codemirror/lang-json', (m) => m.json()],
    python: ['@codemirror/lang-python', (m) => m.python()], yaml: ['@codemirror/lang-yaml', (m) => m.yaml()],
    rust: ['@codemirror/lang-rust', (m) => m.rust()], cpp: ['@codemirror/lang-cpp', (m) => m.cpp()], c: ['@codemirror/lang-cpp', (m) => m.cpp()],
    go: ['@codemirror/lang-go', (m) => m.go()], java: ['@codemirror/lang-java', (m) => m.java()], sql: ['@codemirror/lang-sql', (m) => m.sql()],
    php: ['@codemirror/lang-php', (m) => m.php()],
  };
  let cmCore = null;
  async function loadCM() {
    if (cmCore) return cmCore;
    cmCore = (async () => {
      const [cm, state, view, commands, theme] = await Promise.all([
        import(ESM + '/codemirror@6.0.2'), import(ESM + '/@codemirror/state'), import(ESM + '/@codemirror/view'),
        import(ESM + '/@codemirror/commands'), import(ESM + '/@codemirror/theme-one-dark'),
      ]);
      return { cm, state, view, commands, theme };
    })().catch((e) => { cmCore = null; throw e; });
    return cmCore;
  }
  const langCache = {};
  async function loadLang(lang, ext) {
    const spec = LANG_PKG[lang];
    if (!spec) return null;
    try {
      langCache[spec[0]] = langCache[spec[0]] || import(ESM + '/' + spec[0]);
      return spec[1](await langCache[spec[0]], ext);
    } catch { return null; }
  }

  function renderDiff(text) {
    const pre = el('pre', { class: 'diff mono' });
    if (!text) { pre.append(el('div', { class: 'l meta' }, '(no differences)')); return pre; }
    for (const line of text.split('\n')) {
      let cls = 'l';
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls += ' meta';
      else if (line.startsWith('@@')) cls += ' hunk';
      else if (line.startsWith('+')) cls += ' add';
      else if (line.startsWith('-')) cls += ' del';
      pre.append(el('div', { class: cls }, line || ' '));
    }
    return pre;
  }

  Hub.registerKind('file', {
    icon: '◈',
    title: (t) => Hub.basename(t.path),
    mount(tab, root, ctx) {
      const path = tab.path;
      let stat = null;
      let mode = tab.mode || null;
      const modeBtns = {};
      const seg = el('div', { class: 'seg' }, ...['raw', 'view', 'edit', 'diff'].map((m) => (modeBtns[m] = el('button', { onclick: () => setMode(m) }, m[0].toUpperCase() + m.slice(1)))));
      const saveBtn = el('button', { class: 'btn', hidden: true, onclick: () => save() }, 'Save');
      const aiBtn = el('button', { class: 'btn muted', hidden: true, title: 'AI completion at the cursor (Ctrl+Space)', onclick: () => complete() }, '✨');
      const refSel = el('select', { class: 'sel', hidden: true, onchange: () => showDiff() });
      const dl = el('a', { class: 'btn muted', title: 'Download', href: '/api/v2/fs/raw?path=' + encodeURIComponent(path) + '&download=1' }, '↧');
      const status = el('span', { class: 'hint' });
      const bar = el('div', { class: 'tabbar' }, seg, el('span', { class: 'path mono', title: path }, path), status, el('span', { class: 'spacer' }), refSel, aiBtn, saveBtn, dl);
      const view = el('div', { class: 'view' });
      root.append(el('div', { class: 'filetab' }, bar, view));

      // ---- editor state (kept alive across mode switches) ----
      let editor = null;      // { getValue, setValue, insertAtCursor, focus, dom, cursorContext }
      let editorHost = null;
      let loadedMtime = null;
      let dirty = false;
      let ghost = null;       // { from, to } of the last inserted completion

      function setDirty(d) { dirty = d; ctx.setDirty(d); saveBtn.textContent = d ? 'Save •' : 'Save'; }

      async function init() {
        try { stat = await api('/api/v2/fs/stat?path=' + encodeURIComponent(path)); }
        catch (e) { view.innerHTML = ''; view.append(el('div', { class: 'err' }, e.message)); return; }
        for (const m of Object.keys(modeBtns)) modeBtns[m].disabled = !stat.modes.includes(m);
        setMode(mode && stat.modes.includes(mode) ? mode : stat.defaultMode);
      }

      function setMode(m) {
        if (stat && !stat.modes.includes(m)) return;
        mode = m;
        ctx.update({ mode: m });
        for (const [k, b] of Object.entries(modeBtns)) b.classList.toggle('on', k === m);
        saveBtn.hidden = m !== 'edit'; aiBtn.hidden = m !== 'edit'; refSel.hidden = m !== 'diff';
        status.textContent = '';
        for (const c of Array.from(view.children)) { if (c !== editorHost) c.remove(); }
        if (editorHost) editorHost.style.display = m === 'edit' ? '' : 'none';
        if (m === 'raw') showRaw();
        else if (m === 'view') showView();
        else if (m === 'edit') showEdit();
        else if (m === 'diff') showDiff(true);
      }

      async function showRaw() {
        if (!stat.textual || stat.tooLarge) {
          view.append(el('div', { class: 'center' }, el('div', null, el('p', null, `${stat.fileKind} file · ${Hub.fmtSize(stat.size)}`),
            el('a', { class: 'btn', href: dl.href }, 'Download'))));
          return;
        }
        const pre = el('pre', { class: 'code' }, 'loading…');
        view.append(pre);
        try {
          const t = await api('/api/v2/fs/text?path=' + encodeURIComponent(path));
          const code = el('code', { class: t.lang ? 'language-' + t.lang : '' }, t.content);
          pre.innerHTML = ''; pre.append(code);
          status.textContent = Hub.fmtSize(t.size) + (stat.git ? ' · git ' + stat.git : '');
          const h = await loadHljs();
          if (h && t.content.length < 300000) h.highlightElement(code);
        } catch (e) { pre.textContent = e.message; }
      }

      function showView() {
        const raw = '/api/v2/fs/raw?path=' + encodeURIComponent(path);
        const k = stat.fileKind;
        if (k === 'markdown') view.append(el('iframe', { class: 'fill', src: '/api/v2/fs/render?path=' + encodeURIComponent(path) }));
        else if (k === 'image') view.append(el('div', { class: 'center' }, el('img', { class: 'media', src: raw, alt: path })));
        else if (k === 'pdf') view.append(el('iframe', { class: 'fill', src: raw }));
        else if (k === 'html') {
          const src = stat.previewUrl || raw;
          const f = el('iframe', { class: 'fill', src });
          if (stat.previewUrl) status.append('live: ', el('a', { href: stat.previewUrl, target: '_blank', rel: 'noopener' }, stat.previewUrl));
          view.append(f);
        } else if (k === 'media') {
          const isVideo = /\.(mp4|webm|mov)$/i.test(path);
          view.append(el('div', { class: 'center' }, el(isVideo ? 'video' : 'audio', { class: 'media', src: raw, controls: true })));
        } else showRaw();
      }

      async function showEdit() {
        if (editor) { editor.focus(); return; }
        editorHost = el('div', { class: 'editor' }, el('div', { class: 'empty-note' }, 'loading editor…'));
        view.append(editorHost);
        let t;
        try { t = await api('/api/v2/fs/text?path=' + encodeURIComponent(path)); }
        catch (e) { editorHost.innerHTML = ''; editorHost.append(el('div', { class: 'err' }, e.message)); return; }
        loadedMtime = t.mtime;
        const ext = stat.ext || '';
        try {
          const { cm, state, view: cmView, commands, theme } = await loadCM();
          const langExt = await loadLang(t.lang, ext);
          const exts = [cm.basicSetup, theme.oneDark, cmView.keymap.of([
            { key: 'Mod-s', run: () => { save(); return true; } },
            { key: 'Ctrl-Space', run: () => { complete(); return true; } },
            { key: 'Escape', run: () => dropGhost() },
            { key: 'Tab', run: (v) => { if (ghost) { keepGhost(v); return true; } return commands.indentMore(v); }, shift: commands.indentLess },
          ]), cmView.EditorView.updateListener.of((u) => { if (u.docChanged) { if (!applyingGhost) ghost = null; setDirty(true); } }),
          cmView.EditorView.theme({ '&': { height: '100%' }, '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' } })];
          if (langExt) exts.push(langExt);
          const ev = new cmView.EditorView({ state: state.EditorState.create({ doc: t.content, extensions: exts }), parent: editorHost });
          editorHost.querySelector('.empty-note')?.remove();
          let applyingGhost = false;
          editor = {
            focus: () => ev.focus(),
            getValue: () => ev.state.doc.toString(),
            setValue: (v) => ev.dispatch({ changes: { from: 0, to: ev.state.doc.length, insert: v } }),
            cursorContext: () => { const pos = ev.state.selection.main.head; const doc = ev.state.doc.toString(); return { before: doc.slice(0, pos), after: doc.slice(pos), pos }; },
            insertGhost: (text) => {
              const pos = ev.state.selection.main.head;
              applyingGhost = true;
              ev.dispatch({ changes: { from: pos, insert: text }, selection: { anchor: pos, head: pos + text.length }, scrollIntoView: true });
              applyingGhost = false;
              ghost = { from: pos, to: pos + text.length };
            },
            dropGhost: () => { if (!ghost) return false; applyingGhost = true; ev.dispatch({ changes: { from: ghost.from, to: ghost.to, insert: '' }, selection: { anchor: ghost.from } }); applyingGhost = false; ghost = null; return true; },
            keepGhost: () => { if (!ghost) return; ev.dispatch({ selection: { anchor: ghost.to } }); ghost = null; },
          };
        } catch (e) {
          // CDN unreachable → plain textarea.
          const ta = el('textarea', { class: 'fallback', spellcheck: false });
          ta.value = t.content;
          ta.addEventListener('input', () => setDirty(true));
          ta.addEventListener('keydown', (ev2) => { if ((ev2.ctrlKey || ev2.metaKey) && ev2.key === 's') { ev2.preventDefault(); save(); } });
          editorHost.innerHTML = ''; editorHost.append(ta);
          editor = {
            focus: () => ta.focus(), getValue: () => ta.value, setValue: (v) => { ta.value = v; },
            cursorContext: () => ({ before: ta.value.slice(0, ta.selectionStart), after: ta.value.slice(ta.selectionStart), pos: ta.selectionStart }),
            insertGhost: (text) => { const p = ta.selectionStart; ta.setRangeText(text, p, p, 'select'); ghost = { from: p, to: p + text.length }; setDirty(true); },
            dropGhost: () => { if (!ghost) return false; ta.setRangeText('', ghost.from, ghost.to, 'start'); ghost = null; return true; },
            keepGhost: () => { if (!ghost) return; ta.setSelectionRange(ghost.to, ghost.to); ghost = null; },
          };
          status.textContent = 'plain editor (CodeMirror failed to load: ' + e.message + ')';
        }
        editor.focus();
      }
      function dropGhost() { return editor ? editor.dropGhost() : false; }
      function keepGhost() { if (editor) editor.keepGhost(); }

      async function save(force) {
        if (!editor) return;
        saveBtn.disabled = true; status.textContent = 'saving…';
        try {
          const r = await api('/api/v2/fs/text', { method: 'PUT', body: { path, content: editor.getValue(), baseMtime: force ? undefined : loadedMtime } });
          loadedMtime = r.mtime; setDirty(false); status.textContent = 'saved ' + Hub.fmtSize(r.size);
        } catch (e) {
          if (e.status === 409) {
            status.textContent = '';
            if (await Hub.confirm('File changed on disk', 'Someone (an agent?) wrote this file since you opened it. Overwrite with your version?', 'Overwrite', true)) return save(true);
          } else { status.textContent = ''; toast(e.message, true); }
        } finally { saveBtn.disabled = false; }
      }

      async function complete() {
        if (!editor) return;
        const { before, after } = editor.cursorContext();
        aiBtn.disabled = true; status.textContent = 'thinking…';
        try {
          const r = await api('/api/v2/ai/complete', { method: 'POST', body: { path, lang: stat.lang, before: before.slice(-6000), after: after.slice(0, 3000) } });
          if (r.text) { editor.insertGhost(r.text); status.textContent = 'Tab keeps · Esc drops'; }
          else status.textContent = 'nothing suggested';
        } catch (e) { status.textContent = ''; toast(e.message, true); }
        finally { aiBtn.disabled = false; editor.focus(); }
      }

      async function showDiff(rebuildRefs) {
        const box = el('div', { class: 'body-scroll' }, el('div', { class: 'empty-note' }, 'loading…'));
        view.append(box);
        try {
          if (rebuildRefs || !refSel.options.length) {
            const lg = await api('/api/v2/fs/log?path=' + encodeURIComponent(path));
            refSel.innerHTML = '';
            if (!lg.repo) { box.innerHTML = ''; box.append(el('div', { class: 'empty-note' }, 'not inside a git repository')); return; }
            refSel.append(el('option', { value: 'HEAD' }, 'uncommitted changes (vs HEAD)'));
            for (const c of lg.commits) refSel.append(el('option', { value: c.sha }, `vs ${c.short} · ${c.subject}`));
            for (const c of lg.commits) refSel.append(el('option', { value: c.sha + '^|' + c.sha }, `what ${c.short} changed`));
          }
          const [ref, to] = refSel.value.split('|');
          const d = await api('/api/v2/fs/diff?path=' + encodeURIComponent(path) + '&ref=' + encodeURIComponent(ref) + (to ? '&to=' + encodeURIComponent(to) : ''));
          box.innerHTML = ''; box.append(renderDiff(d.diff));
        } catch (e) { box.innerHTML = ''; box.append(el('div', { class: 'err' }, e.message)); }
      }

      init();
      return {
        refresh: () => { if (mode !== 'edit' || !dirty) { editor = null; editorHost?.remove(); editorHost = null; init(); } },
        isDirty: () => dirty,
      };
    },
  });
})();
