const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startFixture } = require('./helpers/fixture');

// V38: develop pane must span the full <main> width — sibling of the
// (tree | work-area) row, NOT nested inside work-area. Otherwise the
// terminal only fills the area below the file-tabs row instead of the
// full horizontal viewport.
test('V38: develop-pane is a direct child of <main>, not nested in work-area', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'demo'));
    fs.writeFileSync(path.join(fx.projectsRoot, 'demo', 'README.md'), '# hi\n');
    fs.writeFileSync(
      path.join(fx.projectsRoot, 'demo', '.project-meta.json'),
      JSON.stringify({ name: 'demo', createdAt: new Date().toISOString() })
    );

    const r = await fetch(fx.url + '/view/demo/');
    assert.equal(r.status, 200);
    const html = await r.text();

    // Top row wraps tree-pane + work-area.
    assert.match(html, /<div class="top-row"/, 'expected <div class="top-row">');

    // work-area must close before develop-pane / develop-splitter appear.
    const workAreaOpen = html.indexOf('class="work-area"');
    const developPaneIdx = html.indexOf('id="develop-pane"');
    const developSplitterIdx = html.indexOf('id="develop-splitter"');
    assert.ok(workAreaOpen >= 0, 'work-area present');
    assert.ok(developPaneIdx > workAreaOpen, 'develop-pane after work-area');

    // Crucial check: between work-area open and the closing </main> tag, the
    // </div> closing work-area must come before develop-pane.
    const mainCloseIdx = html.indexOf('</main>');
    const slice = html.slice(workAreaOpen, mainCloseIdx);
    // First "</div>" inside slice should close work-area; develop-pane must
    // appear AFTER it (i.e., as a sibling of top-row, not nested in work-area).
    const firstCloseDivAfterWorkArea = slice.indexOf('</div>');
    const developPaneInSlice = slice.indexOf('id="develop-pane"');
    assert.ok(firstCloseDivAfterWorkArea >= 0, 'work-area must have a closing </div>');
    assert.ok(
      developPaneInSlice > firstCloseDivAfterWorkArea,
      'develop-pane must be a sibling of (tree+work-area) row, not nested in work-area'
    );

    // Develop-splitter likewise sits at <main> level, not inside work-area.
    assert.ok(developSplitterIdx > workAreaOpen, 'develop-splitter after work-area open');
    const splitterInSlice = slice.indexOf('id="develop-splitter"');
    assert.ok(
      splitterInSlice > firstCloseDivAfterWorkArea,
      'develop-splitter must sit at <main> level, not nested in work-area'
    );
  } finally {
    await fx.close();
  }
});

test('V38: <main> uses column flex so develop-pane stacks below the row', async () => {
  const fx = await startFixture();
  try {
    fs.mkdirSync(path.join(fx.projectsRoot, 'demo'));
    fs.writeFileSync(path.join(fx.projectsRoot, 'demo', 'README.md'), '# hi\n');
    fs.writeFileSync(
      path.join(fx.projectsRoot, 'demo', '.project-meta.json'),
      JSON.stringify({ name: 'demo', createdAt: new Date().toISOString() })
    );
    const r = await fetch(fx.url + '/view/demo/');
    const html = await r.text();
    assert.match(
      html,
      /main\s*\{[^}]*flex-direction:\s*column/,
      '<main> CSS must declare flex-direction: column'
    );
  } finally {
    await fx.close();
  }
});
