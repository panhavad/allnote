// WYSIWYG editor round trip: Markdown -> editor -> Markdown must keep the note's meaning and syntax.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

let createEditor;
before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const g = globalThis;
  for (const k of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'DOMParser', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'Event', 'KeyboardEvent', 'ClipboardEvent', 'DragEvent', 'Text', 'DocumentFragment', 'Range', 'Selection']) {
    if (dom.window[k] !== undefined) Object.defineProperty(g, k, { value: dom.window[k], configurable: true, writable: true });
  }
  dom.window.document.getSelection = () => dom.window.getSelection();
  ({ createEditor } = await import('../public/vendor/editor.js'));
});

const roundTrip = (md, opts) => {
  const el = document.createElement('div');
  document.body.append(el);
  const ed = createEditor(el, opts);
  ed.load(md);
  const out = ed.getMarkdown();
  ed.destroy();
  el.remove();
  return out;
};

const SAME = [
  ['headings and paragraphs', '# Title\n\nSome text\n\n## Section\n\nMore text'],
  ['bold, italic, strike, code, highlight', 'A **bold**, *italic*, ~~gone~~, `code` and ==marked== word'],
  ['single-newline line breaks', 'line one\nline two\nline three'],
  ['wiki links with heading and alias', 'See [[Project Plan]], [[Roadmap#Q3]] and [[Budget|the budget]].'],
  ['embeds', 'Intro\n\n![[Meeting notes]]\n\nOutro'],
  ['tags', 'Tagged #work and #work/alpha here'],
  ['bullet, numbered and nested lists', '- one\n- two\n  - nested\n- three\n\n1. first\n2. second'],
  ['task lists', '- [ ] todo\n- [x] done'],
  ['callout with title and body', '> [!tip] Pro tip\n> Use **shortcuts**'],
  ['callout without title', '> [!warning]\n> Careful'],
  ['blockquote', '> quoted text'],
  ['tables', '| Name | Value |\n| --- | --- |\n| a | 1 |\n| b | 2 |'],
  ['code blocks', '```js\nconst x = 1 < 2;\n```'],
  ['links and images', '[site](https://example.com) and ![alt](https://example.com/a.png)'],
  ['horizontal rule', 'above\n\n---\n\nbelow'],
  ['inline html stays as typed', 'a <b>raw</b> & b'],
  ['nested task lists', '- [ ] parent\n  - [x] child'],
  ['numbered list starting at 3', '3. three\n4. four'],
  ['list inside a callout', '> [!note] Steps\n> - one\n> - two'],
  ['heading with a tag and a link', '## Plan #q3 for [[Roadmap]]'],
  ['mixed real note', '# Weekly\n\n> [!info] Status\n> On track\n\n## Tasks\n\n- [x] Ship **v1.1**\n- [ ] Review [[Budget]]\n\n| Owner | Due |\n| --- | --- |\n| Sam | Fri |\n\n![[Meeting notes]]\n\nThanks #team'],
  ['pipe inside a table cell', '| H1 | H2 |\n| --- | --- |\n| a \\| b | c |'],
  ['list marker after a line break stays text', 'Shopping\n\\- milk'],
  ['heading marker after a line break stays text', 'Intro\n\\# not a heading'],
];

test('loading or clicking into a note never reports a change', () => {
  const el = document.createElement('div');
  document.body.append(el);
  let changes = 0;
  const ed = createEditor(el, { onChange: () => { changes++; } });
  for (const md of ['* one\n* two', '| a | b |\n| :-- | --: |\n| 1 | 2 |', 'text\n\n---', '```\ncode\n```']) {
    ed.load(md);
    ed.editor.view.dispatch(ed.editor.state.tr.setSelection(ed.editor.state.selection)); // like a click
    ed.focus('end');
  }
  assert.equal(changes, 0);
  ed.destroy();
});

test('Ctrl/Cmd+E is left to the app (no inline-code shortcut)', () => {
  const el = document.createElement('div');
  document.body.append(el);
  const ed = createEditor(el);
  const code = ed.editor.extensionManager.extensions.find((x) => x.name === 'code');
  assert.deepEqual(Object.keys(code.config.addKeyboardShortcuts?.call({ editor: ed.editor }) || {}), []);
  ed.destroy();
});

for (const [name, md] of SAME) {
  test(`round trip: ${name}`, () => {
    assert.equal(roundTrip(md), md);
  });
}

test('daily note template survives editing', () => {
  const tpl = '## Tasks\n- [ ] \n\n## Notes\n\n\n---\n#daily';
  const out = roundTrip(tpl);
  assert.match(out, /^## Tasks\n\n- \[ \] ?\n/);
  assert.ok(!out.includes('\\['), 'the empty task keeps its checkbox');
  assert.match(out, /## Notes/);
  assert.match(out, /---\n\n#daily$/);
});

test('the editor shows wiki links as links, not as [[ ]] text', () => {
  const el = document.createElement('div');
  document.body.append(el);
  const ed = createEditor(el, { resolve: (t) => (t === 'Exists' ? { id: 1 } : null) });
  ed.load('Go to [[Exists]] or [[Missing]]');
  const links = [...el.querySelectorAll('a.wikilink')];
  assert.deepEqual(links.map((a) => a.textContent), ['Exists', 'Missing']);
  assert.deepEqual(links.map((a) => a.classList.contains('missing')), [false, true]);
  assert.ok(!el.textContent.includes('[['), 'no raw markdown syntax is visible');
  ed.destroy();
});

test('callouts render as one block with an editable title', () => {
  const el = document.createElement('div');
  document.body.append(el);
  const ed = createEditor(el);
  ed.load('> [!danger] Stop\n> Read this');
  const box = el.querySelector('.callout.callout-danger');
  assert.ok(box);
  assert.equal(box.querySelector('.callout-title').textContent, 'Stop');
  assert.ok(!el.textContent.includes('[!danger]'));
  ed.destroy();
});
