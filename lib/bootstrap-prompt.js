// First-attach prompt that ttyd-attach.sh sends to the new claude session.
// Two flavors:
//   - 'greenfield' (skip / create + scaffold): claude greets, asks the
//     classic "what should we build here?" — stock fresh-project flow.
//   - 'scan-existing' (clone / onboard): claude reads the existing tree
//     and writes whichever of AGENTS.md / README.md is missing per V30,
//     leaving any pre-existing copy untouched per V29.
const fs = require('fs');
const path = require('path');

function writeBootstrapPrompt(dir, name, flavor) {
  const greenfield = `Read AGENTS.md and README.md in this directory, then briefly greet me and ask what I want to build here. Once we agree on the project, update README.md — rewrite the H1 (card title), rewrite the first paragraph (one-sentence card description), and set the 'tags: [...]' frontmatter to short tags like 'Game', 'Tool', 'API', 'Library', or 'Service' plus a status flag like 'WIP' or 'Stable'. The landing page reads all three from README.`;
  const scanExisting = `This is the freshly cloned project "${name}". Walk the tree (skip node_modules/, .git/, dist/, build/, .next/, .cache/) and figure out what it is. Then write whichever of these files is missing — never overwrite an existing one:\n\n` +
    `- README.md (human-facing): YAML frontmatter \`tags: [...]\` with two or three short tags (Game / Tool / API / Library / Service / etc., plus WIP or Stable). Then an H1 with the project's name. Then one paragraph that answers "what is this and why does it exist" the way you'd tell a stranger. The claude-hub landing page reads the H1, the first paragraph, and the tags into a card.\n` +
    `- AGENTS.md (agent-facing): tech stack, conventions, directory layout, debugging signposts ("if X breaks, look in Y"). Cite real file paths. Keep it terse — this is the doc future agents will read before touching the code.\n\n` +
    `When you're done, briefly summarize what you found and ask what I'd like to work on first.`;
  const text = flavor === 'scan-existing' ? scanExisting : greenfield;
  fs.writeFileSync(path.join(dir, '.claude-bootstrap.txt'), text + '\n');
}

module.exports = { writeBootstrapPrompt };
