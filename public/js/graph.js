// Force-directed note graph rendered on a canvas. Everything is computed client-side.
export function createGraph(canvas, { nodes, edges, currentId, onOpen }) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const css = getComputedStyle(document.documentElement);
  const color = (v, d) => css.getPropertyValue(v).trim() || d;
  const colors = {
    node: color('--text', '#111'),
    current: color('--text', '#111'),
    tag: color('--muted', '#888'),
    edge: color('--border-strong', '#999'),
    text: color('--text', '#222'),
    muted: color('--muted', '#888'),
  };

  const byId = new Map(nodes.map((n, i) => {
    const a = (i / nodes.length) * Math.PI * 2;
    const r = 80 + Math.random() * 120;
    Object.assign(n, { x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, deg: 0 });
    return [n.id, n];
  }));
  const links = edges.map(([a, b]) => ({ s: byId.get(a), t: byId.get(b) })).filter((l) => l.s && l.t);
  links.forEach((l) => { l.s.deg++; l.t.deg++; });

  let view = { x: 0, y: 0, k: 1 };
  let drag = null;
  let pan = null;
  let hover = null;
  let alpha = 1;
  let raf = 0;

  function resize() {
    const r = canvas.getBoundingClientRect();
    canvas.width = r.width * dpr;
    canvas.height = r.height * dpr;
  }

  function fit() {
    if (!nodes.length) return;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    const r = canvas.getBoundingClientRect();
    const k = Math.min(2, (r.width - 160) / Math.max(1, x1 - x0), (r.height - 120) / Math.max(1, y1 - y0));
    view = { k, x: -((x0 + x1) / 2) * k, y: -((y0 + y1) / 2) * k };
  }

  const radius = (n) => (n.kind === 'tag' ? 4 : 5) + Math.min(10, Math.sqrt(n.deg) * 2.2);

  function tick() {
    const ns = nodes;
    for (let i = 0; i < ns.length; i++) {
      for (let j = i + 1; j < ns.length; j++) {
        const a = ns[i], b = ns[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d2 = dx * dx + dy * dy || 0.01;
        if (d2 > 640000) continue;
        const f = (5000 / d2) * alpha;
        const d = Math.sqrt(d2);
        dx /= d; dy /= d;
        a.vx -= dx * f; a.vy -= dy * f;
        b.vx += dx * f; b.vy += dy * f;
      }
    }
    for (const l of links) {
      const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = ((d - 120) / d) * 0.05 * alpha;
      l.s.vx += dx * f; l.s.vy += dy * f;
      l.t.vx -= dx * f; l.t.vy -= dy * f;
    }
    for (const n of ns) {
      n.vx -= n.x * 0.002 * alpha;
      n.vy -= n.y * 0.002 * alpha;
      if (n === drag?.node) continue;
      n.x += n.vx; n.y += n.vy;
      n.vx *= 0.6; n.vy *= 0.6;
    }
    alpha = Math.max(alpha * 0.985, 0.02);
  }

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.setTransform(view.k * dpr, 0, 0, view.k * dpr, w / 2 + view.x * dpr, h / 2 + view.y * dpr);
    const near = hover ? new Set([hover, ...links.filter((l) => l.s === hover || l.t === hover).flatMap((l) => [l.s, l.t])]) : null;
    ctx.lineWidth = 1 / view.k;
    for (const l of links) {
      ctx.strokeStyle = colors.edge;
      ctx.globalAlpha = near && !(near.has(l.s) && near.has(l.t)) ? 0.1 : 0.5;
      ctx.beginPath(); ctx.moveTo(l.s.x, l.s.y); ctx.lineTo(l.t.x, l.t.y); ctx.stroke();
    }
    ctx.font = `${12 / Math.max(view.k, 0.6)}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    for (const n of nodes) {
      ctx.globalAlpha = near && !near.has(n) ? 0.2 : 1;
      ctx.fillStyle = n.id === currentId ? colors.current : n.kind === 'tag' ? colors.tag : colors.node;
      const r = radius(n);
      ctx.beginPath(); ctx.arc(n.x, n.y, r, 0, Math.PI * 2); ctx.fill();
      if (n.id === currentId) {
        ctx.strokeStyle = colors.current;
        ctx.lineWidth = 2 / view.k;
        ctx.beginPath(); ctx.arc(n.x, n.y, r + 4 / view.k, 0, Math.PI * 2); ctx.stroke();
      }
      if (view.k > 0.55 || n === hover || n.id === currentId) {
        ctx.fillStyle = n === hover ? colors.text : colors.muted;
        ctx.fillText(n.label.length > 32 ? `${n.label.slice(0, 30)}…` : n.label, n.x, n.y + r + 12 / view.k);
      }
    }
    ctx.globalAlpha = 1;
  }

  function loop() {
    if (alpha > 0.021 || drag) tick();
    draw();
    raf = requestAnimationFrame(loop);
  }

  function toWorld(e) {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left - r.width / 2 - view.x) / view.k, y: (e.clientY - r.top - r.height / 2 - view.y) / view.k };
  }
  const pick = (p) => nodes.find((n) => (n.x - p.x) ** 2 + (n.y - p.y) ** 2 <= (radius(n) + 4) ** 2);

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    const p = toWorld(e);
    const n = pick(p);
    if (n) drag = { node: n, moved: false };
    else pan = { x: e.clientX - view.x, y: e.clientY - view.y };
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = toWorld(e);
    if (drag) {
      drag.node.x = p.x; drag.node.y = p.y; drag.moved = true;
      alpha = Math.max(alpha, 0.3);
    } else if (pan) {
      view.x = e.clientX - pan.x; view.y = e.clientY - pan.y;
    } else {
      hover = pick(p) || null;
      canvas.style.cursor = hover ? 'pointer' : 'grab';
    }
  });
  canvas.addEventListener('pointerup', () => {
    if (drag && !drag.moved && drag.node.kind !== 'tag') onOpen?.(drag.node.id);
    drag = null; pan = null;
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const k = Math.min(4, Math.max(0.2, view.k * (e.deltaY < 0 ? 1.1 : 0.9)));
    const r = canvas.getBoundingClientRect();
    const mx = e.clientX - r.left - r.width / 2, my = e.clientY - r.top - r.height / 2;
    view.x = mx - ((mx - view.x) * k) / view.k;
    view.y = my - ((my - view.y) * k) / view.k;
    view.k = k;
  }, { passive: false });

  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();
  for (let i = 0; i < 400; i++) tick(); // settle the layout before the first frame
  fit();
  loop();

  return () => { cancelAnimationFrame(raf); ro.disconnect(); };
}
