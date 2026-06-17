const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cssPath = path.join(root, 'public', 'css', 'app.css');
const jsPath = path.join(root, 'public', 'js', 'ui.js');

function normalizeCRLF(str) {
  return str.replace(/\r\n/g, '\n');
}

// -- CSS repairs --
let css = normalizeCRLF(fs.readFileSync(cssPath, 'utf8'));

// Fix space-collapsed CSS values.
css = css.replace(/padding\s*:\s*6px10px\s*;/g, 'padding: 6px 10px;');
css = css.replace(/transition\s*:\s*all0\.2s/g, 'transition: all 0.2s');

const toolbarOverrides = `
/* Waypoints toolbar overrides */
@media (min-width: 768px) {
  .waypoints-header {
    flex-wrap: nowrap;
    gap:8px;
  }

  .waypoints-toolbar {
    flex-wrap: nowrap;
    gap: 6px;
    justify-content: flex-end;
  }

  /* Secondary toolbar buttons show icons only on desktop. */
  .waypoints-toolbar .toolbar-btn:not(.primary) span {
    display: none;
  }

  .waypoints-toolbar .toolbar-btn {
    padding:7px;
    border-radius: 8px;
  }

  .waypoints-toolbar .toolbar-btn.primary {
    padding: 7px 12px;
  }

  .waypoints-toolbar .toolbar-btn.primary span {
    display: inline;
  }
}

@media (max-width: 480px) {
  .waypoints-header {
    gap:6px;
  }

  .waypoints-toolbar {
    flex-wrap: wrap;
    gap: 5px;
    justify-content: flex-start;
  }

  .waypoints-toolbar .toolbar-btn {
    flex: 11 calc(33.333% - 4px);
    padding: 7px 0;
    font-size:0.7rem;
  }

  .waypoints-toolbar .toolbar-btn svg {
    width: 17px;
    height: 17px;
  }
}

@media (max-width: 360px) {
  .waypoints-toolbar .toolbar-btn span {
    display: none;
  }
}
`;

if (!css.includes('/* Waypoints toolbar overrides */')) {
  css = css.trimEnd() + '\n' + toolbarOverrides;
}

fs.writeFileSync(cssPath, css, 'utf8');
console.log('Repaired', cssPath);

// -- JS repairs (ui.js fullscreen SVGs) --
let js = normalizeCRLF(fs.readFileSync(jsPath, 'utf8'));

const brokenViewBox = /viewBox="002424"/g;
const brokenPath1 = /d="M516h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm611h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/g;
const brokenPath2 = /d="M714H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm127h-3v2h5v-5h-2v3zM145v2h3v3h2V5h-5z"/g;

js = js.replace(brokenViewBox, 'viewBox="0 02424"');
js = js.replace(
  brokenPath1,
  'd="M516 h3 v3 h2 v-5 H5 v2 z m3-8 H5 v2 h5 V5 H8 v3 z m611 h2 v-3 h3 v-2 h-5 v5 z m2-11 V5 h-2 v5 h5 V8 h-3 z"'
);
js = js.replace(
  brokenPath2,
  'd="M714 H5 v5 h5 v-2 H7 v-3 z m-2 -4 h2 V7 h3 V5 H5 v5 z m127 h-3 v2 h5 v-5 h-2 v3 z M145 v2 h3 v3 h2 V5 h-5 z"'
);

fs.writeFileSync(jsPath, js, 'utf8');
console.log('Repaired', jsPath);

// Simple sanity checks.
const outCss = fs.readFileSync(cssPath, 'utf8');
const outJs = fs.readFileSync(jsPath, 'utf8');
const remainingIssues = [];
if (/6px10px/.test(outCss)) remainingIssues.push('CSS still contains 6px10px');
if (/all0\.2s/.test(outCss)) remainingIssues.push('CSS still contains all0.2s');
if (/viewBox="002424"/.test(outJs)) remainingIssues.push('JS still contains viewBox="002424"');
if (remainingIssues.length) {
  console.warn('Remaining issues:', remainingIssues.join('; '));
  process.exit(1);
}
console.log('Sanity checks passed.');
