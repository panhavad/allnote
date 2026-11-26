// Lightweight guided tour: dims the page, spotlights one element per step and explains it.
import { icon } from './icons.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function visible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/**
 * steps: [{ target?: selector, title, text, icon? }]. Steps whose target is not visible are shown centered.
 * Returns a promise that resolves with true when finished, false when skipped.
 */
export function startTour(steps, { onStep } = {}) {
  document.querySelector('.tour')?.remove();
  return new Promise((resolve) => {
    let i = 0;
    const root = document.createElement('div');
    root.className = 'tour';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.innerHTML = '<div class="tour-spot"></div><div class="tour-card" tabindex="-1"></div>';
    document.body.append(root);
    const spot = root.querySelector('.tour-spot');
    const card = root.querySelector('.tour-card');

    const end = (finished) => {
      window.removeEventListener('resize', place);
      document.removeEventListener('keydown', onKey, true);
      root.remove();
      resolve(finished);
    };

    function place() {
      const s = steps[i];
      const el = s.target ? document.querySelector(s.target) : null;
      const pad = 6;
      if (visible(el)) {
        const r = el.getBoundingClientRect();
        Object.assign(spot.style, { display: 'block', top: `${r.top - pad}px`, left: `${r.left - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        let top = r.bottom + 14;
        let left = r.left + r.width / 2 - cw / 2;
        if (top + ch > innerHeight - 12) top = r.top - ch - 14;
        if (top < 12) { top = Math.max(12, r.top + r.height / 2 - ch / 2); left = r.right + 16 + cw < innerWidth ? r.right + 16 : r.left - cw - 16; }
        card.style.top = `${Math.max(12, Math.min(top, innerHeight - ch - 12))}px`;
        card.style.left = `${Math.max(12, Math.min(left, innerWidth - cw - 12))}px`;
        root.classList.remove('centered');
      } else {
        spot.style.display = 'none';
        card.style.top = `${Math.max(12, innerHeight / 2 - card.offsetHeight / 2)}px`;
        card.style.left = `${Math.max(12, innerWidth / 2 - card.offsetWidth / 2)}px`;
        root.classList.add('centered');
      }
    }

    function render() {
      const s = steps[i];
      onStep?.(s, i);
      const last = i === steps.length - 1;
      card.innerHTML = `
        <div class="tour-head">${icon(s.icon || 'compass', 20)}<b>${esc(s.title)}</b><span class="tour-count">${i + 1} / ${steps.length}</span></div>
        <p>${esc(s.text)}</p>
        <div class="tour-dots">${steps.map((_, k) => `<span class="${k === i ? 'on' : ''}"></span>`).join('')}</div>
        <div class="tour-actions">
          <button class="btn ghost sm" data-tour="skip">${last ? '' : 'Skip tour'}</button>
          <span class="spacer"></span>
          ${i ? `<button class="btn sm" data-tour="back">${icon('back', 14)} Back</button>` : ''}
          <button class="btn primary sm" data-tour="next">${last ? `${icon('check', 14)} Finish` : `Next ${icon('chevron', 14)}`}</button>
        </div>`;
      card.querySelector('[data-tour="skip"]').hidden = last;
      requestAnimationFrame(() => {
        place();
        card.querySelector('[data-tour="next"]').focus();
      });
    }

    const go = (d) => {
      i += d;
      if (i >= steps.length) return end(true);
      if (i < 0) i = 0;
      render();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); end(false); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    };
    card.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tour]');
      if (!b) return;
      if (b.dataset.tour === 'skip') end(false);
      else go(b.dataset.tour === 'back' ? -1 : 1);
    });
    window.addEventListener('resize', place);
    document.addEventListener('keydown', onKey, true);
    render();
  });
}
