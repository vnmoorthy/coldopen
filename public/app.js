/* =====================================================================
   COLD OPEN — Mission Control
   Vanilla ES module. No frameworks, no build step.
   Every string from the network is rendered with textContent (XSS-safe);
   every URL / color / font from the network is validated before use.
   ===================================================================== */

// ─────────────────────────────────────────────────────────── constants
let PASS = 85; // taste bar; replaced by /api/config tasteBar when present
const MAX_EVENTS = 400;
const DEFAULT_HQ = { lat: 37.7786, lon: -122.3893, label: '101 Townsend St, SF' };

// Colors are theme tokens (styles.css defines a dark and a light value for each).
const AGENTS = {
  Scout:     { mono: 'Sc', color: 'var(--scout)', role: 'Finds real businesses' },
  Archivist: { mono: 'Ar', color: 'var(--archivist)', role: 'Reads the brand' },
  Builder:   { mono: 'Bu', color: 'var(--builder)', role: 'Composes the site' },
  Critic:    { mono: 'Cr', color: 'var(--critic)', role: `Taste gate ≥ ${PASS}` },
  Director:  { mono: 'Di', color: 'var(--director)', role: 'Hero visual + ad' },
  Closer:    { mono: 'Cl', color: 'var(--closer)', role: 'Pitch + checkout' },
  CFO:       { mono: 'CF', color: 'var(--cfo)', role: 'Spend vs revenue' },
  System:    { mono: 'Sy', color: 'var(--system)', role: 'Ops + integrations' },
};
const AGENT_NAMES = Object.keys(AGENTS);
const SPLITS = ['Scout', 'Archivist', 'Builder', 'Critic', 'Director', 'Closer'];
const STEPS = ['Archivist', 'Builder', 'Critic', 'Director', 'Closer'];
const STATUS_AGENT = { extracting: 'Archivist', building: 'Builder', critiquing: 'Critic', directing: 'Director' };
const FLIGHT = new Set(Object.keys(STATUS_AGENT));
const BUILT = new Set(['ready', 'contacted', 'replied', 'paid']);
const STATUS_LABEL = {
  scouted: 'Scouted', extracting: 'Archivist', building: 'Builder', critiquing: 'Critic', directing: 'Director',
  ready: 'Ready', contacted: 'Contacted', replied: 'Replied', paid: 'Paid', removed: 'Removed', error: 'Error',
};
const GROUPS = [
  { key: 'scouted', label: 'Scouted', color: 'var(--st-scouted)' },
  { key: 'flight', label: 'In flight', color: 'var(--st-flight)' },
  { key: 'ready', label: 'Ready', color: 'var(--st-ready)' },
  { key: 'contacted', label: 'Contacted', color: 'var(--st-contacted)' },
  { key: 'replied', label: 'Replied', color: 'var(--st-replied)' },
  { key: 'paid', label: 'Paid', color: 'var(--st-paid)' },
  { key: 'error', label: 'Error', color: 'var(--st-error)' },
];
const PIPE_RANK = { flight: 0, paid: 1, replied: 2, contacted: 3, ready: 4, error: 5, scouted: 6 };
const TIMING_KEYS = [
  ['scout', 'Scout'], ['archivist', 'Archivist'], ['builder', 'Builder'],
  ['critic', 'Critic'], ['director', 'Director'], ['closer', 'Closer'],
];
const TILES = [
  { key: 'scouted', label: 'Scouted', c: 'var(--st-scouted)' },
  { key: 'built', label: 'Built', c: 'var(--st-ready)' },
  { key: 'tastePassed', label: 'Taste-passed', c: 'var(--money)' },
  { key: 'contacted', label: 'Contacted', c: 'var(--st-contacted)' },
  { key: 'replied', label: 'Replied', c: 'var(--st-replied)' },
  { key: 'paid', label: 'Paid', c: 'var(--st-paid)' },
  { key: 'revenueCents', label: 'Revenue', c: 'var(--money)', money: true },
  { key: 'spendCents', label: 'Spend', c: 'var(--cfo)', money: true, spend: true },
];

const RM_QUERY = matchMedia('(prefers-reduced-motion: reduce)');
let REDUCED_MOTION = RM_QUERY.matches;
try { RM_QUERY.addEventListener('change', (e) => { REDUCED_MOTION = e.matches; }); } catch { /* old Safari */ }
const COARSE = matchMedia('(pointer: coarse)').matches;
const QS = new URLSearchParams(location.search);

// ─────────────────────────────────────────────────────────── state
const S = {
  config: null,
  biz: new Map(),          // id -> Business
  events: [],              // AgentEvent[] oldest first
  eventIds: new Set(),
  stats: null,
  loaded: false,
  cards: new Map(),        // id -> card refs
  busy: new Set(),         // in-flight request keys
  gridFilter: 'all',
  search: '',
  sort: 'pipeline',
  feedAgent: null,
  feedBiz: null,
  feedUnread: 0,
  drawerId: null,
  dialog: null,
  celebrated: new Set(),
  agentSeen: {},           // agent -> performance.now() of last live event
  radius: 450,
  sound: true,
  scouting: false,
  lastFocus: null,
};
let MOCK = null; // design-review backend, only when ?mock=1

try { const r = Number(localStorage.getItem('co.radius')); if ([250, 450, 700, 1000].includes(r)) S.radius = r; } catch { /* storage unavailable */ }
try { if (localStorage.getItem('co.sound') === 'off') S.sound = false; } catch { /* storage unavailable */ }
try { const s = localStorage.getItem('co.sort'); if (['newest', 'pipeline', 'score', 'name'].includes(s)) S.sort = s; } catch { /* storage unavailable */ }

// ─────────────────────────────────────────────────────────── theme
// index.html sets data-theme/data-theme-pref before first paint; this keeps them in sync afterwards.
// The header button and the T key flip light ↔ dark, so every press visibly changes the page.
// The ⋯ menu item cycles System → (opposite of OS) → (same as OS), which keeps "follow the OS" reachable
// and still makes its first press flip the page. ?theme=light|dark|system forces it for one page load.
const THEME_ORDER = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'System', light: 'Light', dark: 'Dark' };
const THEME_MQ = matchMedia('(prefers-color-scheme: light)');
const THEME = { pref: THEME_ORDER.includes(document.documentElement.dataset.themePref) ? document.documentElement.dataset.themePref : 'system', animT: 0 };
const systemTheme = () => (THEME_MQ.matches ? 'light' : 'dark');
const resolvedTheme = () => (THEME.pref === 'system' ? systemTheme() : THEME.pref);
const themeMenuOrder = () => { const sys = systemTheme(); return ['system', sys === 'light' ? 'dark' : 'light', sys]; };
const nextMenuTheme = () => { const o = themeMenuOrder(); return o[(o.indexOf(THEME.pref) + 1) % o.length]; };
function applyTheme({ animate = false } = {}) {
  const root = document.documentElement;
  const t = resolvedTheme();
  if (animate && !REDUCED_MOTION) {
    root.classList.add('theme-anim');
    clearTimeout(THEME.animT);
    THEME.animT = setTimeout(() => root.classList.remove('theme-anim'), 340);
  }
  root.dataset.theme = t;
  root.dataset.themePref = THEME.pref;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', cssVar('--bg', t === 'light' ? '#F6F3EC' : '#0A0A0B'));
  const cs = document.querySelector('meta[name="color-scheme"]');
  if (cs) cs.setAttribute('content', t);
  const flip = t === 'light' ? 'dark' : 'light';
  const now = THEME.pref === 'system' ? `System (${t})` : THEME_LABEL[THEME.pref];
  const b = document.getElementById('btn-theme');
  if (b) {
    b.setAttribute('aria-label', `Theme: ${now}. Switch to ${THEME_LABEL[flip]}`);
    b.dataset.tip = `Switch to ${THEME_LABEL[flip].toLowerCase()} · T`;
    if (typeof TIP !== 'undefined' && TIP.target === b && TIP.el) TIP.el.textContent = b.dataset.tip;
  }
  const st = document.getElementById('theme-state');
  if (st) st.textContent = now;
  if (typeof M !== 'undefined' && M.tiles) M.tiles.setUrl(tileUrl());
}
function setThemePref(pref) {
  THEME.pref = pref;
  try { if (THEME.pref === 'system') localStorage.removeItem('co.theme'); else localStorage.setItem('co.theme', THEME.pref); } catch { /* storage unavailable */ }
  applyTheme({ animate: true });
}
/** Header button + T: always flips what is on screen. */
function toggleTheme() { setThemePref(resolvedTheme() === 'light' ? 'dark' : 'light'); }
/** ⋯ menu: System → opposite of OS → same as OS (first press always flips the page). */
function cycleTheme() { setThemePref(nextMenuTheme()); }
try { THEME_MQ.addEventListener('change', () => { if (THEME.pref === 'system') applyTheme({ animate: true }); }); } catch { /* old Safari */ }

// ─────────────────────────────────────────────────────────── DOM utils
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = String(v);
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sv == null) continue;
          if (sk.startsWith('--')) el.style.setProperty(sk, String(sv));
          else el.style[sk] = String(sv);
        }
      } else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, kids);
  return el;
}
function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false || kid === '') continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const SVGNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, String(v));
  for (const kid of kids) if (kid) el.append(kid);
  return el;
}
const ICONS = {
  ext: 'M8 4.5h7.5V12M15.2 4.8 7 13M12.5 12.5v3H4.5v-8h3',
  refresh: 'M15.6 8.2A6 6 0 1 0 16 11.6M16.2 3.6v4.8h-4.8',
  copy: 'M7.5 7.5h8v8h-8zM4.5 12.5v-8h8',
  mail: 'M3.5 5.5h13v9h-13zM3.8 5.8 10 11l6.2-5.2',
  close: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  play: 'M6.5 4.8v10.4L15 10z',
  check: 'M4.5 10.5 8.2 14 15.5 6',
  trash: 'M4.5 6h11M8 6V4.2h4V6M6 6l.9 10h6.2L14 6',
  plus: 'M10 4.5v11M4.5 10h11',
  video: 'M3.5 6h9v8h-9zM12.5 9l4-2.2v6.4l-4-2.2',
  link: 'M8.6 11.4a3 3 0 0 0 4.2 0l2.4-2.4a3 3 0 0 0-4.2-4.2l-.9.9M11.4 8.6a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l.9-.9',
  user: 'M10 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4.5 16c.8-2.8 3-4 5.5-4s4.7 1.2 5.5 4',
  reply: 'M8 5 3.5 9.5 8 14M4 9.5h7a5 5 0 0 1 5 5',
  card: 'M3.5 5.5h13v9h-13zM3.5 8.5h13',
  info: 'M10 9v5M10 6.2v.1',
  bolt: 'M11 3.5 5 11h4.5L9 16.5 15 9h-4.5z',
  eye: 'M2.5 10s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5zM10 12.3a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6z',
  qr: 'M3.5 3.5h5v5h-5zM11.5 3.5h5v5h-5zM3.5 11.5h5v5h-5zM11.5 11.5h2v2h-2zM14.5 14.5h2v2h-2zM11.5 15.5v1M16.5 11.5v1',
  panel: 'M3.5 4.5h13v11h-13zM12 4.5v11M14 8h.5M14 10.5h.5',
};
function icon(name, { fill = false } = {}) {
  return sv('svg', { viewBox: '0 0 20 20', class: 'ico', 'aria-hidden': 'true' },
    sv('path', {
      d: ICONS[name] || '', fill: fill ? 'currentColor' : 'none', stroke: fill ? 'none' : 'currentColor',
      'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
}
function monoEl(agent, size = '') {
  const a = AGENTS[agent] || AGENTS.System;
  return h('span', { class: `mono ${size ? 'mono--' + size : ''}`, style: { '--c': a.color }, 'aria-hidden': 'true', text: a.mono });
}

/** Button factory. busyKey links the button to S.busy so re-rendered copies keep their spinner. */
function btn(label, opts = {}) {
  const { kind = '', size = 'sm', ic, onClick, tip, tipPos, disabled, busyKey, href, target, title, ariaLabel, id } = opts;
  const el = h(href ? 'a' : 'button', {
    class: ['btn', kind && `btn--${kind}`, size && `btn--${size}`, !ic && 'no-ico'].filter(Boolean).join(' '),
    type: href ? null : 'button', id, title, 'aria-label': ariaLabel,
  });
  if (href) {
    el.setAttribute('href', href);
    if (target) { el.setAttribute('target', target); el.setAttribute('rel', 'noopener noreferrer'); }
  }
  if (ic) el.append(icon(ic, { fill: ic === 'play' }));
  el.append(h('span', { text: label }));
  if (tip) { el.dataset.tip = tip; if (tipPos) el.dataset.tipPos = tipPos; }
  if (disabled) {
    el.dataset.disabled = '1';
    if (href) { el.setAttribute('aria-disabled', 'true'); el.removeAttribute('href'); } else el.disabled = true;
  }
  if (busyKey) { el.dataset.busyKey = busyKey; if (S.busy.has(busyKey)) setBusy(el, true); }
  if (onClick) el.addEventListener('click', (e) => { if (el.dataset.disabled === '1' || el.classList.contains('is-busy')) { e.preventDefault(); return; } onClick(e, el); });
  if (disabled && tip) {
    // disabled controls swallow pointer events, so the explanation lives on a focusable wrapper
    delete el.dataset.tip;
    return h('span', { class: 'tipwrap', tabindex: '0', 'data-tip': tip, 'data-tip-pos': tipPos || null, 'aria-label': `${label} — ${tip}` }, el);
  }
  return el;
}
function setBusy(el, on) {
  el.classList.toggle('is-busy', on);
  if (el.tagName === 'BUTTON') el.disabled = on || el.dataset.disabled === '1';
  if (on) el.setAttribute('aria-busy', 'true'); else el.removeAttribute('aria-busy');
}
function refreshBusy() {
  for (const el of $$('[data-busy-key]')) setBusy(el, S.busy.has(el.dataset.busyKey));
}

// ─────────────────────────────────────────────────────────── format + safety
const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
function moneyFmt(targetCents) {
  const dec = Math.round(targetCents) % 100 === 0 ? 0 : 2;
  return (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
const fmtUSD = (c) => moneyFmt(c)(c);
/** Model spend is often a fraction of a cent: show cents below $1, dollars above. */
function spendFmt(target) {
  const t = Number(target) || 0;
  if (t <= 0) return () => '$0';
  if (t < 100) { const d = t < 10 ? 2 : 1; return (c) => `${(Number(c) || 0).toFixed(d)}¢`; }
  return (c) => '$' + ((Number(c) || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
const fmtSpend = (c) => spendFmt(c)(c);
function fmtDur(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '—';
  ms = Number(ms);
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
  return `${m}m ${String(s).padStart(2, '0')}s`;
}
function fmtTimer(ms) {
  ms = Math.max(0, ms);
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000), cs = Math.floor((ms % 1000) / 10);
  return [`${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`, String(cs).padStart(2, '0')];
}
function fmtSplit(ms) {
  if (ms == null) return '—';
  const [a, b] = fmtTimer(ms);
  return `${a}.${b}`;
}
const timeFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const fmtTime = (ts) => (ts ? timeFmt.format(new Date(ts)) : '');
const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const fmtDate = (ts) => (ts ? dateFmt.format(new Date(ts)) : '—');
const pct = (a, b) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

function safeHref(u) {
  if (typeof u !== 'string') return null;
  u = u.trim();
  if (/^https?:\/\/[^\s]+$/i.test(u)) return u;
  if (/^\/(?!\/)[^\s]*$/.test(u)) return u;
  return null;
}
const safeColor = (c) => (typeof c === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(c.trim()) ? c.trim() : null);
const safeFont = (f) => (typeof f === 'string' && /^[A-Za-z0-9][A-Za-z0-9 \-]{0,60}$/.test(f.trim()) ? f.trim() : null);
const safeEmail = (e) => (typeof e === 'string' && /^[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}$/i.test(e.trim()) ? e.trim() : null);
/** Strict http(s) URL check (Chrome's parser escapes spaces in hosts instead of rejecting them). Returns normalized URL or null. */
function normalizeHttpUrl(raw) {
  let u = str(raw).trim();
  if (!u || /\s/.test(u)) return null;
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try {
    const p = new URL(u);
    if (!/^https?:$/.test(p.protocol)) return null;
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(p.hostname) && p.hostname !== 'localhost') return null;
    return p.href;
  } catch { return null; }
}
const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return null; } };
const enc = encodeURIComponent;
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
/** OSM categories arrive as raw tags ("musical_instrument"); show them as words. */
const catLabel = (c, fallback = 'Local business') => {
  const t = str(c).replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : fallback;
};
/** Read a theme token at call time (canvas + Leaflet need real colors, not var()). */
const cssVar = (name, fallback = '') => { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; } catch { return fallback; } };
const arr = (v) => (Array.isArray(v) ? v : []);

function groupOf(status) {
  if (FLIGHT.has(status)) return 'flight';
  if (status === 'ready' || status === 'contacted' || status === 'replied' || status === 'paid' || status === 'error' || status === 'scouted') return status;
  return 'scouted';
}
// The score of the version that actually shipped (HQ ships the best draft, not always the last).
const lastScore = (b) => { const s = arr(b.scores); if (!s.length) return null; const v = b && b.site && b.site.version; return (v && s.find((x) => x.version === v)) || s[s.length - 1]; };
const scoreColor = (s) => (s >= PASS ? 'var(--money)' : s >= 70 ? 'var(--warn)' : 'var(--error)');
/** Text-safe variant of scoreColor (≥4.5:1 in both themes). scoreColor is for bars/rings only. */
const scoreInk = (s) => (s >= PASS ? 'var(--money-ink)' : s >= 70 ? 'var(--warn-ink)' : 'var(--error-ink)');
const num = (v) => (v == null || v === '' ? NaN : Number(v));
const hq = () => {
  const c = (S.config && S.config.hq) || {};
  const lat = num(c.lat), lon = num(c.lon);
  return { lat: Number.isFinite(lat) ? lat : DEFAULT_HQ.lat, lon: Number.isFinite(lon) ? lon : DEFAULT_HQ.lon, label: str(c.label) || DEFAULT_HQ.label };
};
const hqShort = () => { const l = hq().label; return (l.includes('·') ? l.split('·').pop() : l.split(',')[0]).trim(); };
const hasGeo = (b) => Number.isFinite(b.lat) && Number.isFinite(b.lon) && b.lat !== null && b.lon !== null;
function distanceM(b) {
  if (!hasGeo(b)) return null;
  const { lat, lon } = hq();
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - lat) * r, dLon = (b.lon - lon) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const fmtDist = (m) => (m == null ? null : m < 1000 ? `${Math.round(m / 10) * 10} m from HQ` : `${(m / 1000).toFixed(1)} km from HQ`);
function sitePath(b) { return `/s/${enc(b.id)}`; }
function siteAbs(b) {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const pub = S.config && safeHref(S.config.publicUrl);
  const base = local && pub && /^https?:/.test(pub) ? pub.replace(/\/$/, '') : location.origin;
  return base + sitePath(b);
}
function hashHue(s) { let x = 0; for (const ch of str(s)) x = (x * 31 + ch.charCodeAt(0)) >>> 0; return x % 360; }
function lastEventFor(bizId) {
  for (let i = S.events.length - 1; i >= 0; i--) if (S.events[i].bizId === bizId) return S.events[i];
  return null;
}

// ─────────────────────────────────────────────────────────── transport
async function api(method, path, body, { timeout = 30000 } = {}) {
  if (MOCK) return MOCK.request(method, path, body);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  const init = { method, signal: ctl.signal, cache: 'no-store', headers: { accept: 'application/json' } };
  if (method !== 'GET' && method !== 'DELETE') {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body ?? {});
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch (e) {
    throw new Error(e && e.name === 'AbortError' ? 'The request timed out — HQ may still finish it in the background.' : 'Network error — HQ is unreachable.');
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = null; } }
  if (!res.ok) {
    const msg = (data && typeof data.error === 'string' && data.error) || (data && typeof data.message === 'string' && data.message) || `HQ answered ${res.status} ${res.statusText || ''}`.trim();
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return data;
}

const conn = { ws: null, retry: 0, timer: 0, everOpen: false, poll: 0 };
function connect() {
  if (MOCK) { setConn('mock'); MOCK.connect(onMessage); return; }
  clearTimeout(conn.timer); conn.timer = 0;
  const url = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + '/agents/hq/main';
  let ws;
  try { ws = new WebSocket(url); } catch { scheduleReconnect(); return; }
  conn.ws = ws;
  if (!conn.everOpen) setConn('connecting');
  ws.addEventListener('open', () => {
    if (conn.ws !== ws) return;
    const wasReconnect = conn.everOpen;
    conn.everOpen = true;
    conn.retry = 0;
    conn.lastMsg = Date.now();
    setConn('live');
    stopPolling();
    if (wasReconnect) refreshState();
  });
  ws.addEventListener('message', (ev) => {
    conn.lastMsg = Date.now();
    if (typeof ev.data !== 'string') return;
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    onMessage(msg);
  });
  ws.addEventListener('close', () => {
    if (conn.ws !== ws) return;
    conn.ws = null;
    setConn(navigator.onLine === false ? 'offline' : 'reconnecting');
    startPolling();
    scheduleReconnect();
  });
  ws.addEventListener('error', () => { /* a close event always follows */ });
}
// Keepalive: HQ answers {type:"ping"} with a pong. If nothing arrives for 70s the socket is dead — recycle it.
setInterval(() => {
  const ws = conn.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (Date.now() - (conn.lastMsg || 0) > 70000) { try { ws.close(); } catch { /* ignore */ } return; }
  try { ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })); } catch { /* close handler reconnects */ }
}, 25000);
function scheduleReconnect() {
  if (conn.timer) return;
  const delay = Math.min(10000, 500 * 2 ** conn.retry) * (0.75 + Math.random() * 0.5);
  conn.retry = Math.min(conn.retry + 1, 8);
  conn.timer = setTimeout(() => { conn.timer = 0; connect(); }, delay);
}
function startPolling() { if (!conn.poll && !MOCK) conn.poll = setInterval(() => refreshState(), 5000); }
function stopPolling() { clearInterval(conn.poll); conn.poll = 0; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !MOCK && !conn.ws) { conn.retry = 0; clearTimeout(conn.timer); conn.timer = 0; connect(); }
});
addEventListener('online', () => { if (!MOCK && !conn.ws) { conn.retry = 0; clearTimeout(conn.timer); conn.timer = 0; connect(); } });

function setConn(state) {
  const el = $('#conn');
  el.dataset.state = state;
  const label = { connecting: 'Connecting', live: 'Live', reconnecting: 'Reconnecting', offline: 'Offline', mock: 'Mock data' }[state] || state;
  $('.conn__label', el).textContent = label;
  el.title = state === 'live' ? 'Streaming from the HQ Durable Object over WebSocket' : state === 'reconnecting' ? 'WebSocket dropped — retrying with backoff, polling /api/state meanwhile' : '';
}

let refreshing = null;
async function refreshState({ quiet = true } = {}) {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const snap = await api('GET', '/api/state');
      applySnapshot(snap);
      hideOfflineBanner();
    } catch (e) {
      if (!quiet) toastErr(e, 'Could not load HQ state');
      if (!S.loaded) showOfflineBanner(e);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}
async function loadConfig() {
  try {
    S.config = await api('GET', '/api/config');
  } catch {
    S.config = S.config || null;
  }
  const bar = S.config && Number(S.config.tasteBar);
  if (Number.isFinite(bar) && bar > 0 && bar <= 100) { PASS = bar; AGENTS.Critic.role = `Taste gate ≥ ${PASS}`; renderCrewRoles(); }
  renderPills();
  renderIntro();
  $('#hq-label').textContent = hqShort();
  if (M.map) placeHQ();
  if (S.loaded) { renderGridFull(); updateRibbonSubs(); }
}

// ─────────────────────────────────────────────────────────── message handling
function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'snapshot': if (msg.snapshot && typeof msg.snapshot === 'object') applySnapshot(msg.snapshot); break;
    case 'event': if (msg.event && typeof msg.event === 'object') addEvent(msg.event); break;
    case 'business': if (msg.business && typeof msg.business === 'object') upsertBusiness(msg.business); break;
    case 'stats': if (msg.stats && typeof msg.stats === 'object') { S.stats = msg.stats; updateRibbon(); } break;
    case 'removed': if (typeof msg.id === 'string') removeBusiness(msg.id); break;
    default: break; // Agents SDK housekeeping (cf_agent_*) and anything unknown
  }
}

function normalizeBiz(b) {
  if (!b || typeof b.id !== 'string') return null;
  b.name = str(b.name) || b.id;
  b.scores = arr(b.scores);
  b.osmTags = b.osmTags && typeof b.osmTags === 'object' ? b.osmTags : {};
  b.video = b.video && typeof b.video === 'object' ? b.video : { status: 'none' };
  b.timings = b.timings && typeof b.timings === 'object' ? b.timings : {};
  b.lat = Number.isFinite(num(b.lat)) ? num(b.lat) : null;
  b.lon = Number.isFinite(num(b.lon)) ? num(b.lon) : null;
  return b;
}

function applySnapshot(snap) {
  const first = !S.loaded;
  const next = new Map();
  for (const raw of arr(snap.businesses)) {
    const b = normalizeBiz(raw);
    if (b && b.status !== 'removed') next.set(b.id, b);
  }
  for (const b of next.values()) {
    const prev = S.biz.get(b.id);
    if (b.status === 'paid') {
      if (first) S.celebrated.add(b.id);
      else if (prev && prev.status !== 'paid' && !S.celebrated.has(b.id)) celebrate(b);
      else S.celebrated.add(b.id);
    }
  }
  S.biz = next;
  const evs = arr(snap.events).filter((e) => e && typeof e === 'object');
  S.events = evs.slice(-MAX_EVENTS);
  S.eventIds = new Set(S.events.map((e) => e.id));
  if (snap.stats && typeof snap.stats === 'object') S.stats = snap.stats;
  S.loaded = true;
  renderAll();
  if (first) {
    fitMap();
    openFromHash();
  }
  if (CH.bizId && S.biz.has(CH.bizId)) chOnBusiness(S.biz.get(CH.bizId));
}

function upsertBusiness(raw) {
  const b = normalizeBiz(raw);
  if (!b) return;
  if (b.status === 'removed') { removeBusiness(b.id); return; }
  const prev = S.biz.get(b.id);
  const isNew = !prev;
  S.biz.set(b.id, b);
  if (b.status === 'paid' && (!prev || prev.status !== 'paid') && !S.celebrated.has(b.id)) celebrate(b);
  updateCardFor(b);
  layoutGrid();
  syncPin(b);
  renderFunnel();
  if (!S.stats) updateRibbon();
  else updateRibbonSubs();
  if (S.drawerId === b.id) renderDrawer();
  if (CH.bizId === b.id) chOnBusiness(b, prev);
  if (isNew && CH.phase === 'form') chRenderPicks();
}

function removeBusiness(id) {
  const had = S.biz.get(id);
  S.biz.delete(id);
  const c = S.cards.get(id);
  if (c) { c.el.remove(); S.cards.delete(id); }
  removePin(id);
  layoutGrid();
  renderFunnel();
  updateRibbonSubs();
  if (S.drawerId === id) { closeDrawer(); if (had) toast({ kind: 'info', title: 'Preview removed', text: `${had.name}'s concept site now shows a removal notice.` }); }
  if (S.feedBiz === id) { S.feedBiz = null; renderFeed(); }
  if (CH.bizId === id && CH.phase === 'running') chFail('This business was removed while the pipeline was running.');
}

function addEvent(e) {
  if (!e || (e.id != null && S.eventIds.has(e.id))) return;
  if (e.id != null) S.eventIds.add(e.id);
  if (typeof e.ts !== 'number') e.ts = Date.now();
  if (!AGENTS[e.agent]) e.agent = 'System';
  S.events.push(e);
  if (S.events.length > MAX_EVENTS) {
    const drop = S.events.splice(0, S.events.length - MAX_EVENTS);
    for (const d of drop) S.eventIds.delete(d.id);
  }
  S.agentSeen[e.agent] = performance.now();
  if (e.kind === 'success' || e.kind === 'money' || e.kind === 'error') announce(`${e.agent}: ${str(e.text)}`);
  appendFeed(e);
  updateCrewTile(e.agent);
  renderFeedFilters();
  if (e.bizId) {
    const c = S.cards.get(e.bizId);
    const b = S.biz.get(e.bizId);
    if (c && b) setCardLive(c, b);
    if (S.drawerId === e.bizId) renderDrawer();
    if (CH.bizId === e.bizId) chOnEvent(e);
  }
  if (e.kind === 'money' && e.bizId && !S.celebrated.has(e.bizId)) {
    const b = S.biz.get(e.bizId);
    if (b) celebrate(b, e);
  }
}

function renderAll() {
  renderGridFull();
  syncPins();
  renderFunnel();
  updateRibbon();
  renderCrew();
  renderFeedFilters();
  renderFeed();
  if (S.drawerId) renderDrawer();
  if (CH.phase === 'form') chRenderPicks();
}

// ─────────────────────────────────────────────────────────── top bar
const PILL_DEFS = [
  { key: 'claude', label: 'Claude', state: (i) => !!i.claude, on: 'Claude is the brain — brand reads, copy and critique run on the Anthropic API.', off: 'Off. Add ANTHROPIC_API_KEY to put Claude in charge of brand reads, copy and critique.' },
  {
    key: 'workersAI', label: 'Workers AI',
    // boolean, or { ok, quotaExhausted, reason }
    state: (i) => { const w = i.workersAI; if (i.workersAIQuotaExhausted) return 'partial'; if (w && typeof w === 'object') return w.quotaExhausted ? 'partial' : !!w.ok; return !!w; },
    on: 'Workers AI renders FLUX hero images and backs up the LLM.',
    partial: 'Workers AI daily quota is exhausted — builds fall back where they can.',
    off: 'Workers AI binding not detected.',
  },
  { key: 'openai', label: 'OpenAI', state: (i) => !!i.openai, on: 'OpenAI is wired in as an LLM provider.', off: 'Off — add OPENAI_API_KEY to use OpenAI as a brain.' },
  { key: 'brainbase', label: 'Brainbase', state: (i) => !!i.brainbase, on: 'Independent second-opinion review by a Brainbase managed agent (POST /v2/threads).', off: 'Off — Independent second-opinion review by a Brainbase managed agent (POST /v2/threads). Add the Brainbase key to enable it.' },
  {
    key: 'stripe', label: 'Stripe',
    state: (i, c) => (i.stripeApi ? true : (c && c.paymentLink) || i.stripeWebhook ? 'partial' : false),
    on: 'Stripe API connected — per-business payment links and verified checkouts.',
    partial: 'Stripe payment link live (test mode). Add STRIPE_SECRET_KEY to verify each checkout.',
    off: 'Stripe not configured.',
  },
  { key: 'slack', label: 'Slack', state: (i) => !!i.slack, on: 'Every build and payment is posted to Slack.', off: 'Off — add SLACK_WEBHOOK_URL to mirror the channel into Slack.' },
  { key: 'higgsfield', label: 'Higgsfield', state: (i) => !!i.higgsfield, on: 'Higgsfield renders short video ads for finished sites.', off: 'Off — add HIGGSFIELD_API_KEY to generate video ads.' },
  { key: 'taste', label: 'Taste Labs', state: (i) => !!i.taste, on: 'Taste Labs enriches brand extraction and scoring.', off: 'Off — add TASTE_API_KEY to enrich brand extraction.' },
];
function renderPills() {
  const wrap = $('#pills');
  wrap.textContent = '';
  const cfg = S.config;
  const integ = (cfg && cfg.integrations) || null;
  if (!integ) {
    wrap.append(h('span', { class: 'pill', 'data-on': 'unknown', tabindex: '0', 'data-tip': 'Waiting for /api/config…', 'data-tip-pos': 'bottom', 'aria-label': 'Integrations: checking' }, h('i'), 'Checking integrations…'));
    return;
  }
  // Only live integrations get a pill; the rest fold into one honest "+N available" pill.
  wrap.append(h('span', { class: 'pills__k', 'aria-hidden': 'true', text: 'Powered by' }));
  const off = [];
  for (const d of PILL_DEFS) {
    let state = 'unknown', tip = 'Waiting for /api/config…';
    if (integ) {
      const s = d.state(integ, cfg);
      state = s === true ? 'true' : s === 'partial' ? 'partial' : 'false';
      tip = s === true ? d.on : s === 'partial' ? d.partial : d.off;
      if (d.key === 'workersAI' && integ.workersAI && typeof integ.workersAI === 'object' && integ.workersAI.reason) tip += ` ${str(integ.workersAI.reason)}`;
      if (d.key === 'stripe' && integ.stripeWebhook) tip += ' Webhook signature verification is on.';
      if (d.key === 'stripe' && cfg.stripeMode) tip += ` Mode: ${str(cfg.stripeMode)}.`;
      if ((d.key === 'claude' || d.key === 'workersAI') && cfg.llm) tip += ` Brain right now: ${str(cfg.llm)}.`;
    }
    if (state === 'false') { off.push(`${d.label} — ${tip.replace(/^Off\.?\s*(—\s*)?/, '')}`); continue; }
    const pill = h('span', { class: 'pill', 'data-on': state, tabindex: '0', 'data-tip': tip, 'data-tip-pos': 'bottom', 'aria-label': `${d.label}: ${state === 'true' ? 'on' : state === 'partial' ? 'partial' : state === 'false' ? 'off' : 'unknown'}` }, h('i'), d.label);
    wrap.append(pill);
  }
  if (off.length) {
    wrap.append(h('span', { class: 'pill pill--more', tabindex: '0', 'data-tip': `Available, not switched on: ${off.join(' · ')}`, 'data-tip-pos': 'bottom', 'aria-label': `${off.length} more integrations available but off: ${off.map((o) => o.split(' — ')[0]).join(', ')}` }, `+${off.length}`));
  }
}
function startClock() {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const el = $('#clock');
  const tick = () => { el.textContent = ''; el.append('SF ', h('b', { text: f.format(new Date()) })); };
  tick();
  setInterval(tick, 1000);
}

// ─────────────────────────────────────────────────────────── ribbon
const R = {};
function initRibbon() {
  const rib = $('#ribbon');
  TILES.forEach((t, i) => {
    const val = h('div', { class: 'stat__value', text: t.money ? '$0' : '0' });
    val.dataset.val = '0';
    const sub = h('div', { class: 'stat__sub', text: ' ' });
    const el = h('div', { class: `stat ${t.key === 'revenueCents' ? 'stat--money' : ''} ${t.key === 'spendCents' ? 'stat--spend' : ''}`, style: { '--c': t.c } },
      h('div', { class: 'stat__label' }, h('i'), t.label), val, sub);
    if (i < 5) el.append(h('span', { class: 'stat__chev', 'aria-hidden': 'true' }, sv('svg', { viewBox: '0 0 8 8' }, sv('path', { d: 'M2.5 1.2 5.3 4 2.5 6.8', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3' }))));
    rib.append(el);
    R[t.key] = { el, val, sub, t };
  });
}
function computeStats() {
  const list = [...S.biz.values()];
  const built = list.filter((b) => BUILT.has(b.status));
  const times = built.map((b) => Number(b.timings && b.timings.total)).filter(Number.isFinite);
  return {
    scouted: list.length,
    built: built.length,
    tastePassed: built.filter((b) => (lastScore(b) || {}).score >= PASS).length,
    contacted: list.filter((b) => ['contacted', 'replied', 'paid'].includes(b.status)).length,
    replied: list.filter((b) => ['replied', 'paid'].includes(b.status)).length,
    paid: list.filter((b) => b.status === 'paid').length,
    revenueCents: list.reduce((s, b) => s + (b.status === 'paid' ? Number(b.amountCents) || 0 : 0), 0),
    spendCents: list.reduce((s, b) => s + (Number(b.costCents) || 0), 0),
    avgBuildMs: times.length ? times.reduce((a, c) => a + c, 0) / times.length : null,
    bestBuildMs: times.length ? Math.min(...times) : null,
  };
}
const statsNow = () => ({ ...computeStats(), ...(S.stats || {}) });
function tween(el, to, fmt, dur = 900) {
  const from = Number(el.dataset.val) || 0;
  el.dataset.val = String(to);
  cancelAnimationFrame(el._raf || 0);
  if (from === to || REDUCED_MOTION || document.hidden) { el.textContent = fmt(to); return; }
  const t0 = performance.now();
  const step = (t) => {
    const p = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}
function updateRibbon() {
  const st = statsNow();
  for (const t of TILES) {
    const r = R[t.key];
    const v = Number(st[t.key]) || 0;
    const prev = Number(r.val.dataset.val) || 0;
    const fmt = t.spend ? spendFmt(v) : t.money ? moneyFmt(v) : fmtInt;
    if (v > prev && r.primed) {
      r.el.classList.remove('bump'); void r.el.offsetWidth; r.el.classList.add('bump');
      clearTimeout(r.bumpT); r.bumpT = setTimeout(() => r.el.classList.remove('bump'), 1200);
    }
    r.el.classList.toggle('is-zero', v === 0 && !t.spend);
    tween(r.val, v, fmt, t.key === 'revenueCents' ? 2200 : 900);
    if (S.loaded) r.primed = true;
  }
  updateRibbonSubs();
}
function updateRibbonSubs() {
  const st = statsNow();
  const list = [...S.biz.values()];
  const flight = list.filter((b) => FLIGHT.has(b.status)).length;
  const waiting = list.filter((b) => b.status === 'scouted').length;
  const setSub = (key, ...parts) => { const el = R[key].sub; el.textContent = ''; append(el, parts); };
  if (flight) setSub('scouted', h('b', { text: String(flight) }), ' building now');
  else setSub('scouted', h('b', { text: String(waiting) }), ' waiting to build');
  if (st.avgBuildMs != null) setSub('built', 'avg ', h('b', { text: fmtDur(st.avgBuildMs) }), ' · best ', h('b', { text: fmtDur(st.bestBuildMs) }));
  else setSub('built', 'no builds yet');
  setSub('tastePassed', st.built ? h('b', { text: pct(st.tastePassed, st.built) }) : '', st.built ? ` cleared ${PASS}` : `gate at ${PASS} / 100`);
  const readyN = list.filter((b) => b.status === 'ready').length;
  const checkouts = list.filter((b) => b.status !== 'paid' && BUILT.has(b.status) && safeHref(b.paymentUrl)).length;
  if (st.contacted) setSub('contacted', h('b', { text: pct(st.contacted, st.built) }), ' of built');
  else setSub('contacted', readyN ? h('b', { text: String(readyN) }) : '', readyN ? ' ready to pitch' : 'nobody pitched yet');
  if (st.contacted) setSub('replied', h('b', { text: pct(st.replied, st.contacted) }), ' reply rate');
  else setSub('replied', 'after the first pitch');
  if (st.contacted) setSub('paid', h('b', { text: pct(st.paid, st.contacted) }), ' close rate');
  else setSub('paid', 'after the first reply');
  const link = S.config && str(S.config.paymentLink);
  const test = /\/test_/.test(link) ? ' · test mode' : '';
  if (st.revenueCents > 0 || !checkouts) setSub('revenueCents', h('b', { text: String(st.paid || 0) }), ` paid via Stripe${test}`);
  else setSub('revenueCents', h('b', { text: String(checkouts) }), ` ${checkouts === 1 ? 'checkout' : 'checkouts'} live${test}`);
  updateCrewOutcomes();
  updateMtabs();
  if (st.spendCents > 0 && st.revenueCents > 0) setSub('spendCents', 'ROI ', h('b', { text: `${fmtInt(st.revenueCents / st.spendCents)}×` }), st.built ? ` · ${fmtSpend(st.spendCents / st.built)}/site` : '');
  else if (st.spendCents > 0 && st.built) setSub('spendCents', h('b', { text: fmtSpend(st.spendCents / st.built) }), ' per site built');
  else setSub('spendCents', 'model + image spend');
}

// ─────────────────────────────────────────────────────────── funnel + filters
function groupCounts() {
  const c = Object.fromEntries(GROUPS.map((g) => [g.key, 0]));
  for (const b of S.biz.values()) c[groupOf(b.status)]++;
  return c;
}
const FUN = { segs: {}, chips: {} };
function renderFunnel() {
  const counts = groupCounts();
  const total = S.biz.size;
  const funnel = $('#funnel');
  const fw = $('#grid-filters');
  if (!FUN.built) {
    FUN.built = true;
    FUN.idle = h('div', { class: 'funnel__seg', style: { flexGrow: 1, '--c': 'var(--track)' } });
    funnel.append(FUN.idle);
    for (const g of GROUPS) {
      const seg = h('div', { class: `funnel__seg funnel__seg--${g.key}`, style: { flexGrow: 0, '--c': g.color } });
      funnel.append(seg);
      FUN.segs[g.key] = seg;
    }
    const mk = (key, label, color) => {
      const n = h('b', { text: '0' });
      const b = h('button', { class: 'fchip', type: 'button', 'aria-pressed': 'false', style: { '--c': color } }, key !== 'all' ? h('i') : null, label, n);
      b.addEventListener('click', () => { S.gridFilter = S.gridFilter === key && key !== 'all' ? 'all' : key; renderFunnel(); layoutGrid({ force: true }); });
      fw.append(b);
      FUN.chips[key] = { b, n };
    };
    mk('all', 'All', 'var(--text)');
    for (const g of GROUPS) mk(g.key, g.label, g.color);
  }
  FUN.idle.hidden = total > 0;
  for (const g of GROUPS) {
    const seg = FUN.segs[g.key];
    seg.hidden = !counts[g.key];
    seg.style.flexGrow = String(counts[g.key]);
    seg.title = `${g.label}: ${counts[g.key]}`;
  }
  if (S.gridFilter !== 'all' && !counts[S.gridFilter] && S.gridFilter === 'error') S.gridFilter = 'all';
  for (const [key, c] of Object.entries(FUN.chips)) {
    c.n.textContent = String(key === 'all' ? total : counts[key]);
    c.b.setAttribute('aria-pressed', String(S.gridFilter === key));
    if (key === 'error') c.b.hidden = !counts.error;
  }
  const gc = $('#grid-count');
  gc.textContent = '';
  if (total) append(gc, [`${total} ${total === 1 ? 'business' : 'businesses'}`, counts.flight ? ' · ' : '', counts.flight ? h('b', { text: `${counts.flight} in flight` }) : null]);
}

// ─────────────────────────────────────────────────────────── grid + cards
function visibleList() {
  const q = S.search.trim().toLowerCase();
  let list = [...S.biz.values()];
  if (S.gridFilter !== 'all') list = list.filter((b) => groupOf(b.status) === S.gridFilter);
  if (q) {
    list = list.filter((b) => [b.name, b.category, b.address, b.website, b.brand && b.brand.tagline, ...arr(b.brand && b.brand.keywords)]
      .some((v) => str(v).toLowerCase().includes(q)));
  }
  const by = {
    newest: (a, b) => (b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name),
    // Tie-break on createdAt, not updatedAt: updatedAt changes on every agent event and made cards reshuffle constantly.
    pipeline: (a, b) => PIPE_RANK[groupOf(a.status)] - PIPE_RANK[groupOf(b.status)] || (b.createdAt || 0) - (a.createdAt || 0) || a.name.localeCompare(b.name),
    score: (a, b) => ((lastScore(b) || { score: -1 }).score - (lastScore(a) || { score: -1 }).score) || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
  }[S.sort] || ((a, b) => 0);
  return list.sort(by);
}
function renderGridFull() {
  for (const b of S.biz.values()) updateCardFor(b);
  for (const [id, c] of S.cards) if (!S.biz.has(id)) { c.el.remove(); S.cards.delete(id); }
  layoutGrid();
}
/** Re-order the grid. Live updates (force=false) wait while the pointer or focus is on a card, so nothing jumps under the cursor. */
function layoutGrid({ force = false } = {}) {
  const grid = $('#grid');
  if (!force && !COARSE && S.loaded && grid.querySelector('.card') && (($('#grid-scroll').matches(':hover') && grid.matches(':hover')) || grid.contains(document.activeElement))) {
    S.gridDirty = true;
    return;
  }
  S.gridDirty = false;
  const list = visibleList();
  const want = list.map((b) => S.cards.get(b.id)).filter(Boolean).map((c) => c.el);
  const wantSet = new Set(want);
  const current = Array.from(grid.children);
  const same = current.length === want.length && current.every((el, i) => el === want[i]);
  if (!same) {
    const before = new Map();
    if (!REDUCED_MOTION) for (const el of current) if (wantSet.has(el)) before.set(el, el.getBoundingClientRect());
    for (const el of current) if (!wantSet.has(el)) el.remove();
    want.forEach((el, i) => { if (grid.children[i] !== el) grid.insertBefore(el, grid.children[i] || null); });
    for (const [el, r0] of before) {
      const r1 = el.getBoundingClientRect();
      const dx = r0.left - r1.left, dy = r0.top - r1.top;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    }
  }
  renderEmpty(list.length);
}
function renderEmpty(visibleCount) {
  const empty = $('#empty');
  empty.textContent = '';
  if (!S.loaded) {
    empty.hidden = true;
    const grid = $('#grid');
    if (!grid.children.length) for (let i = 0; i < 4; i++) grid.append(h('div', { class: 'skel', 'aria-hidden': 'true' }));
    return;
  }
  for (const s of $$('#grid .skel')) s.remove();
  if (visibleCount) { empty.hidden = true; return; }
  empty.hidden = false;
  empty.classList.toggle('empty--small', S.biz.size > 0);
  if (!S.biz.size) {
    empty.append(h('div', { class: 'empty__inner' },
      h('div', { class: 'empty__art', 'aria-hidden': 'true' }, h('div', { class: 'r' }), h('div', { class: 'r r2' }), h('div', { class: 'r r3' }), h('div', { class: 'sweep' }), h('div', { class: 'core' })),
      h('h2', {}, 'The block is ', h('em', { text: 'quiet.' })),
      h('p', { text: `The Scout walks ${S.radius} m around ${hq().label} and finds real independent businesses. Then the crew reads each brand, builds a site worth paying for, and gates it on taste before anyone says hello.` }),
      h('ol', { class: 'empty__steps' },
        h('li', {}, h('b', { text: '1' }), 'Scout', h('span', { text: '~10s' })),
        h('li', {}, h('b', { text: '2' }), `Build + taste gate ≥ ${PASS}`, h('span', { text: '~30s' })),
        h('li', {}, h('b', { text: '3' }), 'Stripe checkout attached')),
      h('div', { class: 'empty__actions' },
        btn('Scout the block', { kind: 'signal', size: 'lg', ic: 'bolt', busyKey: 'scout', onClick: (e, el) => actScout(el) }),
        btn('Live challenge', { kind: 'ghost', size: 'lg', onClick: () => openChallenge() }),
      ),
    ));
  } else {
    empty.append(h('div', { class: 'empty__inner' },
      h('h2', { text: 'Nothing matches.' }),
      h('p', { text: S.search ? `No business on the block matches “${S.search}”.` : 'No businesses in this stage yet.' }),
      h('div', { class: 'empty__actions' }, btn('Clear filters', { kind: 'ghost', onClick: () => { S.gridFilter = 'all'; S.search = ''; $('#search').value = ''; renderFunnel(); layoutGrid({ force: true }); } })),
    ));
  }
}

function makeRing(size = 46, stroke = 4, cls = '') {
  const r = (size - stroke) / 2 - 1;
  const circ = 2 * Math.PI * r;
  const bar = sv('circle', { class: 'ring__bar', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke, 'stroke-dasharray': circ.toFixed(2), 'stroke-dashoffset': circ.toFixed(2) });
  const svg = sv('svg', { viewBox: `0 0 ${size} ${size}`, 'aria-hidden': 'true' },
    sv('circle', { class: 'ring__track', cx: size / 2, cy: size / 2, r, 'stroke-width': stroke }), bar);
  const num = h('span', { class: 'ring__num', text: '—' });
  const el = h('div', { class: `ring ring--empty ${cls}`, role: 'img', 'aria-label': 'No taste score yet' }, svg, num);
  return { el, bar, num, circ, score: null };
}
function setRing(ring, score) {
  if (ring.score === score) return;
  ring.score = score;
  const has = typeof score === 'number' && Number.isFinite(score);
  ring.el.classList.toggle('ring--empty', !has);
  ring.el.classList.remove('ring--pass', 'ring--near', 'ring--fail');
  if (!has) {
    ring.num.textContent = '—';
    ring.bar.style.strokeDashoffset = String(ring.circ);
    ring.el.setAttribute('aria-label', 'No taste score yet');
    return;
  }
  const s = Math.max(0, Math.min(100, Math.round(score)));
  ring.el.classList.add(s >= PASS ? 'ring--pass' : s >= 70 ? 'ring--near' : 'ring--fail');
  ring.num.textContent = String(s);
  ring.el.setAttribute('aria-label', `Taste score ${s} of 100`);
  requestAnimationFrame(() => { ring.bar.style.strokeDashoffset = String(ring.circ * (1 - s / 100)); });
}
function placeholderBg(b) {
  const p = b.brand && b.brand.palette;
  const c1 = p && safeColor(p.primary), c2 = p && safeColor(p.secondary);
  if (c1 && c2) return `radial-gradient(120% 90% at 20% 10%, ${c1}, transparent 70%), linear-gradient(135deg, ${c2}, var(--ph-end))`;
  const hue = hashHue(b.name);
  return `radial-gradient(120% 90% at 18% 12%, hsl(${hue} 42% 30%), transparent 70%), linear-gradient(135deg, hsl(${(hue + 40) % 360} 30% 16%), var(--ph-end))`;
}

function updateCardFor(b) {
  let c = S.cards.get(b.id);
  if (!c) c = createCard(b);
  updateCard(c, b);
}
function createCard(b) {
  const el = h('article', { class: 'card', 'data-id': b.id, tabindex: '-1' });
  const ph = h('div', { class: 'ph' }, h('div', { class: 'ph__lines' }), h('div', { class: 'ph__swatches', 'aria-hidden': 'true' }), h('div', { class: 'ph__glyph', 'aria-hidden': 'true' }));
  const img = h('img', { alt: '', decoding: 'async', loading: 'lazy' });
  img.addEventListener('load', () => img.classList.add('is-loaded'));
  img.addEventListener('error', () => img.classList.remove('is-loaded'));
  const chipLabel = h('span');
  const chip = h('span', { class: 'chip' }, h('i'), chipLabel);
  const ring = makeRing();
  const cat = h('div', { class: 'card__cat' });
  const badges = h('div', { class: 'card__badges' });
  const thumb = h('div', { class: 'card__thumb', role: 'button', tabindex: '0' }, ph, img, h('div', { class: 'card__top' }, chip, ring.el), cat, badges);
  const name = h('h3', { class: 'card__name' });
  const meta = h('div', { class: 'card__meta' });
  const tagline = h('div', { class: 'card__tagline' });
  const stepper = h('div', { class: 'card__stepper' });
  const live = h('div', { class: 'card__live' });
  const err = h('div', { class: 'card__err' });
  const actions = h('div', { class: 'card__actions' });
  const body = h('div', { class: 'card__body' }, name, meta, tagline, stepper, live, err, actions);
  el.append(thumb, body);
  el.addEventListener('animationend', (e) => { if (e.animationName === 'cardin') el.classList.add('is-in'); });
  const open = () => openDrawer(b.id);
  thumb.addEventListener('click', open);
  thumb.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
  name.addEventListener('click', open);
  el.addEventListener('mouseenter', () => hotPin(b.id, true));
  el.addEventListener('mouseleave', () => hotPin(b.id, false));
  const refs = { el, ph, img, chip, chipLabel, ring, cat, badges, thumb, name, meta, tagline, stepper, live, err, actions, sig: {} };
  S.cards.set(b.id, refs);
  return refs;
}
function updateCard(c, b) {
  const g = groupOf(b.status);
  c.el.classList.toggle('is-flight', g === 'flight');
  c.el.classList.toggle('is-paid', g === 'paid');
  c.el.classList.toggle('is-error', g === 'error');
  c.thumb.setAttribute('aria-label', `Open details for ${b.name}`);

  const phSig = `${b.name}|${b.brand && b.brand.palette ? JSON.stringify(b.brand.palette) : ''}`;
  if (c.sig.ph !== phSig) {
    c.sig.ph = phSig;
    c.ph.style.background = placeholderBg(b);
    $('.ph__glyph', c.ph).textContent = (b.name.match(/[A-Za-z0-9]/) || ['·'])[0].toUpperCase();
    // the brand's extracted palette, shown while there is no hero image yet
    const sw = $('.ph__swatches', c.ph);
    sw.textContent = '';
    const pal = (b.brand && b.brand.palette) || {};
    for (const k of ['primary', 'secondary', 'accent', 'background', 'text']) { const col = safeColor(pal[k]); if (col) sw.append(h('i', { style: { background: col } })); }
  }
  const scan = $('.ph__scan', c.ph);
  if (g === 'flight' && !scan) c.ph.append(h('div', { class: 'ph__scan' }));
  if (g !== 'flight' && scan) scan.remove();

  const src = safeHref(b.heroImage);
  if (c.sig.img !== src) {
    c.sig.img = src;
    c.img.classList.remove('is-loaded');
    if (src) c.img.src = src; else c.img.removeAttribute('src');
  }

  if (c.sig.status !== b.status) {
    const changed = c.sig.status != null;
    c.sig.status = b.status;
    c.chip.className = `chip chip--${g}`;
    c.chipLabel.textContent = STATUS_LABEL[b.status] || b.status;
    if (changed && !REDUCED_MOTION) { c.chip.classList.remove('is-changed'); void c.chip.offsetWidth; c.chip.classList.add('is-changed'); }
  }
  const ls = lastScore(b);
  setRing(c.ring, ls ? Number(ls.score) : null);

  c.cat.textContent = '';
  const dist = fmtDist(distanceM(b));
  append(c.cat, [catLabel(b.category), dist ? h('span', { text: `· ${dist}` }) : null]);

  c.badges.textContent = '';
  if (b.video && b.video.status === 'ready') c.badges.append(h('span', { class: 'badge', text: 'Ad' }));
  if (b.video && b.video.status === 'rendering') c.badges.append(h('span', { class: 'badge badge--warn', text: 'Ad rendering' }));
  if (b.status === 'paid') c.badges.append(h('span', { class: 'badge badge--money', text: b.amountCents ? fmtUSD(b.amountCents) : 'Paid' }));

  c.name.textContent = b.name;
  c.meta.textContent = str(b.address) || (b.website && hostOf(b.website)) || 'No street address on file';
  const tl = b.brand && str(b.brand.tagline);
  if (tl) { c.tagline.hidden = false; c.tagline.textContent = `“${tl}”`; }
  else if (b.status === 'scouted') { c.tagline.hidden = false; c.tagline.textContent = b.website ? `Has a site at ${hostOf(b.website) || 'the web'} — we can do better.` : 'No website on file — a true cold open.'; }
  else c.tagline.hidden = true;

  renderStepper(c.stepper, b);
  setCardLive(c, b);

  if (b.status === 'error' && b.error) { c.err.hidden = false; c.err.textContent = b.error; } else c.err.hidden = true;

  const actSig = `${b.status}|${b.paymentUrl || ''}|${b.site ? 1 : 0}`;
  if (c.sig.act !== actSig) {
    c.sig.act = actSig;
    c.actions.textContent = '';
    append(c.actions, cardActions(b));
  }
}
function setCardLive(c, b) {
  if (!FLIGHT.has(b.status)) { c.live.hidden = true; return; }
  const e = lastEventFor(b.id);
  c.live.hidden = false;
  c.live.textContent = '';
  if (e) c.live.append(monoEl(e.agent, 'sm'), h('span', { text: str(e.text) }));
  else c.live.append(monoEl(STATUS_AGENT[b.status], 'sm'), h('span', { text: 'Starting…' }));
}
function renderStepper(wrap, b) {
  if (!FLIGHT.has(b.status)) { wrap.hidden = true; return; }
  wrap.hidden = false;
  const le = lastEventFor(b.id);
  const cur = le && le.agent === 'Closer' ? 4 : STEPS.indexOf(STATUS_AGENT[b.status]);
  const sig = `${cur}`;
  if (wrap.dataset.sig === sig) return;
  wrap.dataset.sig = sig;
  wrap.textContent = '';
  const bar = h('div', { class: 'stepper' });
  const labels = h('div', { class: 'stepper__labels' });
  STEPS.forEach((a, i) => {
    bar.append(h('div', { class: `stepper__seg ${i < cur ? 'is-done' : i === cur ? 'is-active' : ''}`, style: { '--c': AGENTS[a].color } }));
    labels.append(h('span', { class: i === cur ? 'is-active' : '', text: AGENTS[a].mono }));
  });
  wrap.append(bar, labels);
}
function cardActions(b) {
  const detailsIcon = h('button', { class: 'btn btn--ghost btn--sm btn--icon', type: 'button', 'aria-label': `Details for ${b.name}`, 'data-tip': 'Details — brand kit, taste gate, pitch' }, icon('panel'));
  detailsIcon.addEventListener('click', () => openDrawer(b.id));
  const details = detailsIcon;
  const open = btn('Open site', { kind: 'ghost', ic: 'ext', href: sitePath(b), target: '_blank' });
  const build = (label) => btn(label, { kind: 'signal', ic: 'play', busyKey: `build:${b.id}`, onClick: (e, el) => actBuild(b.id, el) });
  switch (groupOf(b.status)) {
    case 'scouted': return [build('Build site'), details];
    case 'error': return [build('Retry build'), b.site ? open : null, details];
    case 'flight': return [btn('Watch live', { kind: 'ghost', ic: 'eye', onClick: () => openDrawer(b.id) })];
    case 'ready': return [open, btn('Mark contacted', { kind: 'light', ic: 'mail', busyKey: `status:${b.id}`, onClick: (e, el) => actStatus(b.id, 'contacted', el) }), details];
    case 'contacted': return [open, btn('Mark replied', { kind: 'light', ic: 'reply', busyKey: `status:${b.id}`, onClick: (e, el) => actStatus(b.id, 'replied', el) }), details];
    case 'replied': return [open, b.paymentUrl && safeHref(b.paymentUrl) ? btn('Copy pay link', { kind: 'light', ic: 'card', onClick: () => copyText(b.paymentUrl, 'Checkout link copied') }) : null, details];
    case 'paid': return [btn('Open site', { kind: 'money', ic: 'ext', href: sitePath(b), target: '_blank' }), details];
    default: return [details];
  }
}
function focusBusiness(id, { open = false } = {}) {
  const b = S.biz.get(id);
  if (!b) return;
  let c = S.cards.get(id);
  if (!c || !c.el.isConnected) {
    S.gridFilter = 'all'; S.search = ''; $('#search').value = '';
    renderFunnel(); layoutGrid({ force: true });
    c = S.cards.get(id);
  }
  if (c) {
    c.el.scrollIntoView({ behavior: REDUCED_MOTION ? 'auto' : 'smooth', block: 'center' });
    c.el.classList.remove('is-focus'); void c.el.offsetWidth; c.el.classList.add('is-focus');
    setTimeout(() => c.el.classList.remove('is-focus'), 1700);
  }
  flyToPin(id);
  if (open) openDrawer(id);
}

// ─────────────────────────────────────────────────────────── map
const M = { map: null, tiles: null, pins: new Map(), lines: new Map(), hqMarker: null, circle: null, radar: null };
// Esri's keyless canvas basemaps (CARTO's keyless tiles now demand an API key). Same attribution for both.
const TILE_URLS = {
  dark: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
  light: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}',
};
const tileUrl = () => TILE_URLS[document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'];
function initMap() {
  const box = $('#map');
  if (!window.L) {
    box.append(h('div', { class: 'map-fallback' }, h('div', {}, h('b', { text: 'Map unavailable' }), h('div', { text: 'Leaflet could not load from the CDN. Everything else still works.' }))));
    return;
  }
  const { lat, lon } = hq();
  M.map = L.map(box, { zoomControl: false, attributionControl: true, scrollWheelZoom: true, preferCanvas: false }).setView([lat, lon], 16);
  // Native to z16, upscaled beyond; tinted in CSS (--tile-filter) to sit on either theme. applyTheme() swaps the URL.
  M.tiles = L.tileLayer(tileUrl(), {
    maxNativeZoom: 16, maxZoom: 19,
    attribution: 'Tiles &copy; <a href="https://www.esri.com/" target="_blank" rel="noopener">Esri</a> &mdash; Esri, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(M.map);
  L.control.zoom({ position: 'bottomright' }).addTo(M.map);
  M.map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  placeHQ();
  new ResizeObserver(() => M.map && M.map.invalidateSize()).observe(box);
  const legend = $('#map-legend');
  legend.append(h('span', { style: { '--c': 'var(--signal)' } }, h('i', { style: { borderRadius: '2px', transform: 'rotate(45deg)' } }), 'HQ'));
  for (const g of GROUPS) legend.append(h('span', { style: { '--c': g.color } }, h('i'), g.label));
}
// Leaflet writes stroke/fill as SVG attributes; the className lets CSS paint them from theme tokens.
function placeHQ() {
  if (!M.map) return;
  const { lat, lon, label } = hq();
  const html = h('div', { title: label }, h('div', { class: 'hq' }), h('div', { class: 'hq__label' }, h('b', { text: 'HQ' }), h('span', { text: hqShort() })));
  const icon = L.divIcon({ className: 'hq-icon', html, iconSize: [28, 28], iconAnchor: [14, 14] });
  if (M.hqMarker) { M.hqMarker.setLatLng([lat, lon]); M.hqMarker.setIcon(icon); }
  else M.hqMarker = L.marker([lat, lon], { icon, keyboard: false, zIndexOffset: 1000, interactive: false }).addTo(M.map);
  if (M.circle) M.circle.setLatLng([lat, lon]).setRadius(S.radius);
  else M.circle = L.circle([lat, lon], { radius: S.radius, className: 'hq-radius', weight: 1, opacity: 0.6, dashArray: '3 6', fillOpacity: 0.035, interactive: false }).addTo(M.map);
}
function pinIcon(g) {
  // 26px hit target around a 14px dot
  return L.divIcon({ className: 'pin-icon', html: `<div class="pin pin--${g}"></div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
}
function syncPins() {
  if (!M.map) return;
  for (const b of S.biz.values()) syncPin(b);
  for (const id of [...M.pins.keys()]) if (!S.biz.has(id)) removePin(id);
}
function syncPin(b) {
  if (!M.map) return;
  const ok = hasGeo(b);
  let p = M.pins.get(b.id);
  if (!ok) { if (p) removePin(b.id); return; }
  const g = groupOf(b.status);
  if (!p) {
    const tipName = h('span');
    const tipSub = h('small');
    const tip = h('div', {}, tipName, tipSub);
    // keyboard:false — 24 map tab stops sat between the header and the grid; the grid is the keyboard path.
    const marker = L.marker([b.lat, b.lon], { icon: pinIcon(g), keyboard: false, title: b.name, riseOnHover: true, alt: b.name }).addTo(M.map);
    marker.bindTooltip(tip, { direction: 'top', offset: [0, -10], className: 'pin-tip', opacity: 1 });
    marker.on('click', () => focusBusiness(b.id));
    marker.on('mouseover', () => { const c = S.cards.get(b.id); if (c) c.el.classList.add('is-hot'); });
    marker.on('mouseout', () => { const c = S.cards.get(b.id); if (c) c.el.classList.remove('is-hot'); });
    p = { marker, g, tipName, tipSub };
    M.pins.set(b.id, p);
  } else {
    if (p.g !== g) { p.marker.setIcon(pinIcon(g)); p.g = g; }
    const ll = p.marker.getLatLng();
    if (ll.lat !== b.lat || ll.lng !== b.lon) p.marker.setLatLng([b.lat, b.lon]);
  }
  syncLine(b, g);
  p.tipName.textContent = b.name;
  const ls = lastScore(b);
  p.tipSub.textContent = `${STATUS_LABEL[b.status] || b.status}${ls ? ` · taste ${Math.round(ls.score)}` : ''}`;
  p.marker.setZIndexOffset(g === 'flight' ? 500 : g === 'paid' ? 400 : 0);
}
function removePin(id) {
  const p = M.pins.get(id);
  if (p) { p.marker.remove(); M.pins.delete(id); }
  const l = M.lines.get(id);
  if (l) { l.remove(); M.lines.delete(id); }
}
/** Animated dispatch line HQ → business while its pipeline is running. */
function syncLine(b, g) {
  const line = M.lines.get(b.id);
  if (g !== 'flight' || !hasGeo(b)) { if (line) { line.remove(); M.lines.delete(b.id); } return; }
  const { lat, lon } = hq();
  if (line) { line.setLatLngs([[lat, lon], [b.lat, b.lon]]); return; }
  M.lines.set(b.id, L.polyline([[lat, lon], [b.lat, b.lon]], { weight: 1.5, opacity: 0.85, dashArray: '2 7', className: 'flight-line', interactive: false }).addTo(M.map));
}
function hotPin(id, on) {
  const p = M.pins.get(id);
  const el = p && p.marker.getElement();
  const pin = el && el.querySelector('.pin');
  if (pin) pin.classList.toggle('is-hot', on);
  if (p) p.marker.setZIndexOffset(on ? 900 : p.g === 'flight' ? 500 : 0);
}
function flyToPin(id) {
  const p = M.pins.get(id);
  if (!p || !M.map) return;
  M.map.panTo(p.marker.getLatLng(), { animate: !REDUCED_MOTION });
  hotPin(id, true);
  setTimeout(() => hotPin(id, false), 1600);
}
function fitMap() {
  if (!M.map) return;
  const { lat, lon } = hq();
  const pts = [[lat, lon], ...[...M.pins.values()].map((p) => p.marker.getLatLng())];
  if (pts.length < 2) { M.map.setView([lat, lon], 16); return; }
  M.map.fitBounds(L.latLngBounds(pts), { padding: [28, 28], maxZoom: 17, animate: !REDUCED_MOTION });
}
function startRadar() {
  if (!M.map || REDUCED_MOTION) return;
  stopRadar();
  const { lat, lon } = hq();
  const c = L.circle([lat, lon], { radius: 1, className: 'radar-ring', weight: 1.5, opacity: 0.8, fillOpacity: 0.1, interactive: false }).addTo(M.map);
  const t0 = performance.now();
  const step = (t) => {
    const p = ((t - t0) % 1700) / 1700;
    c.setRadius(Math.max(1, S.radius * p));
    c.setStyle({ opacity: 0.85 * (1 - p), fillOpacity: 0.12 * (1 - p) });
    M.radar.raf = requestAnimationFrame(step);
  };
  M.radar = { c, raf: requestAnimationFrame(step) };
}
function stopRadar() {
  if (!M.radar) return;
  cancelAnimationFrame(M.radar.raf);
  M.radar.c.remove();
  M.radar = null;
}

// ─────────────────────────────────────────────────────────── crew
const CREW = {};
function renderCrew() {
  const wrap = $('#crew');
  if (!wrap.children.length) {
    for (const a of AGENT_NAMES) {
      const last = h('div', { class: 'agent__last', text: 'Standing by.' });
      const count = h('span', { class: 'agent__count' });
      const el = h('button', { class: 'agent is-idle', type: 'button', style: { '--c': AGENTS[a].color }, 'aria-pressed': 'false', 'data-tip': `${a} — ${AGENTS[a].role}. Click to show only ${a} in the channel.` },
        monoEl(a, 'sm'), h('div', { class: 'agent__id' }, h('span', { class: 'agent__name', text: a }), h('span', { class: 'agent__role', text: AGENTS[a].role })), last, count);
      el.addEventListener('click', () => { S.feedAgent = S.feedAgent === a ? null : a; renderFeedFilters(); renderFeed(); syncCrewFilter(); });
      wrap.append(el);
      CREW[a] = { el, last, count };
    }
  }
  for (const a of AGENT_NAMES) updateCrewTile(a);
  updateCrewOutcomes();
  syncCrewFilter();
}
/** Each agent's running total, derived from the businesses themselves (the event window only holds the last 400). */
function updateCrewOutcomes() {
  if (!CREW.Scout) return;
  const st = statsNow();
  const list = [...S.biz.values()];
  const n = {
    Scout: `${fmtInt(st.scouted)} found`,
    Archivist: `${list.filter((b) => b.brand).length} brands`,
    Builder: `${fmtInt(st.built)} built`,
    Critic: `${fmtInt(st.tastePassed)} passed`,
    Director: `${list.filter((b) => safeHref(b.heroImage)).length} heroes`,
    Closer: `${list.filter((b) => safeHref(b.paymentUrl)).length} checkouts`,
    CFO: fmtSpend(Number(st.spendCents) || 0),
    System: `${fmtInt(S.events.filter((e) => e.agent === 'System').length)} notes`,
  };
  for (const a of AGENT_NAMES) if (CREW[a]) CREW[a].count.textContent = n[a];
}
function renderCrewRoles() {
  for (const a of AGENT_NAMES) { const t = CREW[a]; if (t) { const r = $('.agent__role', t.el); if (r) r.textContent = AGENTS[a].role; } }
}
function updateCrewTile(a) {
  const t = CREW[a];
  if (!t) return;
  let last = null;
  for (let i = S.events.length - 1; i >= 0; i--) if (S.events[i].agent === a) { last = S.events[i]; break; }
  t.last.textContent = last ? str(last.text) : 'Standing by.';
  t.last.title = last ? str(last.text) : '';
  if (a === 'System') updateCrewOutcomes();
  syncWorking();
}
function syncWorking() {
  const now = performance.now();
  let working = 0;
  for (const a of AGENT_NAMES) {
    const on = S.agentSeen[a] && now - S.agentSeen[a] < 7000;
    if (on) working++;
    if (CREW[a]) { CREW[a].el.classList.toggle('is-working', !!on); CREW[a].el.classList.toggle('is-idle', !on); }
  }
  $('#crew-sub').textContent = working ? `${working} working` : 'idle';
}
function syncCrewFilter() {
  for (const a of AGENT_NAMES) if (CREW[a]) { CREW[a].el.classList.toggle('is-filter', S.feedAgent === a); CREW[a].el.setAttribute('aria-pressed', String(S.feedAgent === a)); }
}

// ─────────────────────────────────────────────────────────── feed
const feedMatches = (e) => (!S.feedAgent || e.agent === S.feedAgent) && (!S.feedBiz || e.bizId === S.feedBiz);
const FF = { chips: {}, biz: null, bizLabel: null };
function renderFeedFilters() {
  const wrap = $('#feed-filters');
  if (!FF.built) {
    FF.built = true;
    FF.bizLabel = h('span');
    FF.biz = h('button', { class: 'fchip fchip--clear', type: 'button', 'aria-label': 'Clear business filter', hidden: true }, FF.bizLabel, h('b', { text: '×' }));
    FF.biz.addEventListener('click', () => { S.feedBiz = null; renderFeedFilters(); renderFeed(); });
    wrap.append(FF.biz);
    const mk = (key, label, color) => {
      const n = h('b', { text: '0' });
      const b = h('button', { class: 'fchip', type: 'button', 'aria-pressed': 'false', style: { '--c': color } }, key ? monoEl(key) : null, label, n);
      b.addEventListener('click', () => { S.feedAgent = key && S.feedAgent !== key ? key : null; renderFeedFilters(); renderFeed(); syncCrewFilter(); });
      wrap.append(b);
      FF.chips[key || 'all'] = { b, n };
    };
    mk(null, 'All', 'var(--text)');
    for (const a of AGENT_NAMES) mk(a, a, AGENTS[a].color);
  }
  const counts = {};
  for (const e of S.events) counts[e.agent] = (counts[e.agent] || 0) + 1;
  for (const [key, c] of Object.entries(FF.chips)) {
    c.n.textContent = String(key === 'all' ? S.events.length : counts[key] || 0);
    c.b.setAttribute('aria-pressed', String(key === 'all' ? !S.feedAgent : S.feedAgent === key));
  }
  const biz = S.feedBiz && S.biz.get(S.feedBiz);
  FF.biz.hidden = !S.feedBiz;
  FF.bizLabel.textContent = `Only ${biz ? biz.name : 'business'}`;
  $('#feed-count').textContent = `· ${fmtInt(S.events.length)} messages`;
  updateMtabs();
}
const MILESTONE = /\b(scored \d+|cleared|shipped|is live|live at|paid|claimed)\b/i;
const STATUS_TOKEN = { scouted: 'var(--st-scouted)', flight: 'var(--st-flight)', ready: 'var(--st-ready)', contacted: 'var(--st-contacted)', replied: 'var(--st-replied)', paid: 'var(--st-paid)', error: 'var(--st-error)' };
function msgNode(e, prev) {
  const a = AGENTS[e.agent] || AGENTS.System;
  const kind = ['info', 'success', 'warn', 'error', 'money'].includes(e.kind) ? e.kind : 'info';
  const cont = prev && prev.agent === e.agent && (prev.bizId || null) === (e.bizId || null) && kind !== 'money' && prev.kind !== 'money' && Math.abs((e.ts || 0) - (prev.ts || 0)) < 90000;
  const raw = str(e.text);
  const text = h('div', { class: 'msg__text', text: raw });
  if (e.data && e.data.provider === 'brainbase') text.append(h('span', { class: 'msg__tag msg__tag--brainbase', title: 'Second opinion from a Brainbase managed agent', text: 'Brainbase' }));
  const biz = e.bizId && S.biz.get(e.bizId);
  let tag = null;
  if (biz) {
    tag = h('button', { class: 'msg__biz', type: 'button', title: `Open ${biz.name}`, style: { '--bc': STATUS_TOKEN[groupOf(biz.status)] } }, h('i'), h('span', { text: biz.name }));
    tag.addEventListener('click', () => focusBusiness(biz.id, { open: true }));
  }
  // long critiques collapse to four lines; click (or the toggle) to read the rest
  let more = null;
  if (raw.length > 260) {
    text.classList.add('is-clamped');
    more = h('button', { class: 'msg__more', type: 'button', 'aria-expanded': 'false', text: 'Show more' });
    const toggle = () => { const open = text.classList.toggle('is-clamped'); more.textContent = open ? 'Show more' : 'Show less'; more.setAttribute('aria-expanded', String(!open)); };
    more.addEventListener('click', toggle);
    text.addEventListener('click', (ev) => { if (ev.target === text && text.classList.contains('is-clamped')) toggle(); });
  }
  const milestone = kind === 'money' || (kind === 'success' && MILESTONE.test(raw));
  const head = cont ? null : h('div', { class: 'msg__head' },
    h('span', { class: 'msg__agent', text: e.agent }), tag,
    h('time', { class: 'msg__time', datetime: new Date(e.ts || Date.now()).toISOString(), text: fmtTime(e.ts) }));
  const li = h('li', { class: `msg msg--${kind} ${cont ? 'msg--cont' : ''} ${milestone ? 'msg--milestone' : ''}`, style: { '--c': a.color } },
    monoEl(e.agent), head, text, more);
  li._ev = e;
  return li;
}
function renderFeed() {
  const feed = $('#feed');
  feed.textContent = '';
  let prev = null;
  const list = S.events.filter(feedMatches);
  for (const e of list) { feed.append(msgNode(e, prev)); prev = e; }
  if (!list.length) {
    feed.append(h('li', { class: 'feed-empty' }, h('b', { text: S.events.length ? 'Nothing from this agent yet.' : 'The crew is standing by.' }), S.events.length ? 'Pick another filter, or clear it.' : 'Scout the block or start a live challenge — every agent reports here in real time.'));
  }
  feed.scrollTop = feed.scrollHeight;
  S.feedUnread = 0;
  $('#feed-jump').hidden = true;
}
function appendFeed(e) {
  if (!feedMatches(e)) return;
  const feed = $('#feed');
  const empty = $('.feed-empty', feed);
  if (empty) empty.remove();
  const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
  const lastLi = feed.lastElementChild;
  feed.append(msgNode(e, lastLi && lastLi._ev));
  while (feed.children.length > MAX_EVENTS) feed.firstElementChild.remove();
  if (atBottom) feed.scrollTop = feed.scrollHeight;
  else {
    S.feedUnread++;
    const j = $('#feed-jump');
    j.hidden = false;
    j.textContent = `${S.feedUnread} new ${S.feedUnread === 1 ? 'message' : 'messages'} ↓`;
  }
}

// ─────────────────────────────────────────────────────────── actions
async function runAction(key, fn, errTitle) {
  if (S.busy.has(key)) return undefined;
  S.busy.add(key);
  refreshBusy();
  try { return await fn(); }
  catch (e) { toastErr(e, errTitle); return undefined; }
  finally { S.busy.delete(key); refreshBusy(); }
}
function actScout() {
  return runAction('scout', async () => {
    S.scouting = true;
    startRadar();
    toast({ kind: 'info', title: 'Scout is walking the block', text: `Searching OpenStreetMap within ${S.radius} m of HQ for independents…`, timeout: 3500 });
    try {
      const r = await api('POST', '/api/scout', { radius: S.radius, limit: 24 }, { timeout: 95000 });
      const added = arr(r && r.added);
      for (const b of added) upsertBusiness(b);
      if (added.length) {
        toast({ kind: 'success', title: `Found ${added.length} new ${added.length === 1 ? 'business' : 'businesses'}`, text: `${r.total ?? S.biz.size} on the block. ${COARSE ? 'Tap Run block' : 'Press R'} to build them.` });
        fitMap();
      } else {
        toast({ kind: 'info', title: 'No new independents found', text: `Everything within ${S.radius} m is already on the board. Try a wider radius.` });
      }
    } finally {
      S.scouting = false;
      stopRadar();
    }
  }, 'Scout came back empty-handed');
}
function actRunBlock() {
  const waiting = [...S.biz.values()].filter((b) => b.status === 'scouted').length;
  if (!waiting) {
    toast({ kind: 'warn', title: 'Nothing waiting to build', text: S.biz.size ? 'Every business on the board is built or in flight. Scout for more.' : 'Scout the block first (S).' });
    return;
  }
  return runAction('run', async () => {
    const r = await api('POST', '/api/run-block', { limit: 8 });
    const n = Number(r && r.queued) || Math.min(8, waiting);
    toast({ kind: 'info', title: `Running the block — ${n} ${n === 1 ? 'site' : 'sites'}`, text: 'Three at a time, nearest first: Archivist → Builder → Critic → Director → Closer.' });
  }, 'Could not run the block');
}
function actBuild(id) {
  const b = S.biz.get(id);
  return runAction(`build:${id}`, async () => {
    await api('POST', `/api/businesses/${enc(id)}/build`, {});
    toast({ kind: 'info', title: `${b && BUILT.has(b.status) ? 'Rebuilding' : 'Building'} ${b ? b.name : 'site'}`, text: 'Follow along in #agent-channel.' });
  }, 'Build did not start');
}
function actStatus(id, status) {
  return runAction(`status:${id}`, async () => {
    const b = await api('POST', `/api/businesses/${enc(id)}/status`, { status });
    if (b && b.id) upsertBusiness(b);
    toast({ kind: 'success', title: status === 'contacted' ? 'Marked as contacted' : 'Marked as replied', text: (b && b.name) || '' });
  }, 'Status not saved');
}
function actPitch(id) {
  return runAction(`pitch:${id}`, async () => {
    const b = await api('POST', `/api/businesses/${enc(id)}/pitch`, {});
    if (b && b.id) upsertBusiness(b);
    toast({ kind: 'success', title: 'Fresh pitch written', text: 'The Closer rewrote the email from the brand kit.' });
  }, 'Pitch not rewritten');
}
function actVideo(id) {
  return runAction(`video:${id}`, async () => {
    await api('POST', `/api/businesses/${enc(id)}/video`, {});
    toast({ kind: 'info', title: 'Higgsfield is rendering the ad', text: 'The Director will post here when it lands.' });
  }, 'Video did not start');
}
function actVideoUrl(id, url, input) {
  const u = normalizeHttpUrl(url);
  if (!u) {
    if (input) { input.classList.add('is-invalid'); input.focus(); }
    toast({ kind: 'error', title: 'That is not a valid video URL', text: 'Paste a full https:// link to the rendered ad.' });
    return;
  }
  return runAction(`videourl:${id}`, async () => {
    const b = await api('POST', `/api/businesses/${enc(id)}/video-url`, { url: u });
    videoDraft.delete(id);
    if (input) input.value = '';
    // The WS broadcast usually re-renders the drawer before this response lands, so clear the live field too.
    const live = $('#video-url');
    if (live && live !== input) live.value = '';
    if (b && b.id) upsertBusiness(b);
    toast({ kind: 'success', title: 'Ad attached', text: 'It now plays in the details drawer.' });
  }, 'Video not attached');
}
async function actRemove(id) {
  const b = S.biz.get(id);
  if (!b) return;
  const ok = await confirmDialog({
    title: `Remove ${b.name}'s preview?`,
    text: 'The concept site will immediately show a “preview removed” notice instead of the design, and the business leaves the board. Use this whenever an owner asks.',
    confirm: 'Remove preview', danger: true,
  });
  if (!ok) return;
  await runAction(`remove:${id}`, async () => {
    await api('DELETE', `/api/businesses/${enc(id)}`);
    removeBusiness(id);
  });
}
async function actReset() {
  closeMenu();
  const ok = await confirmDialog({
    title: 'Reset the demo?',
    text: 'This clears every business, generated site, score, event and payment record in HQ. It cannot be undone.',
    confirm: 'Reset everything', danger: true,
  });
  if (!ok) return;
  await runAction('reset', async () => {
    await api('POST', '/api/reset', { confirm: 'RESET' });
    S.celebrated.clear();
    if (S.drawerId) closeDrawer();
    chReset();
    await refreshState({ quiet: false });
    toast({ kind: 'success', title: 'Demo reset', text: 'The block is quiet again.' });
  });
}
async function copyText(text, msg = 'Copied') {
  const t = str(text);
  let ok = false;
  try { await navigator.clipboard.writeText(t); ok = true; } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0', top: '0', left: '0' } });
    ta.value = t;
    document.body.append(ta);
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (ok) toast({ kind: 'success', title: msg, timeout: 2200 });
  else toast({ kind: 'error', title: 'Clipboard blocked', text: t });
}

// ─────────────────────────────────────────────────────────── drawer
const videoDraft = new Map();
const loadedFonts = new Set(['Inter', 'Instrument Serif', 'JetBrains Mono']);
function ensureFont(fam) {
  const f = safeFont(fam);
  if (!f || loadedFonts.has(f)) return;
  loadedFonts.add(f);
  document.head.append(h('link', { rel: 'stylesheet', href: `https://fonts.googleapis.com/css2?family=${enc(f).replace(/%20/g, '+')}&display=swap` }));
}
function openDrawer(id) {
  if (!S.biz.has(id)) return;
  const wasOpen = !!S.drawerId;
  if (!wasOpen) S.lastFocus = document.activeElement;
  if (S.drawerId !== id) { const inner = $('#drawer-inner'); inner.textContent = ''; inner.scrollTop = 0; D.previewKey = null; }
  S.drawerId = id;
  clearTimeout(D.closeT);
  const d = $('#drawer');
  d.classList.remove('is-closing');
  d.hidden = false;
  $('#drawer-scrim').hidden = false;
  D.sig = null;
  renderDrawer();
  try { history.replaceState(null, '', `${location.pathname}${location.search}#/b/${enc(id)}`); } catch { /* sandboxed */ }
  syncInert();
  if (!wasOpen) setTimeout(() => { if (S.drawerId) d.focus({ preventScroll: true }); }, 30);
}
function closeDrawer() {
  if (!S.drawerId) return;
  S.drawerId = null;
  const d = $('#drawer');
  D.previewLive = false;
  const done = () => { if (S.drawerId) return; d.hidden = true; d.classList.remove('is-closing'); $('#drawer-inner').textContent = ''; D.previewKey = null; D.sig = null; };
  clearTimeout(D.closeT);
  if (REDUCED_MOTION) done();
  else { d.classList.add('is-closing'); D.closeT = setTimeout(done, 230); }
  $('#drawer-scrim').hidden = true;
  syncInert();
  try { history.replaceState(null, '', `${location.pathname}${location.search}`); } catch { /* sandboxed */ }
  if (S.lastFocus && S.lastFocus.isConnected) S.lastFocus.focus({ preventScroll: true });
}
function openFromHash() {
  const m = location.hash.match(/^#\/b\/(.+)$/);
  if (m) { const id = decodeURIComponent(m[1]); if (S.biz.has(id)) openDrawer(id); }
}
const D = { previewKey: null, previewId: null, previewLive: false, header: null, preview: null, body: null, sig: null, hold: false, pending: false, closeT: 0 };
// Never rebuild the drawer between pointerdown and click, or the click would land on a detached node.
$('#drawer').addEventListener('pointerdown', () => { D.hold = true; });
addEventListener('pointerup', () => {
  if (!D.hold) return;
  setTimeout(() => { D.hold = false; if (D.pending) { D.pending = false; renderDrawer(); } }, 0);
});
function renderDrawer() {
  const b = S.biz.get(S.drawerId);
  if (!b) { closeDrawer(); return; }
  if (D.hold) { D.pending = true; return; }
  const le = lastEventFor(b.id);
  const sig = `${JSON.stringify(b)}|${le ? le.id : ''}|${S.config ? 1 : 0}`;
  if (sig === D.sig) return;
  D.sig = sig;
  const inner = $('#drawer-inner');
  if (!inner.firstChild) {
    D.header = h('div');
    D.preview = h('div');
    D.body = h('div');
    inner.append(D.header, D.preview, D.body);
  }
  // preserve focus inside the video URL field across live re-renders
  const active = document.activeElement;
  const focusVideo = active && active.id === 'video-url';
  const selStart = focusVideo ? active.selectionStart : null;
  const scroll = inner.scrollTop;

  D.header.textContent = '';
  D.header.append(drawerHeader(b));
  renderPreview(b);
  D.body.textContent = '';
  append(D.body, [
    b.status === 'error' && b.error ? h('div', { class: 'err-box' }, h('b', { text: 'Pipeline error · ' }), b.error) : null,
    FLIGHT.has(b.status) ? liveSection(b) : null,
    gateSection(b),
    brandSection(b),
    pitchSection(b),
    checkoutSection(b),
    videoSection(b),
    timingSection(b),
    logSection(b),
    factsSection(b),
    dangerSection(b),
  ]);
  inner.scrollTop = scroll;
  if (focusVideo) { const v = $('#video-url'); if (v) { v.focus({ preventScroll: true }); try { v.setSelectionRange(selStart, selStart); } catch { /* ignore */ } } }
  requestAnimationFrame(() => {
    for (const f of $$('.bar__fill[data-h]', D.body)) f.style.height = f.dataset.h;
    for (const f of $$('.tbar__fill[data-w]', D.body)) f.style.width = f.dataset.w;
  });
}
function section(title, kicker, ...content) {
  return h('section', { class: 'ds' }, h('div', { class: 'ds__head' }, h('h3', { class: 'ds__title', text: title }), kicker ? h('span', { class: 'ds__kicker', text: kicker }) : null), ...content);
}
function drawerHeader(b) {
  const wrap = h('div', { class: 'dh' });
  const src = safeHref(b.heroImage);
  const bg = h('div', { class: 'dh__bg' });
  if (src) bg.style.backgroundImage = `url("${src.replace(/["\\\n\r]/g, '')}")`;
  else bg.style.background = placeholderBg(b);
  const ring = makeRing(76, 6, 'ring--lg');
  const ls = lastScore(b);
  const g = groupOf(b.status);
  const close = h('button', { class: 'icon-btn dh__close', type: 'button', 'aria-label': 'Close details' }, icon('close'));
  close.addEventListener('click', closeDrawer);
  const metaBits = [catLabel(b.category), str(b.address), fmtDist(distanceM(b))].filter(Boolean).join(' · ');
  const webHref = safeHref(b.website);
  const meta = h('div', { class: 'dh__meta' }, metaBits, webHref ? h('span', {}, ' · ', h('a', { href: webHref, target: '_blank', rel: 'noopener noreferrer', text: hostOf(webHref) || 'website' })) : null);
  const actions = h('div', { class: 'dh__actions' });
  if (b.site || BUILT.has(b.status)) actions.append(btn('Open site', { kind: 'light', ic: 'ext', size: '', href: sitePath(b), target: '_blank' }), btn('QR code', { ic: 'qr', size: '', tip: 'Big QR code for the audience to scan', onClick: () => qrDialog(b) }));
  if (FLIGHT.has(b.status)) actions.append(btn('Building…', { kind: 'ghost', size: '', ic: 'refresh', disabled: true, tip: 'The pipeline is running — watch the live section below.' }));
  else actions.append(btn(BUILT.has(b.status) ? 'Rebuild' : b.status === 'error' ? 'Retry build' : 'Build site', { kind: BUILT.has(b.status) ? 'ghost' : 'signal', size: '', ic: BUILT.has(b.status) ? 'refresh' : 'play', busyKey: `build:${b.id}`, onClick: () => actBuild(b.id) }));
  if (b.status === 'ready') actions.append(btn('Mark contacted', { size: '', ic: 'mail', busyKey: `status:${b.id}`, onClick: () => actStatus(b.id, 'contacted') }));
  if (b.status === 'ready' || b.status === 'contacted') actions.append(btn('Mark replied', { size: '', ic: 'reply', busyKey: `status:${b.id}`, onClick: () => actStatus(b.id, 'replied') }));
  const feedOnly = btn('Filter channel', { size: '', kind: 'ghost', tip: 'Show only this business in #agent-channel', onClick: () => { S.feedBiz = b.id; renderFeedFilters(); renderFeed(); toast({ kind: 'info', title: `Channel filtered to ${b.name}`, timeout: 2000 }); } });
  actions.append(feedOnly);

  const crm = h('div', { class: 'crm', 'aria-label': 'Outreach progress' });
  const steps = [
    ['Built', BUILT.has(b.status), 'var(--st-ready)', b.site ? `site v${b.site.version}` : ''],
    ['Contacted', ['contacted', 'replied', 'paid'].includes(b.status) || !!b.contactedAt, 'var(--st-contacted)', b.contactedAt ? fmtDate(b.contactedAt) : ''],
    ['Replied', ['replied', 'paid'].includes(b.status) || !!b.repliedAt, 'var(--st-replied)', b.repliedAt ? fmtDate(b.repliedAt) : ''],
    ['Paid', b.status === 'paid', 'var(--st-paid)', b.paidAt ? fmtDate(b.paidAt) : ''],
  ];
  for (const [label, done, c, sub] of steps) crm.append(h('div', { class: `crm__step ${done ? 'is-done' : ''}`, style: { '--c': c } }, label, h('small', { text: sub || ' ' })));

  wrap.append(bg,
    h('div', { class: 'dh__kicker' }, h('span', { class: `chip chip--${g}` }, h('i'), STATUS_LABEL[b.status] || b.status), b.paymentVerified && b.status === 'paid' ? h('span', { class: 'label-ok', text: 'Verified by Stripe' }) : null),
    h('div', { class: 'dh__row' },
      h('div', { style: { minWidth: '0' } }, h('h2', { class: 'dh__title', id: 'drawer-title', text: b.name }), meta, b.brand && b.brand.tagline ? h('div', { class: 'dh__tagline', text: `“${b.brand.tagline}”` }) : null),
      h('div', { style: { display: 'flex', gap: '10px', alignItems: 'flex-start' } }, ring.el, close)),
    actions, crm);
  setRing(ring, ls ? Number(ls.score) : null);
  return wrap;
}
function renderPreview(b) {
  const hasSite = !!b.site || BUILT.has(b.status);
  const key = hasSite ? `${b.id}|${b.site ? b.site.version : ''}|${b.heroImage || ''}|${b.updatedAt && BUILT.has(b.status) ? 'b' : ''}|${b.site ? b.site.headline : ''}` : null;
  if (key === D.previewKey) return;
  const wasLive = D.previewLive && D.previewId === b.id;
  D.previewKey = key;
  D.previewId = b.id;
  D.preview.textContent = '';
  if (!hasSite) { D.previewLive = false; return; }
  const box = h('div', { class: 'preview' });
  // The Worker counts every GET of /s/:id as a real view ("Someone just opened…"), so the live frame
  // loads only when the operator asks for it — never automatically.
  const mountLive = () => {
    D.previewLive = true;
    box.textContent = '';
    box.append(
      h('iframe', { src: sitePath(b), title: `Live preview of ${b.name}'s concept site`, sandbox: 'allow-scripts allow-popups', referrerpolicy: 'no-referrer', tabindex: '-1' }),
      h('a', { class: 'preview__open', href: sitePath(b), target: '_blank', rel: 'noopener', 'aria-label': 'Open the concept site in a new tab' }, h('span', { class: 'btn btn--light btn--sm' }, icon('ext'), h('span', { text: 'Open full site' }))));
  };
  if (wasLive) mountLive();
  else box.append(previewPoster(b, mountLive));
  D.preview.append(section('The concept site', b.site ? `v${b.site.version} · ${b.site.theme || 'custom'} theme` : 'built', box));
}
function previewPoster(b, onLive) {
  const p = (b.brand && b.brand.palette) || {};
  const bg = safeColor(p.background) || 'var(--panel-3)', fg = safeColor(p.text) || 'var(--text)', accent = safeColor(p.accent) || safeColor(p.primary) || 'var(--signal)';
  const hf = safeFont(b.brand && b.brand.fonts && b.brand.fonts.heading);
  if (hf) ensureFont(hf);
  const hero = safeHref(b.heroImage);
  const poster = h('div', { class: 'poster', style: { background: bg, color: fg } },
    hero ? h('div', { class: 'poster__img', style: { backgroundImage: `url("${hero.replace(/["\\\n\r]/g, '')}")` } }) : h('div', { class: 'poster__img', style: { background: placeholderBg(b) } }),
    h('div', { class: 'poster__shade' }),
    h('div', { class: 'poster__copy' },
      h('div', { class: 'poster__kick', style: { color: accent }, text: catLabel(b.category) }),
      h('div', { class: 'poster__h', style: { fontFamily: hf ? `"${hf}", var(--serif)` : null }, text: (b.site && str(b.site.headline)) || b.name }),
      b.site && b.site.subheadline ? h('div', { class: 'poster__s', text: str(b.site.subheadline) }) : null),
    h('div', { class: 'poster__actions' },
      btn('Load live preview', { kind: 'light', ic: 'eye', onClick: onLive, tip: 'Loads the real page here. Heads-up: HQ counts it as a view.', tipPos: 'bottom' }),
      btn('Open full site', { ic: 'ext', href: sitePath(b), target: '_blank' })));
  return poster;
}
function liveSection(b) {
  const le = lastEventFor(b.id);
  const cur = le && le.agent === 'Closer' ? 4 : STEPS.indexOf(STATUS_AGENT[b.status]);
  const segs = h('div', { class: 'ch-segs', style: { gridTemplateColumns: 'repeat(5, 1fr)', marginTop: '0' } });
  const labels = h('div', { class: 'stepper__labels', style: { marginBottom: '14px' } });
  STEPS.forEach((a, i) => {
    segs.append(h('div', { class: `ch-seg ${i < cur ? 'is-done' : i === cur ? 'is-active' : ''}`, style: { '--c': AGENTS[a].color } }));
    labels.append(h('span', { class: i === cur ? 'is-active' : '', text: a }));
  });
  return section('On the floor now', `${STATUS_AGENT[b.status]} is working`, segs, labels,
    le ? h('div', { class: 'ch-ticker' }, monoEl(le.agent), h('p', {}, h('b', { text: `${le.agent} ` }), str(le.text))) : h('p', { class: 'ds__note', text: 'Waiting for the first report…' }));
}
function barsChart(scores, { small = false } = {}) {
  const wrap = h('div', { class: `bars ${small ? 'bars--sm' : ''}`, role: 'img', 'aria-label': `Taste scores by version: ${scores.map((s) => `v${s.version} ${Math.round(s.score)}`).join(', ')}` });
  const axis = h('div', { class: 'bars__axis', 'aria-hidden': 'true' });
  for (const v of [0, 50, 100]) axis.append(h('span', { style: { bottom: `${v}%` }, text: String(v) }));
  wrap.append(axis, h('div', { class: 'bars__gate', style: { top: `${100 - PASS}%` } }, h('span', { text: `GATE ${PASS}` })));
  for (const s of scores) {
    const sc = Math.max(0, Math.min(100, Number(s.score) || 0));
    wrap.append(h('div', { class: 'bar' }, h('div', { class: sc < 70 ? 'bar__fill bar__fill--fail' : 'bar__fill', style: { '--c': scoreColor(sc) }, 'data-h': `${sc}%`, 'data-low': sc < 22 ? '1' : null }, h('span', { class: 'bar__val', text: String(Math.round(sc)) })), h('span', { class: 'bar__lbl', text: `v${s.version}` })));
  }
  return wrap;
}
function gateSection(b) {
  const scores = b.scores;
  if (!scores.length) {
    return section('Taste gate', `Critic scores every version · pass ≥ ${PASS}`,
      h('p', { class: 'ds__note', text: FLIGHT.has(b.status) ? 'Waiting for the Critic’s first verdict…' : 'No critiques yet. Build the site to start the self-improvement loop: the Critic scores each version, the Builder revises from its notes, up to three passes.' }));
  }
  const first = scores[0], last = lastScore(b) || scores[scores.length - 1];
  const passed = Number(last.score) >= PASS;
  const delta = Math.round(Number(last.score) - Number(first.score));
  const story = h('p', { class: 'gate-story' });
  if (scores.length === 1) {
    append(story, passed
      ? ['v1 cleared the gate at ', h('b', { text: String(Math.round(last.score)) }), ' on the first pass.']
      : ['v1 scored ', h('b', { text: String(Math.round(last.score)) }), ` — below the ${PASS} gate.`, FLIGHT.has(b.status) ? ' The Builder is revising from the Critic’s notes.' : '']);
  } else {
    append(story, ['The Critic rejected v1 at ', h('b', { text: String(Math.round(first.score)) }), `. The Builder revised ${scores.length - 1}× from its notes → `,
      h('b', { text: `v${last.version} ${passed ? 'cleared the gate' : 'finished'} at ${Math.round(last.score)}` }), ' ', delta > 0 ? h('span', { class: 'up', text: `+${delta}` }) : null, passed ? '' : '. Shipped the best version; flagged for a human look.']);
  }
  const versions = h('div', { class: 'versions' });
  scores.forEach((s, i) => {
    const prev = scores[i - 1];
    const d = prev ? Math.round(Number(s.score) - Number(prev.score)) : null;
    versions.append(h('div', { class: 'ver', style: { '--c': scoreInk(Number(s.score)) } },
      h('div', {}, h('div', { class: 'ver__score', text: String(Math.round(Number(s.score))) }), h('div', { class: 'ver__v', text: `V${s.version}` })),
      h('div', { style: { minWidth: '0' } },
        h('div', { class: 'ver__meta' }, h('b', { text: str(s.provider) || 'critic' }), s.at ? ` · ${fmtTime(s.at)}` : '', ' ', d != null ? h('span', { class: `delta ${d >= 0 ? 'delta--up' : 'delta--down'}`, text: `${d >= 0 ? '+' : ''}${d}` }) : null, Number(s.score) >= PASS ? h('span', { class: 'delta delta--up', style: { marginLeft: '4px' }, text: 'PASS' }) : null),
        arr(s.notes).length ? h('ul', {}, arr(s.notes).map((n) => h('li', { text: str(n) }))) : h('div', { class: 'ds__note', text: 'No notes.' }),
        arr(s.slopHits).length ? h('div', { class: 'slop', 'aria-label': 'Banned phrases caught' }, arr(s.slopHits).map((x) => h('span', { text: str(x) }))) : null)));
  });
  return section('Taste gate', `${scores.length} ${scores.length === 1 ? 'version' : 'versions'} · pass ≥ ${PASS}`, story, barsChart(scores), versions);
}
function brandSection(b) {
  const br = b.brand;
  if (!br) return section('Brand kit', 'Archivist', h('p', { class: 'ds__note', text: FLIGHT.has(b.status) ? 'The Archivist is reading the brand…' : 'The Archivist extracts palette, type, voice and offerings from the business’s own site (or its OpenStreetMap tags) when you build.' }));
  const pal = br.palette || {};
  const palette = h('div', { class: 'palette' });
  for (const k of ['primary', 'secondary', 'accent', 'background', 'text']) {
    const c = safeColor(pal[k]);
    const sw = h('button', { class: 'sw', type: 'button', title: c ? `Copy ${c}` : 'No color', disabled: !c }, h('div', { class: 'sw__chip', style: { background: c || 'repeating-linear-gradient(45deg, var(--track) 0 4px, var(--panel-2) 4px 8px)' } }), h('span', { class: 'sw__name', text: k }), h('span', { class: 'sw__hex', text: c ? c.toUpperCase() : '—' }));
    if (c) sw.addEventListener('click', () => copyText(c.toUpperCase(), `Copied ${c.toUpperCase()}`));
    palette.append(sw);
  }
  const fonts = br.fonts || {};
  const hf = safeFont(fonts.heading), bf = safeFont(fonts.body);
  if (hf) ensureFont(hf);
  if (bf) ensureFont(bf);
  const type = h('div', { class: 'type' },
    h('div', { class: 'type__card' }, h('div', { class: 'type__role', text: 'Heading' }), h('div', { class: 'type__family', text: hf || '—' }), h('div', { class: 'type__sample', style: { fontFamily: hf ? `"${hf}", var(--serif)` : null }, text: br.name || b.name })),
    h('div', { class: 'type__card' }, h('div', { class: 'type__role', text: 'Body' }), h('div', { class: 'type__family', text: bf || '—' }), h('div', { class: 'type__sample type__sample--body', style: { fontFamily: bf ? `"${bf}", var(--sans)` : null }, text: str(br.story) || str(br.tagline) || 'The quick brown fox jumps over the lazy dog.' })));
  const kv = h('dl', { class: 'kv' });
  const row = (k, v, cls) => { if (v) kv.append(h('dt', { text: k }), v instanceof Node ? h('dd', {}, v) : h('dd', { class: cls, text: v })); };
  row('Voice', str(br.voice) ? `“${br.voice}”` : '', 'q');
  row('Vibe', str(br.vibe) ? `“${br.vibe}”` : '', 'q');
  if (arr(br.keywords).length) row('Keywords', h('div', { class: 'tags' }, arr(br.keywords).map((k) => h('span', { class: 'tag', text: str(k) }))));
  const offers = arr(br.offerings);
  const offerBox = offers.length ? h('div', {},
    h('div', { class: 'sub-h' }, 'Offerings', br.offeringsConfirmed ? h('span', { class: 'label-ok', text: 'From their own site' }) : h('span', { class: 'label-warn', text: 'Preview — owner to confirm' })),
    offers.map((o) => h('div', { class: 'offer' }, h('div', {}, h('b', { text: str(o.name) }), o.description ? h('p', { text: str(o.description) }) : null), o.price && br.offeringsConfirmed ? h('span', { text: str(o.price) }) : null))) : null;
  const signals = arr(br.sourceSignals);
  return section('Brand kit', 'Archivist · extracted, not invented', palette, type, kv, offerBox,
    signals.length ? h('div', {}, h('div', { class: 'sub-h' }, 'What we actually read', h('span', { text: `${signals.length} signals` })), h('ul', { class: 'signals' }, signals.map((s) => h('li', { text: str(s) })))) : null);
}
function pitchSection(b) {
  if (!b.pitch) {
    return section('The pitch', 'Closer', h('p', { class: 'ds__note', text: BUILT.has(b.status) ? 'No pitch on file yet.' : 'The Closer writes an honest, specific pitch once the site clears the taste gate.' }),
      BUILT.has(b.status) ? h('div', { class: 'ds__row' }, btn('Write pitch', { kind: 'signal', size: '', ic: 'mail', busyKey: `pitch:${b.id}`, onClick: () => actPitch(b.id) })) : null);
  }
  const email = safeEmail(b.email);
  const subject = str(b.pitch.subject), body = str(b.pitch.body);
  const mailto = `mailto:${email || ''}?subject=${enc(subject)}&body=${enc(body)}`;
  return section('The pitch', 'Closer · honest, no invented facts',
    h('div', { class: 'mail' },
      h('div', { class: 'mail__row' }, h('span', { text: 'To' }), email ? h('span', { text: email }) : h('span', {}, h('em', { text: 'No public email found — add a recipient in your mail app' }))),
      h('div', { class: 'mail__row' }, h('span', { text: 'Subject' }), h('span', { text: subject })),
      h('div', { class: 'mail__body', text: body })),
    h('div', { class: 'ds__row' },
      btn('Copy pitch', { ic: 'copy', size: '', onClick: () => copyText(`Subject: ${subject}\n\n${body}`, 'Pitch copied') }),
      btn(email ? `Email ${email}` : 'Open in mail', { ic: 'mail', size: '', href: mailto }),
      btn('Regenerate', { ic: 'refresh', size: '', kind: 'ghost', busyKey: `pitch:${b.id}`, onClick: () => actPitch(b.id) })));
}
function checkoutSection(b) {
  const url = safeHref(b.paymentUrl);
  const test = url && /\/test_/.test(url);
  const kids = [];
  if (b.status === 'paid') {
    kids.push(h('div', { class: 'paid-banner' }, h('b', { text: b.amountCents ? fmtUSD(b.amountCents) : 'Paid' }),
      h('span', { text: `${b.paidAt ? `Paid ${fmtDate(b.paidAt)} · ` : ''}${b.paymentVerified ? 'verified with the Stripe API' : 'unverified — recorded from the Stripe redirect (no secret key configured)'}` })));
  }
  if (url) {
    kids.push(h('div', { class: 'urlbox' }, icon('card'), h('span', { text: url })));
    kids.push(h('div', { class: 'ds__row' },
      btn('Copy checkout link', { ic: 'copy', size: '', onClick: () => copyText(url, 'Checkout link copied') }),
      btn('Open checkout', { ic: 'ext', size: '', kind: 'ghost', href: url, target: '_blank' }),
      test ? h('span', { class: 'label-warn', tabindex: '0', style: { alignSelf: 'center' }, 'data-tip': 'Stripe test mode: use card 4242 4242 4242 4242, any future expiry, any CVC.' }, 'Test mode') : null));
  } else {
    kids.push(h('p', { class: 'ds__note', text: 'The Closer attaches a Stripe checkout (the $49 Launch Pack) when the site ships.' }));
  }
  return section('Checkout', 'Stripe · Launch Pack', ...kids);
}
function videoSection(b) {
  const v = b.video || { status: 'none' };
  const hf = !!(S.config && S.config.integrations && S.config.integrations.higgsfield);
  const built = BUILT.has(b.status);
  const kids = [];
  const vurl = safeHref(v.url);
  if (v.status === 'ready' && vurl) {
    const isFile = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(vurl) || v.provider === 'higgsfield';
    if (isFile) kids.push(h('div', { class: 'video' }, h('video', { src: vurl, controls: true, playsinline: true, preload: 'metadata', muted: true, loop: true })));
    kids.push(h('div', { class: 'ds__row', style: { marginTop: isFile ? '0' : '0' } }, btn('Open video', { ic: 'ext', size: '', kind: 'ghost', href: vurl, target: '_blank' }), h('span', { class: 'ds__note', style: { alignSelf: 'center' }, text: `via ${v.provider === 'external' ? 'external upload' : str(v.provider) || 'video provider'}` })));
  } else if (v.status === 'rendering') {
    kids.push(h('div', { class: 'vstate' }, h('span', { class: 'spinner', style: { color: 'var(--director)' } }), `Higgsfield is rendering the ad${v.jobId ? ` · job ${str(v.jobId).slice(0, 12)}` : ''}…`));
  } else if (v.status === 'error') {
    kids.push(h('div', { class: 'vstate vstate--err', text: `Video failed: ${str(v.error) || 'unknown error'}` }));
  } else {
    kids.push(h('p', { class: 'ds__note', text: 'No ad yet. Generate a short vertical ad with Higgsfield, or attach one you rendered elsewhere.' }));
  }
  const genTip = !hf ? 'Add HIGGSFIELD_API_KEY (and secret) to enable Higgsfield video ads.' : !built ? 'Build the site first — the ad is directed from its hero and brand kit.' : v.status === 'rendering' ? 'Already rendering.' : 'Direct a short vertical ad from the hero frame and brand kit.';
  const genWrap = btn('Generate ad (Higgsfield)', { ic: 'video', size: '', kind: hf && built ? 'signal' : '', disabled: !hf || !built || v.status === 'rendering', tip: genTip, busyKey: `video:${b.id}`, onClick: () => actVideo(b.id) });
  const input = h('input', { class: 'input', id: 'video-url', type: 'url', inputmode: 'url', placeholder: 'https://… paste a rendered ad URL', 'aria-label': 'Video URL to attach', autocomplete: 'off', spellcheck: 'false' });
  input.value = videoDraft.get(b.id) || '';
  input.addEventListener('input', () => { videoDraft.set(b.id, input.value); input.classList.remove('is-invalid'); });
  const attach = btn('Attach video URL', { ic: 'link', size: '', busyKey: `videourl:${b.id}`, onClick: () => actVideoUrl(b.id, input.value, input) });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); attach.click(); } });
  return section('Ad video', 'Director', ...kids, h('div', { class: 'ds__row' }, genWrap), h('div', { class: 'field' }, input, attach));
}
function timingSection(b) {
  const t = b.timings || {};
  const vals = TIMING_KEYS.map(([k]) => Number(t[k])).filter(Number.isFinite);
  if (!vals.length && t.total == null) {
    return section('Build timings', 'per agent', h('p', { class: 'ds__note', text: FLIGHT.has(b.status) ? 'Clocks are running — timings land when the Closer finishes.' : 'Timings appear after the first build.' }),
      Number(b.costCents) > 0 ? h('p', { class: 'ds__note', text: `Model + image spend so far: ${fmtSpend(b.costCents)}` }) : null);
  }
  const max = Math.max(1, ...vals);
  const bars = h('div', { class: 'tbars' });
  for (const [k, name] of TIMING_KEYS) {
    const v = Number(t[k]);
    if (!Number.isFinite(v)) continue;
    bars.append(h('div', { class: 'tbar', style: { '--c': AGENTS[name].color } }, monoEl(name, 'sm'), h('span', { class: 'tbar__name', text: name }), h('div', { class: 'tbar__track' }, h('div', { class: 'tbar__fill', 'data-w': `${Math.max(2, (v / max) * 100)}%` })), h('span', { class: 'tbar__ms', text: fmtDur(v) })));
  }
  if (t.total != null) bars.append(h('div', { class: 'tbar tbar--total' }, h('span'), h('span', { class: 'tbar__name', text: 'Total' }), h('span'), h('span', { class: 'tbar__ms', text: fmtDur(t.total) })));
  return section('Build timings', `model + image spend ${fmtSpend(Number(b.costCents) || 0)}`, bars);
}
function logSection(b) {
  const evs = S.events.filter((e) => e.bizId === b.id).slice(-14);
  if (!evs.length) return null;
  return section('Agent log', `${evs.length} latest`, h('ol', { class: 'log' }, evs.map((e) => h('li', {}, monoEl(e.agent, 'sm'), h('span', { text: str(e.text) }), h('time', { text: fmtTime(e.ts) })))));
}
function factsSection(b) {
  const dl = h('dl', { class: 'facts' });
  const row = (k, v) => { if (v) dl.append(h('dt', { text: k }), h('dd', {}, v)); };
  const web = safeHref(b.website);
  row('Website', web ? h('a', { href: web, target: '_blank', rel: 'noopener noreferrer', text: web }) : 'None on file');
  if (b.phone) row('Phone', h('a', { href: `tel:${str(b.phone).replace(/[^+\d]/g, '')}`, text: str(b.phone) }));
  const em = safeEmail(b.email);
  if (em) row('Email', h('a', { href: `mailto:${em}`, text: em }));
  row('Hours', str(b.openingHours) || 'Unknown — owner to confirm');
  row('Address', str(b.address) || '—');
  if (hasGeo(b)) row('Location', `${b.lat.toFixed(5)}, ${b.lon.toFixed(5)}${fmtDist(distanceM(b)) ? ` · ${fmtDist(distanceM(b))}` : ''}`);
  const osm = str(b.osmId);
  if (osm) {
    const m = osm.match(/^(node|way|relation)[/:]?(\d+)$/);
    row('OpenStreetMap', m ? h('a', { href: `https://www.openstreetmap.org/${m[1]}/${m[2]}`, target: '_blank', rel: 'noopener noreferrer', text: osm }) : osm);
  }
  const tags = Object.entries(b.osmTags || {}).filter(([k]) => /^(amenity|shop|cuisine|craft|leisure|tourism|diet:|opening_hours$)/.test(k)).slice(0, 8);
  if (tags.length) row('OSM tags', h('div', { class: 'tags' }, tags.map(([k, v]) => h('span', { class: 'tag', text: `${k}=${str(v)}` }))));
  row('Added', fmtDate(b.createdAt));
  row('Updated', fmtDate(b.updatedAt));
  row('ID', b.id);
  return section('Source facts', 'what HQ knows', dl);
}
function dangerSection(b) {
  return h('section', { class: 'ds' }, h('div', { class: 'danger-zone' },
    h('div', {}, h('b', { text: 'Remove this preview' }), h('p', { text: 'Owners can ask at any time. The site switches to a removal notice immediately.' })),
    btn('Remove preview', { kind: 'danger', size: '', ic: 'trash', busyKey: `remove:${b.id}`, onClick: () => actRemove(b.id) })));
}

// ─────────────────────────────────────────────────────────── live challenge
const CH = { phase: 'idle', ui: {} };
function chReset() {
  cancelAnimationFrame(CH.raf || 0);
  Object.assign(CH, {
    phase: 'form', bizId: null, name: '', t0: 0, tEnd: 0, startedAt: 0,
    acc: Object.fromEntries(SPLITS.map((a) => [a, 0])), active: null, activeSince: 0, seen: new Set(),
    sawProgress: false, fromBlock: false, pb: null, error: null, total: 0, newPB: false, final: null, raf: 0, ui: {}, scoresKey: '',
  });
}
chReset();
function openChallenge() {
  closeMenu();
  const el = $('#challenge');
  const wasHidden = el.hidden;
  if (wasHidden) S.lastFocusCh = document.activeElement;
  el.hidden = false;
  syncInert();
  if (CH.phase === 'form' || CH.phase === 'idle') chRenderForm();
  else if (wasHidden) chRenderRun();
  if (CH.phase === 'running' && !CH.raf) CH.raf = requestAnimationFrame(chTick);
}
function closeChallenge() {
  const el = $('#challenge');
  if (el.hidden) return;
  el.hidden = true;
  syncInert();
  cancelAnimationFrame(CH.raf || 0); CH.raf = 0;
  if (CH.phase === 'running') toast({ kind: 'info', title: 'Challenge keeps running', text: COARSE ? 'Tap Live to jump back to the timer.' : 'Press L (or Live challenge) to jump back to the timer.', timeout: 2600 });
  if (S.lastFocusCh && S.lastFocusCh.isConnected) S.lastFocusCh.focus({ preventScroll: true });
}
function chHead() {
  const pb = statsNow().bestBuildMs;
  const x = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close live challenge' }, icon('close'));
  x.addEventListener('click', closeChallenge);
  return h('div', { class: 'ch-head' },
    h('div', { class: 'kicker', id: 'ch-title' }, h('span', { class: 'kdot kdot--live' }), 'Live challenge · Speedrun'),
    h('div', { class: 'ch-head__right' }, pb != null ? h('span', { class: 'ch-pb' }, 'Best build', h('b', { text: fmtDur(pb) })) : null, x));
}
function chRenderForm() {
  const panel = $('#challenge-panel');
  panel.textContent = '';
  const name = h('input', { class: 'input input--lg', id: 'ch-name', type: 'text', placeholder: innerWidth < 760 ? 'Business name' : 'Business name, e.g. the café across the street', maxlength: '90', autocomplete: 'off', required: true, 'aria-label': 'Business name' });
  const web = h('input', { class: 'input input--lg', id: 'ch-web', type: 'url', inputmode: 'url', placeholder: 'Website (optional)', autocomplete: 'off', 'aria-label': 'Website (optional)' });
  const go = btn('Start the clock', { kind: 'signal', size: 'lg', ic: 'play' });
  const form = h('form', { class: 'ch-inputs', novalidate: true }, name, web, go);
  go.type = 'submit';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const n = name.value.trim();
    if (!n) { name.classList.add('is-invalid'); name.focus(); toast({ kind: 'warn', title: 'Name a business first', text: 'Anything on the block — the audience can shout one out.' }); return; }
    const raw = web.value.trim();
    const w = raw ? normalizeHttpUrl(raw) : null;
    if (raw && !w) { web.classList.add('is-invalid'); web.focus(); toast({ kind: 'warn', title: 'That website does not look right', text: 'Try something like redwoodcafe.com — or leave it empty and the Scout will look it up.' }); return; }
    chStart({ name: n, website: w || undefined });
  });
  name.addEventListener('input', () => name.classList.remove('is-invalid'));
  web.addEventListener('input', () => web.classList.remove('is-invalid'));
  const picks = h('div', { class: 'ch-picks', id: 'ch-picks' });
  panel.append(chHead(), h('div', { class: 'ch-form' },
    h('h2', {}, 'Name a business. ', h('em', { text: 'Start the clock.' })),
    h('p', { class: 'lead', text: 'Six agents race to scout it, read its brand, build a site, pass the taste gate, direct a hero shot and attach a checkout. Every split is real — timed live from HQ events.' }),
    form, picks,
    h('div', { class: 'ch-hint', text: 'Enter to start · Esc to close · the pipeline keeps running if you close this window' })));
  chRenderPicks();
  setTimeout(() => name.focus(), 40);
}
function chRenderPicks() {
  const wrap = $('#ch-picks');
  if (!wrap) return;
  wrap.textContent = '';
  const list = [...S.biz.values()].filter((b) => b.status === 'scouted' || b.status === 'error').sort((a, b) => (distanceM(a) ?? 1e9) - (distanceM(b) ?? 1e9)).slice(0, 8);
  if (!list.length) return;
  const row = h('div', { class: 'ch-picks__row' });
  for (const b of list) {
    const p = h('button', { class: 'pick', type: 'button', title: fmtDist(distanceM(b)) || '' }, b.name);
    p.addEventListener('click', () => chStart({ existingId: b.id }));
    row.append(p);
  }
  wrap.append(h('div', { class: 'ch-picks__label', text: 'Or pick one the Scout already found' }), row);
}
async function chStart({ name, website, existingId }) {
  chReset();
  CH.phase = 'running';
  CH.t0 = performance.now();
  CH.startedAt = Date.now();
  CH.pb = statsNow().bestBuildMs;
  CH.active = 'Scout';
  CH.activeSince = CH.t0;
  CH.seen.add('Scout');
  const existing = existingId ? S.biz.get(existingId) : null;
  CH.name = existing ? existing.name : name;
  CH.fromBlock = !!existing;
  chRenderRun();
  CH.raf = requestAnimationFrame(chTick);
  try {
    let biz = existing;
    if (!biz) {
      biz = normalizeBiz(await api('POST', '/api/businesses', { name, ...(website ? { website } : {}) }, { timeout: 45000 }));
      if (!biz) throw new Error('HQ did not return the new business.');
      upsertBusiness(biz);
    }
    CH.bizId = biz.id;
    CH.name = biz.name;
    chSwitch('Archivist');
    chRenderRun();
    await api('POST', `/api/businesses/${enc(biz.id)}/build`, {});
    const cur = S.biz.get(biz.id);
    if (cur) chOnBusiness(cur);
  } catch (e) {
    chFail(e.message || String(e));
  }
}
function chSwitch(agent) {
  if (CH.phase !== 'running' || !agent || agent === CH.active) return;
  const now = performance.now();
  if (CH.active) CH.acc[CH.active] += now - CH.activeSince;
  CH.active = agent;
  CH.activeSince = now;
  CH.seen.add(agent);
  chUpdate();
}
function chOnBusiness(b) {
  if (CH.phase === 'error' && b.id === CH.bizId && FLIGHT.has(b.status)) {
    // HQ resumed the build itself (e.g. after a restart) — pick the clock back up instead of leaving the modal on "Stopped".
    CH.phase = 'running'; CH.error = null; CH.tEnd = 0; CH.sawProgress = true;
    CH.active = STATUS_AGENT[b.status] || 'Archivist'; CH.activeSince = performance.now();
    chRenderRun();
    if (!$('#challenge').hidden && !CH.raf) CH.raf = requestAnimationFrame(chTick);
    return;
  }
  if (CH.phase !== 'running' || b.id !== CH.bizId) { if (CH.bizId === b.id) chUpdate(); return; }
  if (FLIGHT.has(b.status)) {
    CH.sawProgress = true;
    const ag = STATUS_AGENT[b.status];
    if (!(ag === 'Director' && CH.active === 'Closer')) chSwitch(ag);
  } else if (BUILT.has(b.status) && (CH.sawProgress || (b.updatedAt || 0) >= CH.startedAt - 1500)) {
    chFinish(b);
    return;
  } else if (b.status === 'error' && (CH.sawProgress || (b.updatedAt || 0) >= CH.startedAt - 1500)) {
    chFail(b.error || 'The pipeline reported an error.');
    return;
  }
  chUpdate();
}
const NON_PIPELINE_STAGES = new Set(['view', 'checkout', 'video', 'block']);
function chOnEvent(e) {
  const stage = e.data && typeof e.data.stage === 'string' ? e.data.stage : '';
  if (CH.phase === 'running' && e.bizId === CH.bizId && SPLITS.includes(e.agent) && e.agent !== 'Scout' && !NON_PIPELINE_STAGES.has(stage)) {
    CH.sawProgress = true;
    chSwitch(e.agent);
  }
  chUpdate();
}
function chFinish(b) {
  const now = performance.now();
  if (CH.active) CH.acc[CH.active] += now - CH.activeSince;
  CH.active = null;
  CH.tEnd = now;
  CH.total = now - CH.t0;
  CH.phase = 'done';
  CH.final = b;
  for (const a of SPLITS) CH.seen.add(a);
  CH.newPB = CH.pb == null || CH.total < CH.pb;
  cancelAnimationFrame(CH.raf || 0); CH.raf = 0;
  chRenderRun();
  chime('done');
  if (!$('#challenge').hidden) {
    // launch from the lower corners so the paper never covers the finishing time
    const colors = [cssVar('--money', '#3DDC84'), cssVar('--signal', '#FF5B1F'), cssVar('--text', '#F4F1EA'), cssVar('--warn', '#FFC247')];
    confetti({ x: innerWidth * 0.08, y: innerHeight - 10, count: 70, colors, spread: 0.55, tilt: 0.45 });
    confetti({ x: innerWidth * 0.92, y: innerHeight - 10, count: 70, colors, spread: 0.55, tilt: -0.45 });
  } else {
    toast({ kind: 'success', title: `${b.name} shipped in ${fmtSplit(CH.total)}`, text: COARSE ? 'Tap Live to see the splits and the QR code.' : 'Press L to see the splits and the QR code.' });
  }
}
function chFail(msg) {
  if (CH.phase !== 'running') return;
  const now = performance.now();
  if (CH.active) CH.acc[CH.active] += now - CH.activeSince;
  CH.tEnd = now;
  CH.total = now - CH.t0;
  CH.phase = 'error';
  CH.error = msg;
  cancelAnimationFrame(CH.raf || 0); CH.raf = 0;
  chRenderRun();
}
function chSplitMs(agent) {
  if (agent === 'Scout' && CH.fromBlock) return null;
  const b = CH.final;
  const key = agent.toLowerCase();
  if (CH.phase === 'done' && b && b.timings && Number.isFinite(Number(b.timings[key])) && Number(b.timings[key]) > 0) return Number(b.timings[key]);
  let v = CH.acc[agent] || 0;
  if (CH.phase === 'running' && CH.active === agent) v += performance.now() - CH.activeSince;
  return v;
}
function chSplitState(agent) {
  if (CH.phase === 'done') return 'done';
  if (CH.phase === 'running' && CH.active === agent) return 'active';
  if (CH.seen.has(agent)) return 'done';
  return 'pending';
}
function chRenderRun() {
  const panel = $('#challenge-panel');
  if (!panel) return;
  panel.textContent = '';
  const b = CH.bizId ? S.biz.get(CH.bizId) : null;
  const timer = h('div', { class: `ch-timer ${CH.phase === 'done' ? 'is-done' : CH.phase === 'error' ? 'is-error' : ''}`, id: 'ch-timer', 'aria-live': 'off' });
  const timerMain = document.createTextNode('00:00');
  const timerCs = h('span', { class: 'cs', text: '.00' });
  timer.append(timerMain, timerCs);
  const segs = h('div', { class: 'ch-segs', 'aria-hidden': 'true' });
  const splits = h('ol', { class: 'splits' });
  const splitRefs = {};
  for (const a of SPLITS) {
    const seg = h('div', { class: 'ch-seg', style: { '--c': AGENTS[a].color } });
    segs.append(seg);
    const time = h('span', { class: 'split__time', text: '—' });
    const sub = h('small', { text: AGENTS[a].role });
    const li = h('li', { class: 'split', style: { '--c': AGENTS[a].color } }, monoEl(a), h('div', { class: 'split__name' }, a, sub), time, h('span', { class: 'split__state', 'aria-hidden': 'true' }));
    splits.append(li);
    splitRefs[a] = { li, seg, time, sub };
  }
  const ticker = h('div', { class: 'ch-ticker', 'aria-live': 'polite' });
  const stage = { k: h('div', { class: 'ch-stage__k' }), v: h('div', { class: 'ch-stage__v' }), s: h('div', { class: 'ch-stage__s' }) };
  stage.el = h('div', { class: 'ch-stage', 'aria-live': 'polite' }, stage.k, stage.v, stage.s);
  const chart = h('div');
  const note = h('div');
  const result = h('div');
  const cat = b ? [b.category ? catLabel(b.category) : '', str(b.address)].filter(Boolean).join(' · ') : CH.fromBlock ? 'from the block' : 'looking it up…';
  let status = null;
  if (CH.phase === 'done') status = CH.newPB && CH.pb != null ? h('span', { class: 'shipped shipped--pb', text: '★ New best build' }) : h('span', { class: 'shipped', text: 'Shipped' });
  else if (CH.phase === 'error') status = h('span', { class: 'shipped shipped--err', text: 'Stopped' });
  panel.append(chHead(), h('div', { class: 'ch-run' },
    h('div', { class: 'ch-biz' }, h('div', { style: { minWidth: '0' } }, h('h2', { text: CH.name || 'New business' }), h('span', { text: cat })), status),
    h('div', { class: 'ch-timer-row' }, timer, stage.el), segs,
    h('div', { class: 'ch-grid' },
      h('div', { class: 'ch-box' }, h('div', { class: 'ch-box__title' }, 'Splits', h('span', { text: 'live from HQ events' })), splits, ticker),
      h('div', { style: { display: 'flex', flexDirection: 'column', gap: '16px', minWidth: '0' } },
        h('div', { class: 'ch-box' }, h('div', { class: 'ch-box__title' }, 'Taste gate', h('span', { text: `pass ≥ ${PASS}` })), chart, note),
        h('div', { class: 'ch-box' }, h('div', { class: 'ch-box__title' }, CH.phase === 'done' ? 'Scan it — it is live' : CH.phase === 'error' ? 'What happened' : 'Ships when it clears the gate'), result))),
    h('div', { class: 'ch-foot' },
      h('span', { class: 'ds__note', text: CH.phase === 'running' ? 'Closing this window keeps the clock running.' : '' }),
      h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        b ? btn('Details', { size: '', kind: 'ghost', onClick: () => { closeChallenge(); openDrawer(b.id); } }) : null,
        CH.phase !== 'running' ? btn('New challenge', { size: '', kind: 'signal', ic: 'play', onClick: () => { chReset(); chRenderForm(); } }) : null))));
  CH.ui = { timer, timerMain, timerCs, splitRefs, ticker, chart, note, result, stage };
  CH.scoresKey = '';
  chUpdate();
  chPaintTimer();
}
function chPaintTimer() {
  const u = CH.ui;
  if (!u.timerMain) return;
  const ms = CH.phase === 'running' ? performance.now() - CH.t0 : CH.total;
  const [a, c] = fmtTimer(ms);
  u.timerMain.nodeValue = a;
  u.timerCs.textContent = '.' + c;
  if (CH.phase === 'running' && CH.active && u.splitRefs[CH.active]) u.splitRefs[CH.active].time.textContent = fmtSplit(chSplitMs(CH.active));
}
function chTick() {
  if (CH.phase !== 'running' || $('#challenge').hidden) { CH.raf = 0; return; }
  chPaintTimer();
  CH.raf = requestAnimationFrame(chTick);
}
function chUpdate() {
  const u = CH.ui;
  if (!u.splitRefs || $('#challenge').hidden) return;
  for (const a of SPLITS) {
    const r = u.splitRefs[a];
    const st = chSplitState(a);
    r.li.className = `split ${st === 'active' ? 'is-active' : st === 'done' ? 'is-done' : ''}`;
    r.seg.className = `ch-seg ${st === 'active' ? 'is-active' : st === 'done' ? 'is-done' : ''}`;
    if (a === 'Scout' && CH.fromBlock) { r.time.textContent = 'found'; r.sub.textContent = 'already on the block'; continue; }
    r.time.textContent = st === 'pending' ? '—' : fmtSplit(chSplitMs(a));
  }
  const b = CH.bizId ? S.biz.get(CH.bizId) : null;
  const chScores = b ? b.scores.filter((s) => !s.at || s.at >= CH.startedAt - 30000) : [];
  // stage block: who is on the clock / delta vs best
  const st = u.stage;
  if (CH.phase === 'running') {
    const a = CH.active || 'Scout';
    st.el.style.setProperty('--c', AGENTS[a].color);
    st.k.textContent = 'On the clock';
    st.v.className = 'ch-stage__v';
    st.v.textContent = a;
    st.s.textContent = a === 'Builder' ? `composing v${chScores.length + 1}` : a === 'Critic' ? `scoring v${chScores.length + 1} · gate ${PASS}` : AGENTS[a].role.toLowerCase();
  } else if (CH.phase === 'done') {
    st.v.className = 'ch-stage__v is-mono';
    if (CH.pb != null && CH.total - CH.pb <= 0) {
      st.el.style.setProperty('--c', 'var(--money-ink)');
      st.k.textContent = 'New best · vs previous';
      st.v.textContent = `−${(Math.abs(CH.total - CH.pb) / 1000).toFixed(2)}s`;
    } else if (CH.pb != null) {
      // slower than the record is still a shipped site: lead with the result, keep the record as context
      st.el.style.setProperty('--c', 'var(--money-ink)');
      st.k.textContent = `Shipped · best ${fmtDur(CH.pb)}`;
      st.v.className = 'ch-stage__v';
      st.v.textContent = 'Live';
    } else {
      st.el.style.setProperty('--c', 'var(--money)');
      st.k.textContent = 'First build';
      st.v.textContent = 'Shipped';
    }
    const shipped = b ? lastScore(b) : null;
    const fin = shipped ? shipped.score : (chScores.length ? chScores[chScores.length - 1].score : null);
    st.s.textContent = [fin != null ? `taste ${Math.round(fin)}` : null, chScores.length ? `${chScores.length} ${chScores.length === 1 ? 'pass' : 'passes'}` : null, b && b.timings && b.timings.total != null ? `HQ ${fmtDur(b.timings.total)}` : null].filter(Boolean).join(' · ');
  } else if (CH.phase === 'error') {
    st.el.style.setProperty('--c', 'var(--error)');
    st.k.textContent = 'Stopped during';
    st.v.className = 'ch-stage__v';
    st.v.textContent = CH.active || 'Scout';
    st.s.textContent = 'see below';
  }
  // ticker: latest report for this business
  const le = b ? lastEventFor(b.id) : null;
  u.ticker.textContent = '';
  if (le && (le.ts || 0) >= CH.startedAt - 30000) u.ticker.append(monoEl(le.agent), h('p', {}, h('b', { text: `${le.agent} ` }), str(le.text)));
  else u.ticker.append(monoEl(CH.active || 'Scout'), h('p', { text: CH.bizId ? 'Waiting for the first report…' : `Scout is looking up “${CH.name}”…` }));
  // scores
  const scores = chScores;
  const key = scores.map((s) => `${s.version}:${s.score}`).join(',');
  if (key !== CH.scoresKey) {
    CH.scoresKey = key;
    u.chart.textContent = '';
    u.note.textContent = '';
    if (scores.length) {
      u.chart.append(barsChart(scores, { small: true }));
      requestAnimationFrame(() => { for (const f of $$('.bar__fill[data-h]', u.chart)) f.style.height = f.dataset.h; });
      const n = arr(scores[scores.length - 1].notes)[0];
      if (n) u.note.append(h('div', { class: 'ch-note', text: str(n) }));
    } else {
      u.chart.append(h('div', { class: 'ch-waiting', text: 'v1 → v2 → v3 · the Critic scores each version; the Builder revises from its notes.' }));
    }
  }
  // result box
  u.result.textContent = '';
  if (CH.phase === 'done' && b) {
    const abs = siteAbs(b);
    const qr = qrImg(abs, 160);
    qr.removeAttribute('style');
    u.result.append(h('div', { class: 'ch-result' }, qr, h('div', { class: 'ch-result__actions' },
      h('div', { class: 'ch-result__url', text: abs }),
      btn('Open site', { kind: 'money', size: 'lg', ic: 'ext', href: sitePath(b), target: '_blank' }),
      btn('Copy link', { size: '', ic: 'copy', onClick: () => copyText(abs, 'Site link copied') }),
      b.timings && b.timings.total != null ? h('div', { class: 'ds__note', text: `Pipeline ${fmtDur(b.timings.total)} on HQ · wall clock ${fmtSplit(CH.total)}${CH.pb != null ? ` · previous best ${fmtDur(CH.pb)}` : ''}` }) : null)));
  } else if (CH.phase === 'error') {
    u.result.append(h('div', { class: 'vstate vstate--err', text: CH.error || 'Something went wrong.' }),
      h('div', { class: 'ds__row' }, b ? btn('Retry this business', { kind: 'signal', size: '', ic: 'refresh', onClick: () => chStart({ existingId: b.id }) }) : null, btn('Try another name', { size: '', kind: 'ghost', onClick: () => { chReset(); chRenderForm(); } })));
  } else {
    const hasHero = b && safeHref(b.heroImage);
    u.result.append(h('div', { class: 'ch-waiting', style: { textAlign: 'left', padding: '4px 0' }, text: hasHero ? 'Hero frame is in. The Closer is writing the pitch and attaching checkout…' : `The site ships the moment the Critic clears ${PASS}, the Director lands a hero frame and the Closer attaches checkout. QR code appears here.` }));
  }
}

// ─────────────────────────────────────────────────────────── dialogs
function openDialog(build) {
  const d = $('#dialog'), p = $('#dialog-panel');
  if (S.dialog) S.dialog.close(null);
  const prevFocus = document.activeElement;
  p.textContent = '';
  d.hidden = false;
  return new Promise((resolve) => {
    const close = (v) => { if (S.dialog !== ctl) return; S.dialog = null; d.hidden = true; p.textContent = ''; d.removeAttribute('aria-label'); syncInert(); if (prevFocus && prevFocus.isConnected) prevFocus.focus({ preventScroll: true }); resolve(v); };
    const ctl = { close };
    S.dialog = ctl;
    build(p, close);
    const t = p.querySelector('.dialog__title');
    d.setAttribute('aria-label', p.getAttribute('aria-label') || (t ? t.textContent : 'Dialog'));
    syncInert();
    setTimeout(() => { const f = p.querySelector('[autofocus], input, button.btn--signal, button.btn--danger-solid, button'); if (f) f.focus(); }, 20);
  });
}
$('#dialog').addEventListener('mousedown', (e) => { if (e.target.id === 'dialog' && S.dialog) S.dialog.close(false); });
function confirmDialog({ title, text, confirm = 'Confirm', danger = false }) {
  return openDialog((p, close) => {
    p.setAttribute('aria-label', title);
    p.append(h('h2', { class: 'dialog__title', text: title }), h('p', { class: 'dialog__text', text }),
      h('div', { class: 'dialog__actions' }, btn('Cancel', { kind: 'ghost', size: '', onClick: () => close(false) }), btn(confirm, { kind: danger ? 'danger-solid' : 'signal', size: '', onClick: () => close(true) })));
  });
}
function addBusinessDialog() {
  closeMenu();
  openDialog((p, close) => {
    const name = h('input', { class: 'input', name: 'name', required: true, maxlength: '90', placeholder: 'e.g. the café across the street', autocomplete: 'off', autofocus: true });
    const website = h('input', { class: 'input', name: 'website', type: 'url', inputmode: 'url', placeholder: 'https:// (optional)', autocomplete: 'off' });
    const category = h('input', { class: 'input', name: 'category', placeholder: 'cafe, restaurant, bar, books… (optional)', maxlength: '40', autocomplete: 'off' });
    const address = h('input', { class: 'input', name: 'address', placeholder: 'Street address (optional)', maxlength: '120', autocomplete: 'off' });
    const buildNow = h('input', { type: 'checkbox', checked: true });
    const submit = btn('Add to the block', { kind: 'signal', size: '', ic: 'plus', busyKey: 'add' });
    submit.type = 'submit';
    const form = h('form', { class: 'form', novalidate: true },
      h('label', {}, 'Business name', name), h('label', {}, 'Website', website), h('label', {}, 'Category', category), h('label', {}, 'Address', address),
      h('label', { class: 'check' }, buildNow, 'Build the site right away'),
      h('div', { class: 'dialog__actions' }, btn('Cancel', { kind: 'ghost', size: '', onClick: () => close(false) }), submit));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const n = name.value.trim();
      if (!n) { name.classList.add('is-invalid'); name.focus(); return; }
      const rawW = website.value.trim();
      const w = rawW ? normalizeHttpUrl(rawW) : null;
      if (rawW && !w) { website.classList.add('is-invalid'); website.focus(); toast({ kind: 'warn', title: 'That website does not look right', text: 'Try something like redwoodcafe.com, or leave it empty.' }); return; }
      const body = { name: n };
      if (w) body.website = w;
      if (category.value.trim()) body.category = category.value.trim();
      if (address.value.trim()) body.address = address.value.trim();
      const created = await runAction('add', async () => {
        const b = await api('POST', '/api/businesses', body, { timeout: 45000 });
        if (b && b.id) upsertBusiness(b);
        return b;
      });
      if (!created || !created.id) return;
      close(true);
      toast({ kind: 'success', title: `${created.name || n} added to the block`, text: buildNow.checked ? 'Build started.' : 'Press Build when ready.' });
      if (buildNow.checked) actBuild(created.id);
      setTimeout(() => focusBusiness(created.id), 60);
    });
    name.addEventListener('input', () => name.classList.remove('is-invalid'));
    website.addEventListener('input', () => website.classList.remove('is-invalid'));
    p.append(h('h2', { class: 'dialog__title', text: 'Add a business' }), h('p', { class: 'dialog__text', text: 'Only the name is required — the Scout looks it up on OpenStreetMap within 1.5 km of HQ.' }), form);
  });
}
function qrImg(url, size) {
  const img = h('img', { alt: `QR code for ${url}`, width: String(size), height: String(size), src: `https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=0&data=${enc(url)}` });
  const box = h('div', { class: 'qr', style: { width: `${size + 20}px`, height: `${size + 20}px` } }, img);
  // If the QR service is unreachable, show the address itself big enough to type from the back of the room.
  img.addEventListener('error', () => { box.textContent = ''; box.append(h('div', { class: 'qr__fallback' }, h('b', { text: url.replace(/^https?:\/\//, '') }), 'Type this address')); });
  return box;
}
function qrDialog(b) {
  const abs = siteAbs(b);
  openDialog((p, close) => {
    p.setAttribute('aria-label', `QR code for ${b.name}`);
    p.append(h('h2', { class: 'dialog__title', text: `Scan ${b.name}` }),
      h('p', { class: 'dialog__text', text: 'Point a phone camera here — the concept site opens live (HQ will post the view in #agent-channel).' }),
      h('div', { class: 'qr-dialog' }, qrImg(abs, 260), h('div', { class: 'ch-result__url', text: abs })),
      h('div', { class: 'dialog__actions' },
        btn('Copy link', { ic: 'copy', size: '', onClick: () => copyText(abs, 'Site link copied') }),
        btn('Open site', { kind: 'money', ic: 'ext', size: '', href: sitePath(b), target: '_blank' }),
        btn('Done', { kind: 'ghost', size: '', onClick: () => close(true) })));
  });
}
function shortcutsDialog() {
  closeMenu();
  openDialog((p, close) => {
    const rows = [['L', 'Open the live challenge'], ['S', 'Scout the block'], ['R', 'Run the block (asks first — builds call paid models)'], ['/', 'Search the block'], ['T', 'Switch light / dark (⋯ menu has System)'], ['Esc', 'Close whatever is open'], ['?', 'This list']];
    p.append(h('h2', { class: 'dialog__title', text: 'Keyboard shortcuts' }),
      h('div', { class: 'shortcuts' }, rows.flatMap(([k, t]) => [h('kbd', { text: k }), h('span', { text: t })])),
      h('div', { class: 'dialog__actions' }, btn('Done', { kind: 'signal', size: '', onClick: () => close(true) })));
  });
}

// ─────────────────────────────────────────────────────────── menu
function openMenu() { $('#menu').hidden = false; $('#btn-menu').setAttribute('aria-expanded', 'true'); const f = $('#menu [role=menuitem]'); if (f) f.focus(); }
function closeMenu() { $('#menu').hidden = true; $('#btn-menu').setAttribute('aria-expanded', 'false'); }
$('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); if ($('#menu').hidden) openMenu(); else closeMenu(); });
document.addEventListener('click', (e) => { if (!$('#menu').hidden && !e.target.closest('.menu-wrap')) closeMenu(); });
$('#menu').addEventListener('keydown', (e) => {
  const items = $$('#menu [role=menuitem]');
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
});
$('#menu').addEventListener('click', (e) => {
  const item = e.target.closest('[data-menu]');
  if (!item) { if (e.target.closest('a')) closeMenu(); return; }
  const m = item.dataset.menu;
  if (m === 'add') addBusinessDialog();
  else if (m === 'shortcuts') shortcutsDialog();
  else if (m === 'theme') cycleTheme();
  else if (m === 'reset') actReset();
  else if (m === 'sound') {
    S.sound = !S.sound;
    try { localStorage.setItem('co.sound', S.sound ? 'on' : 'off'); } catch { /* storage unavailable */ }
    $('#sound-state').textContent = S.sound ? 'On' : 'Off';
    if (S.sound) chime('tick');
  }
});

// ─────────────────────────────────────────────────────────── toasts, confetti, sound
function toast({ kind = 'info', title, text, timeout }) {
  const wrap = $('#toasts');
  const t = timeout ?? (kind === 'error' ? 7000 : kind === 'money' ? 8000 : 4200);
  const glyph = { info: 'i', success: '✓', error: '!', warn: '!', money: '$' }[kind] || 'i';
  const x = h('button', { class: 'toast__x', type: 'button', 'aria-label': 'Dismiss' }, '×');
  const el = h('div', { class: `toast toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
    h('span', { class: 'toast__icon', 'aria-hidden': 'true', text: glyph }),
    h('div', { style: { minWidth: '0' } }, h('div', { class: 'toast__title', text: title || '' }), text ? h('div', { class: 'toast__text', text }) : null),
    x, h('span', { class: 'toast__bar', style: { animationDuration: `${t}ms` } }));
  const kill = () => { if (!el.isConnected) return; el.classList.add('is-out'); setTimeout(() => el.remove(), 260); };
  x.addEventListener('click', kill);
  wrap.prepend(el);
  while (wrap.children.length > 5) wrap.lastElementChild.remove();
  setTimeout(kill, t);
  return el;
}
function toastErr(e, title = 'That did not work') {
  toast({ kind: 'error', title, text: (e && e.message) || String(e) });
}
function celebrate(b, ev) {
  if (S.celebrated.has(b.id)) return;
  S.celebrated.add(b.id);
  const amount = Number(b.amountCents) || Number(ev && ev.data && ev.data.amountCents) || 0;
  toast({ kind: 'money', title: amount ? `+${fmtUSD(amount)}` : 'Payment received', text: `${b.name} just claimed their site${b.paymentVerified ? ' · verified by Stripe' : ''}.` });
  chime('money');
  // centre-stage banner (the toast above carries it for screen readers)
  $$('.paid-moment').forEach((x) => x.remove());
  const moment = h('div', { class: 'paid-moment', 'aria-hidden': 'true' },
    h('div', { class: 'paid-moment__k', text: b.paymentVerified ? 'Paid · verified by Stripe' : 'Paid via Stripe' }),
    h('div', { class: 'paid-moment__amt', text: amount ? `+${fmtUSD(amount)}` : 'Paid' }),
    h('div', { class: 'paid-moment__name' }, h('b', { text: b.name }), ' just claimed their site'));
  document.body.append(moment);
  setTimeout(() => moment.classList.add('is-out'), 2800);
  setTimeout(() => moment.remove(), 3300);
  const r = moment.getBoundingClientRect();
  confetti({ x: r.left + r.width / 2, y: r.top + 20, count: 160 });
  const c = S.cards.get(b.id);
  if (c) { c.el.classList.remove('is-focus'); void c.el.offsetWidth; c.el.classList.add('is-focus'); }
  const p = M.pins.get(b.id);
  const pin = p && p.marker.getElement() && p.marker.getElement().querySelector('.pin');
  if (pin) { pin.classList.remove('is-paid-pulse'); void pin.offsetWidth; pin.classList.add('is-paid-pulse'); }
}
let confettiRaf = 0;
const confettiParts = [];
function confetti({ x = innerWidth / 2, y = innerHeight / 3, count = 140, colors, spread = 1.1, tilt = 0 } = {}) {
  if (REDUCED_MOTION) return;
  // canvas needs real colors: read the current theme's tokens
  colors = colors || [cssVar('--money', '#3DDC84'), cssVar('--text', '#F4F1EA'), cssVar('--signal', '#FF5B1F'), cssVar('--cfo', '#7CE0D3')];
  const cv = $('#confetti');
  const dpr = Math.min(2, devicePixelRatio || 1);
  if (cv.width !== innerWidth * dpr) { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; }
  const ctx = cv.getContext('2d');
  for (let i = 0; i < count; i++) {
    const a = -Math.PI / 2 + tilt + (Math.random() - 0.5) * Math.PI * spread;
    const sp = 6 + Math.random() * 9;
    confettiParts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35, w: 5 + Math.random() * 6, h: 3 + Math.random() * 5, c: colors[i % colors.length], life: 0, max: 110 + Math.random() * 60 });
  }
  if (confettiRaf) return;
  const step = () => {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, innerWidth, innerHeight);
    for (let i = confettiParts.length - 1; i >= 0; i--) {
      const p = confettiParts[i];
      p.life++; p.vy += 0.22; p.vx *= 0.985; p.vy *= 0.985; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      const alpha = Math.max(0, 1 - p.life / p.max);
      if (alpha <= 0 || p.y > innerHeight + 30) { confettiParts.splice(i, 1); continue; }
      ctx.save(); ctx.globalAlpha = alpha; ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.life / 8)) + 1); ctx.restore();
    }
    if (confettiParts.length) confettiRaf = requestAnimationFrame(step);
    else { confettiRaf = 0; ctx.clearRect(0, 0, innerWidth, innerHeight); }
  };
  confettiRaf = requestAnimationFrame(step);
}
let actx = null;
let gestured = false; // browsers only allow audio after a user gesture
addEventListener('pointerdown', () => { gestured = true; }, true);
addEventListener('keydown', () => { gestured = true; }, true);
function chime(kind = 'money') {
  if (!S.sound || !gestured) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    if (actx.state === 'suspended') actx.resume();
    const notes = kind === 'money' ? [[987.77, 0], [1318.51, 0.09], [1975.53, 0.18]] : kind === 'done' ? [[659.25, 0], [987.77, 0.1]] : [[1318.51, 0]];
    for (const [f, dt] of notes) {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = f;
      const t0 = actx.currentTime + dt;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.55);
      o.connect(g).connect(actx.destination);
      o.start(t0); o.stop(t0 + 0.6);
    }
  } catch { /* audio unavailable */ }
}

// ─────────────────────────────────────────────────────────── tooltips
// One floating, viewport-clamped tooltip for every [data-tip] (CSS ::after tips get clipped by scroll containers).
const TIP = { el: null, target: null };
function showTip(target) {
  const text = target.dataset.tip;
  if (!text) return;
  if (!TIP.el) { TIP.el = h('div', { class: 'tip', role: 'tooltip', id: 'co-tip', hidden: true }); document.body.append(TIP.el); }
  if (TIP.target && TIP.target !== target) TIP.target.removeAttribute('aria-describedby');
  TIP.target = target;
  TIP.el.textContent = text;
  TIP.el.hidden = false;
  const r = target.getBoundingClientRect();
  const t = TIP.el.getBoundingClientRect();
  const below = (target.dataset.tipPos || '').startsWith('bottom') || r.top < t.height + 16;
  const top = below ? r.bottom + 8 : r.top - t.height - 8;
  const left = Math.max(8, Math.min(innerWidth - t.width - 8, r.left + r.width / 2 - t.width / 2));
  TIP.el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  target.setAttribute('aria-describedby', 'co-tip');
}
function hideTip() {
  if (TIP.el) TIP.el.hidden = true;
  if (TIP.target) TIP.target.removeAttribute('aria-describedby');
  TIP.target = null;
}
document.addEventListener('pointerover', (e) => {
  const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
  if (t) { if (t !== TIP.target) showTip(t); } else if (TIP.target) hideTip();
});
document.addEventListener('focusin', (e) => { const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null; if (t) showTip(t); });
document.addEventListener('focusout', (e) => { if (TIP.target && e.target === TIP.target) hideTip(); });
// only a scroll that actually moves the anchor dismisses the tip (the live feed auto-scrolls constantly)
document.addEventListener('scroll', (e) => {
  if (!TIP.target) return;
  const sc = e.target;
  if (sc === document || sc === document.documentElement || (sc instanceof Element && sc.contains(TIP.target))) hideTip();
}, true);
addEventListener('blur', hideTip);

// ─────────────────────────────────────────────────────────── offline banner
function showOfflineBanner(e) {
  let el = $('#offline');
  if (!el) {
    el = h('div', { class: 'banner-offline', id: 'offline', role: 'alert' });
    document.body.append(el);
  }
  el.textContent = '';
  el.append(h('span', { text: `Can’t reach HQ${e && e.message ? ` — ${e.message}` : ''}. Retrying…` }), btn('Retry now', { size: 'xs', kind: 'ghost', onClick: () => refreshState({ quiet: false }) }));
}
function hideOfflineBanner() { const el = $('#offline'); if (el) el.remove(); }

// ─────────────────────────────────────────────────────────── keyboard + wiring
function isTyping(t) { return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)); }
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (S.dialog) { S.dialog.close(false); return; }
    if (!$('#menu').hidden) { closeMenu(); $('#btn-menu').focus(); return; }
    if (!$('#challenge').hidden) { closeChallenge(); return; }
    if (S.drawerId) { closeDrawer(); return; }
    if (isTyping(e.target)) e.target.blur();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || S.dialog) return;
  const k = e.key.toLowerCase();
  const chOpen = !$('#challenge').hidden;
  if (k === 'l') { e.preventDefault(); openChallenge(); }
  else if (k === 't') { e.preventDefault(); toggleTheme(); }
  else if (k === 's' && !chOpen) { e.preventDefault(); actScout(); }
  else if (k === 'r' && !chOpen) { e.preventDefault(); confirmRunBlock(); }
  else if (k === '/' && !chOpen) { e.preventDefault(); if (S.drawerId) closeDrawer(); $('#search').focus(); }
  else if (e.key === '?') { e.preventDefault(); shortcutsDialog(); }
});
// focus trap for modal layers
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const layer = S.dialog ? $('#dialog-panel') : !$('#challenge').hidden ? $('#challenge-panel') : S.drawerId ? $('#drawer') : null;
  if (!layer) return;
  const f = $$('a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])', layer).filter((el) => el.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!layer.contains(document.activeElement) || document.activeElement === layer) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
});

/** A stray R key must not start paid builds: the keyboard path asks first (the button does not). */
async function confirmRunBlock() {
  const waiting = [...S.biz.values()].filter((b) => b.status === 'scouted').length;
  if (!waiting) { actRunBlock(); return; }
  const n = Math.min(8, waiting);
  const ok = await confirmDialog({ title: 'Run the block?', text: `Build ${n} ${n === 1 ? 'site' : 'sites'} now, three at a time. Each build calls paid models.`, confirm: 'Run the block' });
  if (ok) actRunBlock();
}
/** Only the modal on top is reachable; everything behind it is inert (screen readers included). */
function syncInert() {
  const chOpen = !$('#challenge').hidden;
  $('#app').inert = !!(S.drawerId || chOpen || S.dialog);
  $('#drawer').inert = !!S.dialog;
  $('#challenge').inert = !!S.dialog;
}
/** One polite, throttled announcement for the moments that matter (the feed itself is aria-live="off"). */
const SR = { last: 0, t: 0 };
function announce(text) {
  const now = Date.now();
  if (now - SR.last < 3000) return;
  SR.last = now;
  const el = $('#sr-live');
  if (!el) return;
  el.textContent = '';
  clearTimeout(SR.t);
  SR.t = setTimeout(() => { el.textContent = text.slice(0, 240); }, 40);
}
/** One-line orientation for first-time viewers (judges). Dismissal is remembered on this device. */
function renderIntro() {
  const el = $('#intro');
  if (!el) return;
  let off = false;
  try { off = localStorage.getItem('co.intro') === 'off'; } catch { /* storage unavailable */ }
  el.hidden = off;
  if (off) return;
  el.textContent = '';
  const x = h('button', { class: 'intro__x', type: 'button', 'aria-label': 'Dismiss this note' }, icon('close'));
  x.addEventListener('click', () => { el.hidden = true; try { localStorage.setItem('co.intro', 'off'); } catch { /* storage unavailable */ } });
  el.append(h('span', { class: 'intro__dot', 'aria-hidden': 'true' }),
    h('span', { class: 'intro__text' }, 'Eight agents find real independents around ', h('b', { text: hqShort() }), `, build each one a site, reject anything under ${PASS} on taste, and attach a Stripe checkout. `,
      COARSE ? 'Tap Challenge to race one live.' : ['Press ', h('kbd', { text: 'L' }), ' to race one live.']), x);
}
/** Mobile: one section at a time (Block / Map / Channel). */
function setMtab(tab) {
  $('#floor').dataset.mtab = tab;
  for (const b of $$('#mtabs .mtab')) b.setAttribute('aria-pressed', String(b.dataset.mtab === tab));
  // the map was display:none when it first fitted its pins, so fit once more the first time it is shown
  if (tab === 'map' && M.map) setTimeout(() => { M.map.invalidateSize(); if (!M.shownOnce) { M.shownOnce = true; fitMap(); } }, 30);
  if (tab === 'channel') { const f = $('#feed'); f.scrollTop = f.scrollHeight; }
}
function updateMtabs() {
  const g = $('#mtab-grid'), m = $('#mtab-map'), c = $('#mtab-channel');
  if (!g) return;
  g.textContent = String(S.biz.size);
  m.textContent = String(M.pins.size);
  c.textContent = fmtInt(S.events.length);
}
/** Horizontal strips (pills, filters, agent chips) fade at an edge that has more to scroll. */
function edgeFade(el) {
  if (!el) return;
  const upd = () => {
    const max = el.scrollWidth - el.clientWidth;
    el.classList.toggle('fade-r', max > 2 && el.scrollLeft < max - 2);
    el.classList.toggle('fade-l', max > 2 && el.scrollLeft > 2);
  };
  el.addEventListener('scroll', upd, { passive: true });
  try { new ResizeObserver(upd).observe(el); new MutationObserver(upd).observe(el, { childList: true, subtree: true }); } catch { /* old browser */ }
  upd();
}

function wire() {
  const scoutBtn = $('#btn-scout'), runBtn = $('#btn-run');
  scoutBtn.dataset.busyKey = 'scout';
  runBtn.dataset.busyKey = 'run';
  scoutBtn.addEventListener('click', () => actScout());
  runBtn.addEventListener('click', () => actRunBlock());
  $('#btn-live').addEventListener('click', () => openChallenge());
  $('#btn-theme').addEventListener('click', () => toggleTheme());
  for (const b of $$('#mtabs .mtab')) b.addEventListener('click', () => setMtab(b.dataset.mtab));
  // flush re-orders that waited while the pointer / focus was on a card
  $('#grid').addEventListener('pointerleave', () => { if (S.gridDirty) layoutGrid({ force: true }); });
  $('#grid').addEventListener('focusout', () => setTimeout(() => { if (S.gridDirty && !$('#grid').contains(document.activeElement)) layoutGrid(); }, 0));
  for (const id of ['#pills', '#grid-filters', '#feed-filters']) edgeFade($(id));
  $('#drawer-scrim').addEventListener('click', closeDrawer);
  $('#challenge').addEventListener('mousedown', (e) => { if (e.target.id === 'challenge') closeChallenge(); });
  const radius = $('#radius');
  radius.value = String(S.radius);
  radius.addEventListener('change', () => {
    S.radius = Number(radius.value) || 450;
    try { localStorage.setItem('co.radius', String(S.radius)); } catch { /* storage unavailable */ }
    if (M.circle) M.circle.setRadius(S.radius);
    if (M.map && M.circle) M.map.fitBounds(M.circle.getBounds(), { padding: [20, 20], animate: !REDUCED_MOTION });
    $('#map-sub').textContent = `· ${S.radius >= 1000 ? `${S.radius / 1000} km` : `${S.radius} m`} scout radius`;
    if (!S.biz.size) renderEmpty(0);
  });
  $('#map-sub').textContent = `· ${S.radius >= 1000 ? `${S.radius / 1000} km` : `${S.radius} m`} scout radius`;
  const search = $('#search');
  let st = 0;
  search.addEventListener('input', () => { clearTimeout(st); st = setTimeout(() => { S.search = search.value; layoutGrid({ force: true }); }, 90); });
  const sort = $('#sort');
  sort.value = S.sort;
  sort.addEventListener('change', () => { S.sort = sort.value; try { localStorage.setItem('co.sort', S.sort); } catch { /* storage unavailable */ } layoutGrid({ force: true }); });
  const feed = $('#feed'), jump = $('#feed-jump');
  feed.addEventListener('scroll', () => { if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40) { S.feedUnread = 0; jump.hidden = true; } }, { passive: true });
  jump.addEventListener('click', () => { feed.scrollTo({ top: feed.scrollHeight, behavior: REDUCED_MOTION ? 'auto' : 'smooth' }); S.feedUnread = 0; jump.hidden = true; });
  $('#sound-state').textContent = S.sound ? 'On' : 'Off';
  addEventListener('hashchange', () => { if (S.loaded) openFromHash(); });
  setInterval(() => { syncWorking(); if (S.gridDirty) layoutGrid(); }, 1000);
}

// ─────────────────────────────────────────────────────────── boot
async function boot() {
  if (QS.get('mock') === '1') {
    // Design-review harness only. Never on by default; lives in its own module.
    const mod = await import('./mock.js');
    MOCK = mod.createMockBackend();
    document.body.append(h('div', { class: 'mock-badge', text: 'Mock data · design preview (?mock=1)' }));
  }
  initRibbon();
  renderPills();
  wire();
  applyTheme();
  renderIntro();
  startClock();
  initMap();
  renderCrew();
  renderFeedFilters();
  renderFunnel();
  layoutGrid();
  updateRibbon();
  const cfg = loadConfig();
  connect();
  await Promise.all([cfg, refreshState()]);
  if (MOCK && MOCK.autopilot) MOCK.autopilot({ openChallenge, chStart, openDrawer, focusBusiness, S, QS });
}
boot();
