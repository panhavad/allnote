// Static UI guarantees: no emoji, every referenced icon exists, theme toggle and version on every page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PUBLIC = path.join(import.meta.dirname, '..', 'public');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
const sources = files(PUBLIC).filter((f) => /\.(js|html|css)$/.test(f)).map((f) => ({ f: path.relative(PUBLIC, f), s: fs.readFileSync(f, 'utf8') }));
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');

test('no emoji anywhere in the front-end', () => {
  for (const { f, s } of sources) {
    const hit = s.match(/\p{Extended_Pictographic}/u);
    assert.equal(hit, null, `${f} contains ${hit?.[0]} (U+${hit?.[0].codePointAt(0).toString(16)})`);
  }
});

test('every icon used in the UI exists in the icon set', () => {
  const iconSrc = read('js/icons.js');
  const defined = new Set([...iconSrc.matchAll(/^\s{2}(\w+): '/gm)].map((m) => m[1]));
  const used = new Set();
  for (const { s } of sources) {
    const code = s.replace(/^\s*\/\/.*$/gm, '');
    for (const m of code.matchAll(/data-icon="(\w+)"|icon\('(\w+)'|icon: '(\w+)'/g)) used.add(m[1] || m[2] || m[3]);
  }
  const common = read('js/common.js');
  const nameMap = /NAME_ICONS = \{([^}]+)\}/.exec(common)[1];
  for (const m of nameMap.matchAll(/'(\w+)'/g)) used.add(m[1]);
  for (const m of common.matchAll(/return '(\w+)'/g)) used.add(m[1]);
  const missing = [...used].filter((n) => !defined.has(n));
  assert.deepEqual(missing, [], `icons used but not defined: ${missing.join(', ')}`);
});

test('every page supports light and dark mode and shows the version', () => {
  for (const page of ['index.html', 'landing.html', 'publish.html']) {
    const html = read(page);
    assert.match(html, /src="\/js\/theme\.js"/, `${page} applies the saved theme before paint`);
    assert.match(html, /data-theme-toggle/, `${page} has a theme toggle`);
  }
  const css = read('css/app.css');
  assert.match(css, /\[data-theme="dark"\] \{/);
  const index = read('index.html');
  const auth = index.slice(index.indexOf('id="auth"'), index.indexOf('id="app"'));
  const app = index.slice(index.indexOf('id="app"'));
  assert.match(auth, /class="app-version"/, 'version on the sign-in page');
  assert.match(app, /class="app-version"/, 'version inside the app');
  assert.match(read('landing.html'), /class="app-version"/, 'version on the landing page');
});

test('form inputs get icons automatically, except the editor surfaces', () => {
  const common = read('js/common.js');
  assert.match(common, /export function autoFieldIcons/);
  for (const page of ['js/app.js', 'js/publish.js']) assert.match(read(page), /autoFieldIcons\(\)/, `${page} enables field icons`);
  const index = read('index.html');
  for (const id of ['ed-title', 'search', 'ed-notebook']) assert.match(index, new RegExp(`id="${id}"[^>]*data-bare`), `${id} keeps its own design`);
});
