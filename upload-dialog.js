// Shared upload-dialog widget. Two modes:
//   project mode  — opts.project locked to one project; folder picker is a
//                   datalist of dirs under that project (current behaviour).
//   anywhere mode — opts.anywhere=true; folder picker is a lazy treeview
//                   rooted at ~/projects so the file can land in any folder.
// Public API: window.UploadDialog.open({ project, path, lockProject, anywhere }).
(function () {
  if (window.UploadDialog) return;

  let dlg = null;
  let cachedProjects = null;

  function ensureDialog() {
    if (dlg) return dlg;

    const style = document.createElement('style');
    style.textContent = `
      dialog.upload-dialog { background:#0d1320; color:#e2e8f0;
        border:1px solid #1f2937; border-radius:14px; padding:0;
        max-width:520px; width:92%; }
      dialog.upload-dialog::backdrop { background:rgba(5,8,16,0.6); backdrop-filter:blur(2px); }
      dialog.upload-dialog form { padding:22px 24px 18px; margin:0; }
      dialog.upload-dialog h2 { margin:0 0 14px; font-size:1.1rem; font-weight:600; }
      dialog.upload-dialog label.field { display:block; margin:12px 0; font-size:0.85rem; color:#94a3b8; }
      dialog.upload-dialog label.field span { display:block; margin-bottom:4px; }
      dialog.upload-dialog input[type=text],
      dialog.upload-dialog input[type=file],
      dialog.upload-dialog select {
        width:100%; background:#131b2c; color:#e2e8f0;
        border:1px solid #1f2937; border-radius:6px; padding:8px 10px;
        font-family:inherit; font-size:0.92rem; box-sizing:border-box; }
      dialog.upload-dialog input:focus, dialog.upload-dialog select:focus { outline:none; border-color:#7dd3fc; }
      dialog.upload-dialog .ud-hint { font-size:0.78rem; color:#94a3b8; margin-top:4px; }
      dialog.upload-dialog .ud-err { color:#fca5a5; font-size:0.82rem; margin-top:10px; min-height:1.2em; }
      dialog.upload-dialog .ud-ok { color:#7dd3fc; font-size:0.82rem; margin-top:10px; min-height:1.2em; }
      dialog.upload-dialog .buttons { display:flex; justify-content:flex-end; gap:8px;
        margin-top:18px; padding-top:14px; border-top:1px solid #1f2937; }
      dialog.upload-dialog button.btn { background:rgba(125,211,252,0.1); color:#7dd3fc;
        border:1px solid transparent; border-radius:8px; padding:8px 16px;
        font-family:inherit; font-size:0.85rem; font-weight:600; cursor:pointer; }
      dialog.upload-dialog button.btn:hover { background:rgba(125,211,252,0.2); }
      dialog.upload-dialog button.btn.muted { color:#94a3b8; background:rgba(148,163,184,0.08); }
      dialog.upload-dialog button.btn.muted:hover { color:#e2e8f0; background:rgba(148,163,184,0.18); }
      dialog.upload-dialog button.btn[disabled] { cursor:progress; opacity:0.6; }

      /* Treeview */
      dialog.upload-dialog .ud-tree {
        background:#131b2c; border:1px solid #1f2937; border-radius:6px;
        max-height:240px; overflow:auto; padding:4px 0;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size:0.86rem; }
      dialog.upload-dialog .ud-tree ul { list-style:none; margin:0; padding:0; }
      dialog.upload-dialog .ud-tree ul ul { padding-left:14px; border-left:1px dotted #1f2937; margin-left:8px; }
      dialog.upload-dialog .ud-tree .row {
        display:flex; align-items:center; gap:4px; padding:2px 6px; border-radius:4px;
        cursor:pointer; color:#e2e8f0; user-select:none; }
      dialog.upload-dialog .ud-tree .row:hover { background:#0d1320; }
      dialog.upload-dialog .ud-tree .row.selected { background:rgba(125,211,252,0.18); color:#7dd3fc; }
      dialog.upload-dialog .ud-tree .caret {
        display:inline-block; width:14px; text-align:center;
        color:#94a3b8; font-size:0.7rem; transition: transform 0.1s; }
      dialog.upload-dialog .ud-tree .caret.open { transform: rotate(90deg); }
      dialog.upload-dialog .ud-tree .caret.empty { visibility:hidden; }
      dialog.upload-dialog .ud-tree .name { color:#7dd3fc; }
      dialog.upload-dialog .ud-tree .row.selected .name { color:#7dd3fc; }
      dialog.upload-dialog .ud-tree .loading { color:#94a3b8; font-style:italic; padding:2px 6px; font-size:0.8rem; }
    `;
    document.head.appendChild(style);

    dlg = document.createElement('dialog');
    dlg.className = 'upload-dialog';
    dlg.innerHTML = `
      <form id="ud-form">
        <h2>Upload file</h2>
        <label class="field" id="ud-project-field">
          <span>Project</span>
          <select id="ud-project" required></select>
        </label>
        <div class="field" id="ud-tree-field" hidden>
          <span>Folder (under <code>~/projects</code>)</span>
          <div class="ud-tree" id="ud-tree"><div class="loading">loading…</div></div>
          <div class="ud-hint">Click a folder to pick it. Use the path field below to add a new subfolder.</div>
        </div>
        <label class="field">
          <span id="ud-path-label">Folder (relative to project root)</span>
          <input type="text" id="ud-path" list="ud-paths" placeholder="(project root)" autocomplete="off">
          <datalist id="ud-paths"></datalist>
          <div class="ud-hint" id="ud-path-hint">Folder is created if missing. Leave blank for project root.</div>
        </label>
        <label class="field">
          <span>File</span>
          <input type="file" id="ud-file" required>
        </label>
        <label class="field">
          <span>Save as (optional)</span>
          <input type="text" id="ud-filename" placeholder="defaults to source filename">
        </label>
        <div class="ud-err" id="ud-err"></div>
        <div class="ud-ok" id="ud-ok"></div>
        <div class="buttons">
          <button type="button" class="btn muted" id="ud-cancel">Cancel</button>
          <button type="submit" class="btn" id="ud-submit">Upload</button>
        </div>
      </form>
    `;
    document.body.appendChild(dlg);

    const projectField = dlg.querySelector('#ud-project-field');
    const projectSel = dlg.querySelector('#ud-project');
    const treeField = dlg.querySelector('#ud-tree-field');
    const treeEl = dlg.querySelector('#ud-tree');
    const pathInput = dlg.querySelector('#ud-path');
    const pathLabel = dlg.querySelector('#ud-path-label');
    const pathHint = dlg.querySelector('#ud-path-hint');
    const fileInput = dlg.querySelector('#ud-file');
    const filenameInput = dlg.querySelector('#ud-filename');
    const err = dlg.querySelector('#ud-err');
    const ok = dlg.querySelector('#ud-ok');
    const submit = dlg.querySelector('#ud-submit');
    const cancel = dlg.querySelector('#ud-cancel');
    const form = dlg.querySelector('#ud-form');

    cancel.addEventListener('click', () => dlg.close('cancel'));
    projectSel.addEventListener('change', () => refreshProjectFolders(projectSel.value));

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      ok.textContent = '';
      const mode = dlg.dataset.mode;
      const p = pathInput.value.trim().replace(/^\/+|\/+$/g, '');
      const file = fileInput.files[0];
      if (!file) { err.textContent = 'pick a file'; return; }
      if (mode === 'project') {
        const project = projectSel.value;
        if (!project) { err.textContent = 'pick a project'; return; }
        await runUpload({ mode: 'project', project, path: p, file, filename: filenameInput.value.trim() });
      } else {
        if (!p) { err.textContent = 'pick a folder'; return; }
        await runUpload({ mode: 'anywhere', path: p, file, filename: filenameInput.value.trim() });
      }
    });

    async function runUpload(req) {
      submit.disabled = true;
      cancel.disabled = true;
      try {
        const data = await doUpload(req, false);
        ok.textContent = 'Uploaded → ' + data.path;
        window.dispatchEvent(new CustomEvent('upload-complete', { detail: data }));
        setTimeout(() => dlg.close('ok'), 400);
      } catch (e) {
        if (e && e.message !== 'cancelled' && !err.textContent) err.textContent = e.message || 'upload failed';
      } finally {
        submit.disabled = false;
        cancel.disabled = false;
      }
    }

    async function doUpload(req, overwrite) {
      const fd = new FormData();
      fd.append('path', req.path);
      if (req.filename) fd.append('filename', req.filename);
      fd.append('file', req.file);
      const url = req.mode === 'project'
        ? '/api/upload/' + encodeURIComponent(req.project) + (overwrite ? '?overwrite=1' : '')
        : '/api/upload-anywhere' + (overwrite ? '?overwrite=1' : '');
      const r = await fetch(url, { method: 'POST', body: fd });
      let data = {};
      try { data = await r.json(); } catch {}
      if (r.status === 409) {
        if (confirm('File already exists at ' + data.path + '. Overwrite?')) {
          return doUpload(req, true);
        }
        throw new Error('cancelled');
      }
      if (!r.ok) {
        err.textContent = data.error || ('HTTP ' + r.status);
        throw new Error(data.error || ('HTTP ' + r.status));
      }
      return data;
    }

    async function refreshProjectFolders(project) {
      const list = dlg.querySelector('#ud-paths');
      list.innerHTML = '';
      if (!project) return;
      try {
        const r = await fetch('/api/view-tree/' + encodeURIComponent(project));
        if (!r.ok) return;
        const data = await r.json();
        const dirs = [];
        function walk(nodes, prefix) {
          for (const n of (nodes || [])) {
            if (n.type !== 'dir') continue;
            const rel = prefix ? prefix + '/' + n.name : n.name;
            dirs.push(rel);
            if (n.children) walk(n.children, rel);
          }
        }
        walk(data.tree || [], '');
        dirs.sort();
        for (const d of dirs) {
          const opt = document.createElement('option');
          opt.value = d;
          list.appendChild(opt);
        }
      } catch {}
    }

    // ---------- Treeview (anywhere mode) ----------
    async function loadDirs(parentRel) {
      try {
        const url = '/api/browse-dirs' + (parentRel ? '?path=' + encodeURIComponent(parentRel) : '');
        const r = await fetch(url);
        if (!r.ok) return [];
        const data = await r.json();
        return data.dirs || [];
      } catch { return []; }
    }

    function renderTreeNode(name, rel) {
      const li = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'row';
      row.dataset.path = rel;
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.textContent = '▸';
      const nameSpan = document.createElement('span');
      nameSpan.className = 'name';
      nameSpan.textContent = name;
      row.appendChild(caret);
      row.appendChild(nameSpan);
      li.appendChild(row);
      const childrenUl = document.createElement('ul');
      childrenUl.hidden = true;
      li.appendChild(childrenUl);

      let loaded = false;
      async function toggle() {
        if (!loaded) {
          loaded = true;
          childrenUl.innerHTML = '<li><div class="loading">loading…</div></li>';
          childrenUl.hidden = false;
          caret.classList.add('open');
          const dirs = await loadDirs(rel);
          childrenUl.innerHTML = '';
          if (dirs.length === 0) {
            caret.classList.add('empty');
            childrenUl.hidden = true;
            caret.classList.remove('open');
            return;
          }
          for (const d of dirs) {
            childrenUl.appendChild(renderTreeNode(d.name, rel + '/' + d.name));
          }
          return;
        }
        const isOpen = !childrenUl.hidden;
        childrenUl.hidden = isOpen;
        caret.classList.toggle('open', !isOpen);
      }

      caret.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle();
      });
      row.addEventListener('click', () => {
        // Mark selected + sync to path input.
        treeEl.querySelectorAll('.row.selected').forEach((r) => r.classList.remove('selected'));
        row.classList.add('selected');
        pathInput.value = rel;
        // Auto-expand the first time the user picks a node.
        if (!loaded) toggle();
      });

      return li;
    }

    async function loadTreeRoot(initialPath) {
      treeEl.innerHTML = '<div class="loading">loading…</div>';
      const dirs = await loadDirs('');
      if (dirs.length === 0) {
        treeEl.innerHTML = '<div class="loading">no folders under ~/projects</div>';
        return;
      }
      const ul = document.createElement('ul');
      for (const d of dirs) ul.appendChild(renderTreeNode(d.name, d.name));
      treeEl.innerHTML = '';
      treeEl.appendChild(ul);

      // If caller passed an initial path, expand toward it and select.
      if (initialPath) {
        const segments = initialPath.split('/').filter(Boolean);
        let cur = '';
        let currentList = ul;
        for (let i = 0; i < segments.length; i++) {
          cur = cur ? cur + '/' + segments[i] : segments[i];
          const row = currentList.querySelector(`:scope > li > .row[data-path="${CSS.escape(cur)}"]`);
          if (!row) break;
          const li = row.parentElement;
          const isLast = i === segments.length - 1;
          if (isLast) {
            row.click();
          } else {
            // Click caret to expand; wait for children to load.
            const caret = row.querySelector('.caret');
            caret.click();
            await new Promise((r) => setTimeout(r, 50));
            currentList = li.querySelector(':scope > ul');
            if (!currentList) break;
          }
        }
      }
    }

    dlg._setMode = function (mode, opts) {
      dlg.dataset.mode = mode;
      if (mode === 'anywhere') {
        projectField.hidden = true;
        projectSel.removeAttribute('required');
        treeField.hidden = false;
        pathLabel.textContent = 'Folder (relative to ~/projects)';
        pathHint.textContent = 'Folder is created if missing. Required — pick a node above or type a path.';
        pathInput.placeholder = 'e.g. claude-hub/uploads';
        loadTreeRoot(opts.path || '');
      } else {
        projectField.hidden = false;
        projectSel.setAttribute('required', 'required');
        treeField.hidden = true;
        pathLabel.textContent = 'Folder (relative to project root)';
        pathHint.textContent = 'Folder is created if missing. Leave blank for project root.';
        pathInput.placeholder = '(project root)';
      }
    };

    return dlg;
  }

  async function fetchProjects() {
    if (cachedProjects) return cachedProjects;
    try {
      const r = await fetch('/api/projects');
      if (!r.ok) return [];
      const data = await r.json();
      cachedProjects = (data.projects || []).map((p) => p.name);
      return cachedProjects;
    } catch {
      return [];
    }
  }

  async function open(opts) {
    opts = opts || {};
    const d = ensureDialog();
    const projectSel = d.querySelector('#ud-project');
    const pathInput = d.querySelector('#ud-path');
    const fileInput = d.querySelector('#ud-file');
    const filenameInput = d.querySelector('#ud-filename');
    const err = d.querySelector('#ud-err');
    const ok = d.querySelector('#ud-ok');
    err.textContent = '';
    ok.textContent = '';
    fileInput.value = '';
    filenameInput.value = '';

    const mode = opts.anywhere ? 'anywhere' : 'project';
    d._setMode(mode, opts);

    if (mode === 'project') {
      const list = await fetchProjects();
      projectSel.innerHTML = '';
      const names = [...list];
      if (opts.project && !names.includes(opts.project)) names.unshift(opts.project);
      for (const name of names) {
        const o = document.createElement('option');
        o.value = name; o.textContent = name;
        projectSel.appendChild(o);
      }
      if (opts.project) projectSel.value = opts.project;
      projectSel.disabled = !!opts.lockProject && !!opts.project;
      pathInput.value = opts.path || '';
      projectSel.dispatchEvent(new Event('change'));
    } else {
      pathInput.value = opts.path || '';
    }

    d.showModal();
  }

  window.UploadDialog = { open };
})();
