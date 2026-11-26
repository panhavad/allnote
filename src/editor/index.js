// WYSIWYG note editor (Tiptap / ProseMirror) that reads and writes the app's Markdown dialect:
// wiki links [[Note#Heading|alias]], embeds ![[Note]], callouts > [!type] Title, ==highlight==, #tags,
// task lists, tables and single-newline line breaks.
// Built into public/vendor/editor.js by `npm run build:editor`.
import { Editor, Extension, Node, InputRule, mergeAttributes, createDocument } from '@tiptap/core';
import { Plugin, PluginKey, EditorState, TextSelection } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import StarterKit from '@tiptap/starter-kit';
import HardBreak from '@tiptap/extension-hard-break';
import Text from '@tiptap/extension-text';
import Code from '@tiptap/extension-code';
import { TaskList, TaskItem } from '@tiptap/extension-list';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Markdown } from 'tiptap-markdown';

const WIKI_RE = /^\[\[([^\]\n|#]+)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]/;
const TAG_RE = /(^|[\s(,;])#([\p{L}_][\p{L}\p{N}_/-]*)/gu;
const CALLOUT_TYPES = ['note', 'info', 'tip', 'success', 'question', 'warning', 'danger', 'bug', 'example', 'quote'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const escAttr = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const wikiSource = (a) => `[[${a.target}${a.heading ? `#${a.heading}` : ''}${a.alias ? `|${a.alias}` : ''}]]`;
const wikiLabel = (a) => a.alias || a.target + (a.heading ? ` › ${a.heading}` : '');

// ---------------------------------------------------------------- markdown-it rules
function wikiInline(state, silent) {
  if (state.src.charCodeAt(state.pos) !== 0x5b || state.src.charCodeAt(state.pos + 1) !== 0x5b) return false;
  const m = WIKI_RE.exec(state.src.slice(state.pos, state.posMax));
  if (!m) return false;
  if (!silent) {
    const t = state.push('wikilink', '', 0);
    t.meta = { target: m[1].trim(), heading: (m[2] || '').trim(), alias: m[3] ?? '' };
  }
  state.pos += m[0].length;
  return true;
}

function embedBlock(state, startLine, _endLine, silent) {
  if (state.sCount[startLine] - state.blkIndent >= 4) return false;
  const line = state.src.slice(state.bMarks[startLine] + state.tShift[startLine], state.eMarks[startLine]);
  const m = /^!\[\[([^\]\n|#]+)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\][ \t]*$/.exec(line);
  if (!m) return false;
  if (silent) return true;
  const t = state.push('embed', '', 0);
  t.meta = { target: m[1].trim(), heading: (m[2] || '').trim(), alias: m[3] ?? '' };
  t.map = [startLine, startLine + 1];
  state.line = startLine + 1;
  return true;
}

function markInline(state, silent) {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x3d || state.src.charCodeAt(start + 1) !== 0x3d) return false;
  const m = /^==(?=\S)([\s\S]*?\S)==/.exec(state.src.slice(start, state.posMax));
  if (!m) return false;
  if (!silent) {
    const max = state.posMax;
    state.push('mark_open', 'mark', 1);
    state.pos = start + 2;
    state.posMax = start + 2 + m[1].length;
    state.md.inline.tokenize(state);
    state.push('mark_close', 'mark', -1);
    state.posMax = max;
  }
  state.pos = start + m[0].length;
  return true;
}

const dataAttrs = (meta) => `data-target="${escAttr(meta.target)}" data-heading="${escAttr(meta.heading)}" data-alias="${escAttr(meta.alias)}"`;
const attrFromData = (name) => ({ default: '', parseHTML: (el) => el.getAttribute(`data-${name}`) || '', renderHTML: (a) => ({ [`data-${name}`]: a[name] }) });

// ---------------------------------------------------------------- wiki links
const WikiLink = Node.create({
  name: 'wikiLink',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addOptions: () => ({ resolve: null, bus: null }),
  addAttributes: () => ({ target: attrFromData('target'), heading: attrFromData('heading'), alias: attrFromData('alias') }),
  parseHTML: () => [{ tag: 'span[data-wikilink]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['span', mergeAttributes({ 'data-wikilink': '' }, HTMLAttributes), wikiLabel(node.attrs)],
  renderText: ({ node }) => wikiSource(node.attrs),
  addNodeView() {
    const { resolve, bus } = this.options;
    return ({ node }) => {
      let current = node;
      const a = document.createElement('a');
      a.href = '#';
      a.contentEditable = 'false';
      const paint = () => {
        const { target, heading } = current.attrs;
        const missing = Boolean(resolve) && !resolve(target);
        a.className = `wikilink${missing ? ' missing' : ''}`;
        a.dataset.target = target;
        a.dataset.heading = heading;
        a.textContent = wikiLabel(current.attrs);
        a.title = missing ? `${target}: not created yet, click to create it` : `Open ${target}`;
      };
      paint();
      bus?.addEventListener('refresh', paint);
      return {
        dom: a,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          paint();
          return true;
        },
        destroy: () => bus?.removeEventListener('refresh', paint),
        ignoreMutation: () => true,
      };
    };
  },
  addStorage: () => ({
    markdown: {
      serialize(state, node) {
        state.write(wikiSource(node.attrs));
      },
      parse: {
        setup(md) {
          if (md.__allnoteWiki) return;
          md.__allnoteWiki = true;
          md.inline.ruler.before('link', 'wikilink', wikiInline);
          md.renderer.rules.wikilink = (tokens, i) => `<span data-wikilink ${dataAttrs(tokens[i].meta)}>${escAttr(wikiLabel(tokens[i].meta))}</span>`;
        },
      },
    },
  }),
  addInputRules() {
    const { editor } = this;
    return [
      new InputRule({
        find: /\[\[([^\]\n|#]+)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]$/,
        handler: ({ state, range, match }) => {
          const attrs = { target: match[1].trim(), heading: (match[2] || '').trim(), alias: match[3] ?? '' };
          const $from = state.doc.resolve(range.from);
          const before = $from.parent.textBetween(0, $from.parentOffset, null, '\ufffc');
          // "![[Note]]" alone in a paragraph becomes an embed
          if (before === '!' && $from.parent.type.name === 'paragraph' && range.to >= $from.end() - 0) {
            state.tr.replaceWith($from.before(), $from.after(), editor.schema.nodes.embed.create(attrs));
            return;
          }
          state.tr.replaceWith(range.from, range.to, editor.schema.nodes.wikiLink.create(attrs));
        },
      }),
    ];
  },
});

// ---------------------------------------------------------------- embeds ![[Note]]
const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  addOptions: () => ({ renderEmbed: null, bus: null }),
  addAttributes: () => ({ target: attrFromData('target'), heading: attrFromData('heading'), alias: attrFromData('alias') }),
  parseHTML: () => [{ tag: 'div[data-embed]' }],
  renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes({ 'data-embed': '' }, HTMLAttributes)],
  addNodeView() {
    const { renderEmbed, bus } = this.options;
    return ({ node }) => {
      let current = node;
      const dom = document.createElement('div');
      dom.className = 'embed-block';
      dom.contentEditable = 'false';
      const paint = () => {
        dom.textContent = '';
        const out = renderEmbed?.(current.attrs);
        if (out) dom.append(out);
        else dom.textContent = `!${wikiSource(current.attrs)}`;
      };
      paint();
      bus?.addEventListener('refresh', paint);
      return {
        dom,
        update(n) {
          if (n.type !== current.type) return false;
          const changed = n.attrs.target !== current.attrs.target;
          current = n;
          if (changed) paint();
          return true;
        },
        destroy: () => bus?.removeEventListener('refresh', paint),
        ignoreMutation: () => true,
      };
    };
  },
  addStorage: () => ({
    markdown: {
      serialize(state, node) {
        state.write(`!${wikiSource(node.attrs)}`);
        state.closeBlock(node);
      },
      parse: {
        setup(md) {
          if (md.__allnoteEmbed) return;
          md.__allnoteEmbed = true;
          md.block.ruler.before('paragraph', 'embed', embedBlock, { alt: ['paragraph'] });
          md.renderer.rules.embed = (tokens, i) => `<div data-embed ${dataAttrs(tokens[i].meta)}></div>`;
        },
      },
    },
  }),
});

// ---------------------------------------------------------------- callouts > [!type] Title
const CalloutTitle = Node.create({
  name: 'calloutTitle',
  content: 'inline*',
  defining: true,
  parseHTML: () => [{ tag: 'div[data-callout-title]' }],
  renderHTML: () => ['div', { 'data-callout-title': '', class: 'callout-title' }, 0],
  addStorage: () => ({ markdown: { serialize() {}, parse: {} } }),
});

const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'calloutTitle block*',
  defining: true,
  addAttributes: () => ({
    type: { default: 'note', parseHTML: (el) => el.getAttribute('data-type') || 'note', renderHTML: (a) => ({ 'data-type': a.type }) },
    fold: { default: '', parseHTML: (el) => el.getAttribute('data-fold') || '', renderHTML: (a) => ({ 'data-fold': a.fold }) },
  }),
  parseHTML: () => [{ tag: 'div[data-callout]' }],
  renderHTML: ({ node, HTMLAttributes }) => ['div', mergeAttributes({ 'data-callout': '', class: `callout callout-${node.attrs.type}` }, HTMLAttributes), 0],
  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const dom = document.createElement('div');
      const head = document.createElement('div');
      head.className = 'callout-head';
      head.contentEditable = 'false';
      const select = document.createElement('select');
      select.setAttribute('aria-label', 'Callout type');
      select.title = 'Callout type';
      select.dataset.bare = '';
      const types = CALLOUT_TYPES.includes(node.attrs.type) ? CALLOUT_TYPES : [node.attrs.type, ...CALLOUT_TYPES];
      select.innerHTML = types.map((t) => `<option value="${escAttr(t)}">${escAttr(cap(t))}</option>`).join('');
      head.append(select);
      const body = document.createElement('div');
      body.className = 'callout-body';
      dom.append(head, body);
      const paint = () => {
        dom.className = `callout callout-${current.attrs.type}`;
        dom.dataset.type = current.attrs.type;
        select.value = current.attrs.type;
        select.disabled = !editor.isEditable;
      };
      paint();
      select.addEventListener('change', () => {
        const pos = getPos();
        if (typeof pos === 'number') editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'type', select.value));
      });
      return {
        dom,
        contentDOM: body,
        update(n) {
          if (n.type !== current.type) return false;
          current = n;
          paint();
          return true;
        },
        stopEvent: (e) => head.contains(e.target),
        ignoreMutation: (m) => head.contains(m.target),
      };
    };
  },
  addStorage: () => ({
    markdown: {
      serialize(state, node) {
        state.wrapBlock('> ', null, node, () => {
          state.write(`[!${node.attrs.type}]${node.attrs.fold}`);
          const title = node.firstChild;
          if (title.content.size) {
            state.write(' ');
            state.renderInline(title);
          }
          for (let i = 1; i < node.childCount; i++) {
            if (i === 1) state.write('\n');
            state.render(node.child(i), node, i);
          }
        });
      },
      parse: {
        // markdown-it renders "> [!type] Title" as a blockquote; turn those into callout markup.
        updateDOM(root) {
          [...root.querySelectorAll('blockquote')].reverse().forEach((bq) => {
            const p = bq.firstElementChild;
            if (!p || p.tagName !== 'P' || p.firstChild?.nodeType !== 3) return;
            const m = /^\[!([\w-]+)\]([+-]?)[ \t]*/.exec(p.firstChild.textContent);
            if (!m) return;
            p.firstChild.textContent = p.firstChild.textContent.slice(m[0].length);
            const title = document.createElement('div');
            title.setAttribute('data-callout-title', '');
            while (p.firstChild && p.firstChild.nodeName !== 'BR') {
              const n = p.firstChild;
              if (n.nodeType === 3 && n.textContent.includes('\n')) {
                const [first, ...rest] = n.textContent.split('\n');
                title.append(first);
                n.textContent = rest.join('\n');
                break;
              }
              title.append(n);
            }
            if (p.firstChild?.nodeName === 'BR') p.firstChild.remove();
            while (p.firstChild?.nodeType === 3 && !p.firstChild.textContent.trim()) p.firstChild.remove();
            if (!p.childNodes.length) p.remove();
            if (title.lastChild?.nodeType === 3) title.lastChild.textContent = title.lastChild.textContent.replace(/\s+$/, '');
            const div = document.createElement('div');
            div.setAttribute('data-callout', '');
            div.setAttribute('data-type', m[1].toLowerCase());
            div.setAttribute('data-fold', m[2]);
            div.append(title, ...bq.childNodes);
            bq.replaceWith(div);
          });
        },
      },
    },
  }),
});

// ---------------------------------------------------------------- marks & markdown tweaks
const MarkdownHighlight = Highlight.extend({
  addStorage: () => ({
    markdown: {
      serialize: { open: '==', close: '==', mixable: true, expelEnclosingWhitespace: true },
      parse: {
        setup(md) {
          if (md.__allnoteMark) return;
          md.__allnoteMark = true;
          md.inline.ruler.before('emphasis', 'mark', markInline);
        },
      },
    },
  }),
});

// Notes use single newlines as line breaks (marked `breaks: true`), so write them back the same way.
const LineBreak = HardBreak.extend({
  addStorage: () => ({
    markdown: {
      serialize(state, node, parent, index) {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write(state.inTable ? '<br>' : '\n');
            return;
          }
        }
      },
      parse: {},
    },
  }),
});

// Text is written back without HTML entity escaping so inline HTML in a note survives a round trip.
// After a line break the text starts a new source line, so "- x", "# x" or "1. x" there must be escaped,
// and a "|" inside a table cell must not split the cell.
const PlainText = Text.extend({
  addStorage: () => ({
    markdown: {
      serialize(state, node) {
        if (/\n$/.test(state.out)) state.atBlockStart = true;
        if (state.inTable) state.text(state.esc(node.text, state.atBlockStart).replace(/\|/g, '\\|'), false);
        else state.text(node.text);
      },
      parse: {},
    },
  }),
});

// Ctrl/Cmd+E belongs to the app (toggle reading view), not to inline code.
const InlineCode = Code.extend({ addKeyboardShortcuts: () => ({}) });

const tagKey = new PluginKey('allnoteTags');
function tagDecorations(doc) {
  const decos = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isText || node.marks.some((m) => m.type.spec.code || m.type.name === 'link')) return undefined;
    for (const m of node.text.matchAll(TAG_RE)) {
      const from = pos + m.index + m[1].length;
      decos.push(Decoration.inline(from, from + m[2].length + 1, { class: 'tag', 'data-tag': m[2], title: 'Ctrl+click to see all notes with this tag' }));
    }
    return undefined;
  });
  return DecorationSet.create(doc, decos);
}
const Tags = Extension.create({
  name: 'allnoteTags',
  addProseMirrorPlugins: () => [new Plugin({
    key: tagKey,
    state: { init: (_, s) => tagDecorations(s.doc), apply: (tr, old) => (tr.docChanged ? tagDecorations(tr.doc) : old) },
    props: { decorations: (s) => tagKey.getState(s) },
  })],
});

const Shortcuts = Extension.create({
  name: 'allnoteShortcuts',
  addKeyboardShortcuts() {
    return {
      'Mod-Enter': () => this.editor.commands.toggleTaskList(),
      'Mod-Shift-h': () => this.editor.commands.toggleHighlight(),
    };
  },
});

// markdown-it-task-lists ignores tasks without text ("- [ ] "); keep them as (empty) tasks.
const EmptyTasks = Extension.create({
  name: 'allnoteEmptyTasks',
  addStorage: () => ({
    markdown: {
      parse: {
        updateDOM(root) {
          root.querySelectorAll('li').forEach((li) => {
            if (li.classList.contains('task-list-item')) return;
            const host = li.firstElementChild?.tagName === 'P' && li.firstChild === li.firstElementChild ? li.firstElementChild : li;
            const t = host.firstChild;
            const m = t?.nodeType === 3 ? /^\[([ xX])\][ \t\u00a0]*$/.exec(t.textContent) : null;
            if (!m || (t.nextSibling && t.nextSibling.nodeName !== 'UL' && t.nextSibling.nodeName !== 'OL')) return;
            t.textContent = '';
            const box = document.createElement('input');
            box.type = 'checkbox';
            box.checked = m[1] !== ' ';
            li.classList.add('task-list-item');
            li.prepend(box);
            li.parentElement?.classList.add('contains-task-list');
          });
        },
      },
    },
  }),
});

// Task lists stay "tight" (no blank lines between items), like bullet lists.
const TightTaskList = TaskList.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      tight: { default: true, parseHTML: (el) => el.getAttribute('data-tight') !== 'false', renderHTML: (a) => ({ 'data-tight': a.tight ? 'true' : 'false' }) },
    };
  },
});

export function editorExtensions(opts = {}, bus = null) {
  return [
    StarterKit.configure({
      text: false,
      code: false,
      hardBreak: false,
      underline: false,
      link: { openOnClick: false, autolink: true, linkOnPaste: true, HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank', title: 'Ctrl+click to open' } },
    }),
    PlainText,
    InlineCode,
    LineBreak,
    EmptyTasks,
    TightTaskList,
    TaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    MarkdownHighlight,
    Image.configure({ inline: true }),
    WikiLink.configure({ resolve: opts.resolve || null, bus }),
    Embed.configure({ renderEmbed: opts.renderEmbed || null, bus }),
    Callout,
    CalloutTitle,
    Tags,
    Shortcuts,
    Placeholder.configure({
      includeChildren: true,
      showOnlyCurrent: false,
      placeholder: ({ editor: ed, node, pos }) => {
        if (node.type.name === 'calloutTitle') return cap(ed.state.doc.resolve(pos).parent.attrs.type || 'note');
        if (ed.isEmpty && node.type.name === 'paragraph') return opts.placeholder || 'Start writing...';
        return '';
      },
    }),
    Markdown.configure({ html: false, breaks: true, tightLists: true, bulletListMarker: '-', linkify: false, transformPastedText: true, transformCopiedText: true }),
  ];
}

// ---------------------------------------------------------------- public API
export function createEditor(element, opts = {}) {
  const bus = new EventTarget();
  let silent = false;
  const editor = new Editor({
    element,
    content: '',
    extensions: editorExtensions(opts, bus),
    editorProps: {
      attributes: { spellcheck: 'true', 'aria-label': 'Note content', 'aria-multiline': 'true', role: 'textbox' },
      handleKeyDown: (_view, e) => opts.onKeyDown?.(e) === true,
    },
    onUpdate: () => {
      if (!silent) opts.onChange?.();
    },
    onSelectionUpdate: () => opts.onSelection?.(),
    onBlur: () => opts.onBlur?.(),
  });

  const parse = (md) => createDocument(editor.storage.markdown.parser.parse(String(md ?? '')), editor.schema);
  const quiet = (fn) => {
    silent = true;
    try {
      fn();
    } finally {
      silent = false;
    }
  };

  return {
    editor,
    getMarkdown: () => editor.storage.markdown.getMarkdown().replace(/\n+$/, ''),
    /** Load a note: new document and a fresh undo history. */
    load(md) {
      quiet(() => {
        editor.view.updateState(EditorState.create({ doc: parse(md), plugins: editor.state.plugins }));
        // Let plugins apply their automatic fixes (e.g. a trailing paragraph) now, silently, not on the first click.
        editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
      });
    },
    /** Replace the content (e.g. after merging someone else's edit) and keep the cursor roughly in place. */
    replace(md) {
      quiet(() => {
        const { from, to } = editor.state.selection;
        const doc = parse(md);
        const tr = editor.state.tr.replaceWith(0, editor.state.doc.content.size, doc.content).setMeta('addToHistory', false);
        const max = tr.doc.content.size;
        try {
          tr.setSelection(TextSelection.create(tr.doc, Math.min(from, max), Math.min(to, max)));
        } catch { /* keep the mapped selection */ }
        editor.view.dispatch(tr);
      });
    },
    setEditable: (on) => editor.setEditable(on, false),
    focus: (where = 'end') => editor.commands.focus(where),
    hasFocus: () => editor.isFocused,
    refresh: () => bus.dispatchEvent(new Event('refresh')),
    /** Text of the current paragraph up to the cursor (inline nodes become U+FFFC). */
    textBeforeCursor() {
      const { $from, empty } = editor.state.selection;
      if (!empty || !$from.parent.isTextblock || $from.parent.type.spec.code) return '';
      return $from.parent.textBetween(0, $from.parentOffset, null, '\ufffc');
    },
    cursorCoords() {
      const c = editor.view.coordsAtPos(editor.state.selection.from);
      return { left: c.left, top: c.bottom };
    },
    /** Replace the `back` characters before the cursor with a wiki link to `title`. */
    insertWikiLink(back, title) {
      const { from } = editor.state.selection;
      editor.chain().focus()
        .insertContentAt({ from: from - back, to: from }, [{ type: 'wikiLink', attrs: { target: title, heading: '', alias: '' } }, { type: 'text', text: ' ' }])
        .run();
    },
    isActive: (name, attrs) => editor.isActive(name, attrs),
    exec(name, arg) {
      const c = editor.chain().focus();
      switch (name) {
        case 'bold': return c.toggleBold().run();
        case 'italic': return c.toggleItalic().run();
        case 'strike': return c.toggleStrike().run();
        case 'highlight': return c.toggleHighlight().run();
        case 'heading': {
          const level = [1, 2, 3].find((l) => editor.isActive('heading', { level: l }));
          return level === 3 ? c.setParagraph().run() : c.setHeading({ level: (level || 0) + 1 }).run();
        }
        case 'ul': return c.toggleBulletList().run();
        case 'ol': return c.toggleOrderedList().run();
        case 'task': return c.toggleTaskList().run();
        case 'quote': return c.toggleBlockquote().run();
        case 'callout': {
          const { from, to } = editor.state.selection;
          const text = editor.state.doc.textBetween(from, to, '\n');
          return c.insertContent({
            type: 'callout',
            attrs: { type: 'note' },
            content: [{ type: 'calloutTitle' }, { type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
          }).run();
        }
        case 'code': return editor.state.selection.empty || editor.isActive('codeBlock') ? c.toggleCodeBlock().run() : c.toggleCode().run();
        case 'link':
          if (!arg) return c.extendMarkRange('link').unsetLink().run();
          if (editor.state.selection.empty && !editor.isActive('link')) {
            return c.insertContent({ type: 'text', text: arg, marks: [{ type: 'link', attrs: { href: arg } }] }).run();
          }
          return c.extendMarkRange('link').setLink({ href: arg }).run();
        case 'wikilink': return c.insertContent('[[').run();
        case 'table': return c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
        case 'hr': return c.setHorizontalRule().run();
        default: return false;
      }
    },
    destroy: () => editor.destroy(),
  };
}
