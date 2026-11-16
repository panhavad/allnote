import { Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export { esc as escapeHtml };

// Remove fenced and inline code so links/tags inside code are ignored.
export const stripCode = (md) => String(md || '').replace(/(```|~~~)[\s\S]*?(\1|$)/g, '').replace(/`[^`\n]*`/g, '');

const TAG_RE = /(^|[\s(,;])#([\p{L}_][\p{L}\p{N}_/-]*)/gu;
const LINK_RE = /!?\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;

export function extractTags(md) {
  const out = new Set();
  for (const m of stripCode(md).matchAll(TAG_RE)) out.add(m[2].replace(/[/-]+$/, ''));
  return [...out];
}

export function extractLinks(md) {
  const out = new Set();
  for (const m of stripCode(md).matchAll(LINK_RE)) out.add(m[1].trim());
  return [...out];
}

export function extractHeadings(md) {
  const out = [];
  let fence = false;
  String(md || '').split('\n').forEach((line, i) => {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) out.push({ level: m[1].length, text: m[2].replace(/[*_`=~[\]]/g, ''), line: i });
  });
  return out;
}

export function plainText(md) {
  return stripCode(md)
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b || a)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[#>\s-]*\[[ xX]\]\s*/gm, '')
    .replace(/\[![\w-]+\][+-]?/g, '')
    .replace(/[#>*_~=`|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const wordCount = (md) => (plainText(md).match(/\S+/g) || []).length;

// Top-level markdown blocks with source offsets (token raws concatenate back to the exact source).
const blockLexer = new Marked({ gfm: true, breaks: true });
export function splitBlocks(src) {
  const out = [];
  let pos = 0;
  for (const t of blockLexer.lexer(String(src || ''))) {
    if (t.type !== 'space') {
      const text = t.raw.replace(/\n+$/, '');
      if (text.trim()) out.push({ start: pos, end: pos + text.length });
    }
    pos += t.raw.length;
  }
  return out;
}

// Toggle the n-th task list checkbox in the markdown source.
export function toggleTask(md, index) {
  let fence = false;
  let n = -1;
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\])/.exec(lines[i]);
    if (m && ++n === index) {
      lines[i] = m[1] + (m[2] === ' ' ? 'x' : ' ') + m[3] + lines[i].slice(m[0].length);
      return lines.join('\n');
    }
  }
  return md;
}

function buildMarked(opts) {
  const depth = opts.depth || 0;
  const marked = new Marked({ gfm: true, breaks: true });

  const embed = {
    name: 'embed',
    level: 'block',
    start: (src) => {
      const m = /^!\[\[/m.exec(src);
      return m ? m.index : undefined;
    },
    tokenizer(src) {
      const m = /^!\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\][ \t]*(?:\n|$)/.exec(src);
      if (m) return { type: 'embed', raw: m[0], target: m[1].trim() };
    },
    renderer(t) {
      if (opts.publicMode || !opts.resolve) return `<p><span class="wikilink">${esc(t.target)}</span></p>`;
      const note = opts.resolve(t.target);
      if (!note) return `<div class="embed missing">Note “${esc(t.target)}” not found</div>`;
      const inner = depth >= 1
        ? `<p class="muted">${esc(plainText(note.content).slice(0, 300))}</p>`
        : renderHtml(note.content, { ...opts, depth: depth + 1 });
      return `<div class="embed"><div class="embed-head"><a href="#" class="wikilink" data-target="${esc(note.title)}">${esc(note.title || 'Untitled')}</a></div>${inner}</div>`;
    },
  };

  const wikilink = {
    name: 'wikilink',
    level: 'inline',
    start: (src) => {
      const i = src.indexOf('[[');
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^\[\[([^\]\n|#]+)(?:#([^\]\n|]*))?(?:\|([^\]\n]*))?\]\]/.exec(src);
      if (m) return { type: 'wikilink', raw: m[0], target: m[1].trim(), heading: (m[2] || '').trim(), alias: m[3] };
    },
    renderer(t) {
      const label = esc(t.alias || t.target + (t.heading ? ` › ${t.heading}` : ''));
      if (opts.publicMode || !opts.resolve) return `<span class="wikilink">${label}</span>`;
      const exists = opts.resolve(t.target);
      return `<a href="#" class="wikilink${exists ? '' : ' missing'}" data-target="${esc(t.target)}" data-heading="${esc(t.heading)}">${label}</a>`;
    },
  };

  const tag = {
    name: 'tag',
    level: 'inline',
    start: (src) => {
      const m = /(^|[\s(,;])#[\p{L}_]/u.exec(src);
      return m ? m.index + m[1].length : undefined;
    },
    tokenizer(src) {
      const m = /^#([\p{L}_][\p{L}\p{N}_/-]*)/u.exec(src);
      if (m) return { type: 'tag', raw: m[0], tag: m[1] };
    },
    renderer: (t) => (opts.publicMode
      ? `<span class="tag">#${esc(t.tag)}</span>`
      : `<a href="#" class="tag" data-tag="${esc(t.tag)}">#${esc(t.tag)}</a>`),
  };

  const highlight = {
    name: 'highlight',
    level: 'inline',
    start: (src) => {
      const i = src.indexOf('==');
      return i < 0 ? undefined : i;
    },
    tokenizer(src) {
      const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
      if (m) return { type: 'highlight', raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer(t) {
      return `<mark>${this.parser.parseInline(t.tokens)}</mark>`;
    },
  };

  marked.use({ extensions: [embed, wikilink, tag, highlight] });
  return marked;
}

function renderHtml(md, opts) {
  return buildMarked(opts).parse(String(md || ''));
}

const slug = (s) => s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');

/**
 * Render markdown into a DOM element (sanitised) and apply Obsidian-like enhancements.
 * opts.resolve(title) -> note|null, opts.publicMode, opts.interactiveTasks
 */
export function renderInto(el, md, opts = {}) {
  el.innerHTML = DOMPurify.sanitize(renderHtml(md, opts), { ADD_ATTR: ['target'] });

  const seen = new Map();
  el.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach((h) => {
    let id = slug(h.textContent) || 'section';
    const n = seen.get(id) || 0;
    seen.set(id, n + 1);
    if (n) id += `-${n}`;
    h.id = id;
  });

  // Callouts: > [!note] Title
  el.querySelectorAll('blockquote').forEach((bq) => {
    const p = bq.firstElementChild;
    if (!p || p.tagName !== 'P' || p.firstChild?.nodeType !== 3) return;
    const first = p.firstChild;
    const m = /^\[!([\w-]+)\]([+-]?)[ \t]*([^\n]*)/.exec(first.textContent);
    if (!m) return;
    const type = m[1].toLowerCase();
    bq.classList.add('callout', `callout-${type}`);
    const nl = first.textContent.indexOf('\n');
    first.textContent = nl >= 0 ? first.textContent.slice(nl + 1) : '';
    if (!first.textContent) first.remove();
    while (p.firstChild && (p.firstChild.nodeName === 'BR' || (p.firstChild.nodeType === 3 && !p.firstChild.textContent.trim()))) p.firstChild.remove();
    if (!p.textContent.trim() && !p.querySelector('img')) p.remove();
    const title = document.createElement('div');
    title.className = 'callout-title';
    title.textContent = m[3] || type.charAt(0).toUpperCase() + type.slice(1);
    bq.prepend(title);
  });

  let taskIndex = 0;
  el.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    const embedded = Boolean(cb.closest('.embed'));
    if (!embedded) cb.dataset.task = taskIndex++;
    cb.disabled = embedded || !opts.interactiveTasks;
    cb.closest('li')?.classList.add('task');
    if (cb.checked) cb.closest('li')?.classList.add('done');
  });

  el.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (/^https?:\/\//i.test(href)) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  });
}
