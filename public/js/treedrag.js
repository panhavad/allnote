// Pointer-based drag and drop for the sidebar tree. Works with a mouse (drag after a small move)
// and on touch screens (press and hold, then drag). The app decides what can be dragged and dropped where.
const HOLD_MS = 350;
const MOVE_PX = 6;
const EDGE_PX = 36;

/**
 * opts.describe(row|null) -> descriptor of a row (null = empty tree space / top level)
 * opts.canDrag(desc) -> boolean
 * opts.accept(src, target, zone) -> zone to use ('before' | 'after' | 'into' | 'root') or null
 * opts.label(src) -> text for the drag ghost
 * opts.onDrop(src, target, zone)
 * opts.expand(path) -> open a collapsed folder while hovering over it
 */
export function enableTreeDrag(tree, opts) {
  let pending = null;
  let drag = null;
  let suppressClick = false;

  const rowOf = (desc) => (desc.kind === 'note'
    ? tree.querySelector(`.row[data-id="${CSS.escape(desc.id)}"]${desc.parent ? `[data-parent="${CSS.escape(desc.parent)}"]` : ':not([data-parent])'}`)
    : tree.querySelector(`.row[data-folder="${CSS.escape(desc.path || desc.key)}"]`));

  const clearMarks = () => {
    tree.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach((r) => r.classList.remove('drop-before', 'drop-after', 'drop-into'));
    tree.classList.remove('drop-root');
  };

  const cancelPending = () => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };

  function start(x, y) {
    clearTimeout(pending.timer);
    const src = opts.describe(pending.row);
    drag = { id: pending.id, src, target: null, zone: null, hover: null, hoverTimer: null, y, sx: x, sy: y, moved: false, touch: pending.touch, row: pending.row };
    pending = null;
    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.textContent = opts.label(src);
    document.body.append(ghost);
    drag.ghost = ghost;
    document.body.classList.add('tree-dragging');
    navigator.vibrate?.(12);
    move(x, y);
    autoScroll();
  }

  function zoneFor(row, y) {
    const r = row.getBoundingClientRect();
    const rel = (y - r.top) / r.height;
    if (row.dataset.folder) {
      if (row.dataset.folder.startsWith('@')) return 'into';
      return rel < 0.25 ? 'before' : rel > 0.75 ? 'after' : 'into';
    }
    return rel < 0.5 ? 'before' : 'after';
  }

  function move(x, y) {
    drag.x = x;
    drag.y = y;
    if (Math.hypot(x - drag.sx, y - drag.sy) > 10) drag.moved = true;
    drag.ghost.style.transform = `translate(${x + 14}px, ${y + 10}px)`;
    rowOf(drag.src)?.classList.add('dragging');
    clearMarks();
    const hit = document.elementFromPoint(x, y);
    let target = null;
    let zone = null;
    if (hit && tree.contains(hit)) {
      const row = hit.closest('.row');
      target = opts.describe(row);
      zone = opts.accept(drag.src, target, row ? zoneFor(row, y) : 'root');
      if (zone === 'root') tree.classList.add('drop-root');
      else if (zone) row.classList.add(`drop-${zone}`);
    }
    drag.target = zone ? target : null;
    drag.zone = zone;
    // Hovering over a closed folder opens it.
    const hoverKey = zone === 'into' && target.kind === 'folder' ? target.path : null;
    if (hoverKey !== drag.hover) {
      clearTimeout(drag.hoverTimer);
      drag.hover = hoverKey;
      if (hoverKey) {
        drag.hoverTimer = setTimeout(() => {
          // Expanding re-renders the tree, so redraw the drop marker afterwards.
          if (drag && opts.expand(hoverKey)) move(drag.x, drag.y);
        }, 650);
      }
    }
  }

  function autoScroll() {
    if (!drag) return;
    const r = tree.getBoundingClientRect();
    if (drag.y < r.top + EDGE_PX) tree.scrollTop -= 10;
    else if (drag.y > r.bottom - EDGE_PX) tree.scrollTop += 10;
    requestAnimationFrame(autoScroll);
  }

  function finish(drop) {
    const d = drag;
    drag = null;
    clearTimeout(d.hoverTimer);
    d.ghost.remove();
    clearMarks();
    tree.querySelectorAll('.dragging').forEach((r) => r.classList.remove('dragging'));
    document.body.classList.remove('tree-dragging');
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 80);
    // Touch: press and hold without moving keeps opening the row's menu.
    if (d.touch && !d.moved) return drop && opts.onHold?.(d.row);
    if (drop && d.target && d.zone) opts.onDrop(d.src, d.target, d.zone);
  }

  tree.addEventListener('dragstart', (e) => e.preventDefault()); // rows are links; never start native link drags
  tree.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || drag) return;
    const row = e.target.closest('.row');
    if (!row || !opts.canDrag(opts.describe(row))) return;
    pending = { row, x: e.clientX, y: e.clientY, id: e.pointerId, touch: e.pointerType !== 'mouse' };
    if (pending.touch) pending.timer = setTimeout(() => pending && start(pending.x, pending.y), HOLD_MS);
  });
  window.addEventListener('pointermove', (e) => {
    if (drag && e.pointerId === drag.id) {
      e.preventDefault();
      move(e.clientX, e.clientY);
    } else if (pending && e.pointerId === pending.id) {
      const dist = Math.hypot(e.clientX - pending.x, e.clientY - pending.y);
      if (pending.touch) {
        if (dist > 10) cancelPending(); // the user is scrolling
      } else if (dist > MOVE_PX) {
        start(e.clientX, e.clientY);
      }
    }
  }, { passive: false });
  window.addEventListener('pointerup', (e) => {
    if (drag && e.pointerId === drag.id) finish(true);
    else cancelPending();
  });
  window.addEventListener('pointercancel', () => (drag ? finish(false) : cancelPending()));
  document.addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', (e) => {
    if (drag && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  }, true);
  // A long press must not open the context menu, and the click that ends a drag must not open the note.
  tree.addEventListener('contextmenu', (e) => {
    if (drag || pending?.touch) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);
  tree.addEventListener('click', (e) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, true);

  /** Redraw the drop marker if the tree was re-rendered during a drag (live updates, folder expand). */
  const refresh = () => { if (drag) move(drag.x, drag.y); };
  return { refresh, active: () => Boolean(drag) };
}
