// Cold Open — site renderer.
// Generated concept sites (three themes) + the Cold Open utility pages (claimed / remove / removed / 404 / pending).
// Plain TypeScript with type-only imports so it also runs under `node --experimental-strip-types`.
// Everything interpolated into HTML goes through esc(); colors, fonts and URLs are validated before use.

import type { Business, Brand, SiteSpec, SiteTheme } from "../types";

/* ────────────────────────────── escaping & sanitizing ────────────────────────────── */

const ESC_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
};

/** HTML-escape any value for text or attribute context. */
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"'`]/g, (c) => ESC_MAP[c] || c);
}

/** Normalize untrusted text: strip control/bidi chars and markdown emphasis, collapse whitespace, clamp length. */
function clean(v: unknown, max = 400): string {
  let s = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  s = s
    .replace(/[\u0000-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/g, " ")
    .replace(/\*\*|__|##+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length > max) {
    let cut = s.slice(0, max);
    const sp = cut.lastIndexOf(" ");
    if (sp > max * 0.6) cut = cut.slice(0, sp);
    s = cut.replace(/[\s,;:.\-–—]+$/, "") + "…";
  }
  return s;
}

function safeHttpUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) s = "https://" + s;
    else return null;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Media sources: same-origin absolute paths ("/img/...") or https URLs only. */
function safeMediaSrc(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\/(?!\/)[^\s"'<>\\`]*$/.test(s)) return s;
  const u = safeHttpUrl(s);
  return u && u.startsWith("https:") ? u : null;
}

function absUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return base.replace(/\/+$/, "") + (path.startsWith("/") ? path : "/" + path);
}

function normBase(v: unknown): string {
  const u = safeHttpUrl(v);
  return (u || "https://coldopen.vnarasingamoorthy.workers.dev").replace(/\/+$/, "");
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/* ────────────────────────────── color math ────────────────────────────── */

function hex(v: unknown, fb: string): string {
  if (typeof v !== "string") return fb;
  let s = v.trim().toLowerCase();
  if (!s.startsWith("#")) s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) s = "#" + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  if (/^#[0-9a-f]{8}$/.test(s)) s = s.slice(0, 7);
  return /^#[0-9a-f]{6}$/.test(s) ? s : fb;
}
function rgbOf(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0"))
      .join("")
  );
}
function mix(a: string, b: string, t: number): string {
  const A = rgbOf(a);
  const B = rgbOf(b);
  return toHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t);
}
function lum(h: string): number {
  const c = rgbOf(h).map((x) => {
    const v = x / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** Nudge fg toward black/white until it reaches `min` contrast on bg. */
function ensure(fg: string, bg: string, min: number): string {
  if (contrast(fg, bg) >= min) return fg;
  const target = lum(bg) > 0.3 ? "#000000" : "#ffffff";
  for (let t = 0.08; t <= 1.001; t += 0.08) {
    const c = mix(fg, target, t);
    if (contrast(c, bg) >= min) return c;
  }
  return target;
}
/** Best readable ink for a background, preferring brand colors. */
function onColor(bg: string, prefs: string[]): string {
  for (const p of prefs) if (contrast(p, bg) >= 4.6) return p;
  return contrast("#ffffff", bg) >= contrast("#111111", bg) ? "#ffffff" : "#111111";
}
function rgba(h: string, a: number): string {
  const [r, g, b] = rgbOf(h);
  return `rgba(${r},${g},${b},${a})`;
}
function hsl(h: number, s: number, l: number): string {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex(f(0) * 255, f(8) * 255, f(4) * 255);
}
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Pal {
  bg: string;
  ink: string;
  muted: string;
  line: string;
  surface: string;
  pr: string; // raw primary
  p: string; // primary readable on bg
  onP: string;
  sr: string;
  onS: string;
  ar: string;
  a: string;
  onA: string;
  deep: string;
  tone: string; // duotone multiply color (bold hero)
  t1: string;
  t2: string;
  t3: string; // soft tints (warm cards)
  paper: string; // lifted card surface
}

function buildPalette(brand: Brand | null, theme: SiteTheme, seed: string): Pal {
  const hue = hashStr(seed) % 360;
  const P = (brand && brand.palette) || ({} as Brand["palette"]);
  let pr = hex(P.primary, hsl(hue, 62, 42));
  let sr = hex(P.secondary, hsl((hue + 28) % 360, 45, 62));
  let ar = hex(P.accent, hsl((hue + 180) % 360, 70, 55));
  let bg = hex(P.background, theme === "bold" ? "#f4f0e6" : "#faf7f1");
  let ink = hex(P.text, "#151412");

  if (theme === "warm") {
    bg = lum(bg) > 0.55 ? mix(bg, "#fbf3e4", 0.55) : mix("#fbf3e4", pr, 0.05);
  }
  if (theme === "editorial" && bg === "#ffffff") bg = "#fbfaf7";

  if (contrast(ink, bg) < 7) {
    ink = lum(bg) > 0.4 ? mix("#121110", pr, 0.08) : mix("#f7f4ee", pr, 0.04);
    if (contrast(ink, bg) < 7) ink = lum(bg) > 0.4 ? "#0e0e0e" : "#f7f5f0";
  }
  // Degenerate palettes (primary ≈ background): fall back to a seeded hue.
  if (contrast(pr, bg) < 1.25) pr = lum(bg) > 0.5 ? hsl(hue, 60, 38) : hsl(hue, 70, 62);
  if (contrast(ar, pr) < 1.2) ar = lum(pr) > 0.45 ? mix(pr, "#000000", 0.45) : hsl((hue + 180) % 360, 75, 60);
  if (contrast(sr, pr) < 1.25) sr = mix(pr, lum(pr) > 0.4 ? "#000000" : "#ffffff", 0.35);

  const dark = lum(bg) < 0.25;
  const muted = ensure(mix(ink, bg, 0.36), bg, 4.6);
  const line = mix(ink, bg, dark ? 0.8 : 0.86);
  const surface = dark ? mix(bg, ink, 0.05) : mix(bg, pr, 0.045);
  const p = ensure(pr, bg, 3.4);
  const a = ensure(ar, bg, 3.2);
  const deep = mix(pr, "#07070a", lum(pr) > 0.3 ? 0.72 : 0.5);
  const tone = lum(pr) > 0.42 ? mix(pr, "#000000", 0.35) : pr;
  return {
    bg,
    ink,
    muted,
    line,
    surface,
    pr,
    p,
    onP: onColor(pr, [bg, ink]),
    sr,
    onS: onColor(sr, [ink, bg]),
    ar,
    a,
    onA: onColor(ar, [ink, bg]),
    deep,
    tone,
    t1: mix(bg, pr, dark ? 0.16 : 0.1),
    t2: mix(bg, ar, dark ? 0.18 : 0.14),
    t3: mix(bg, sr, dark ? 0.18 : 0.16),
    paper: dark ? mix(bg, ink, 0.06) : mix(bg, "#ffffff", 0.6),
  };
}

/* ────────────────────────────── fonts ────────────────────────────── */

// Axis specs verified against Google Fonts' families; "" = single style (base request only).
const FONT_SPECS: Record<string, string> = {
  Inter: "wght@400;500;600;700;800;900",
  Fraunces: "ital,wght@0,300;0,400;0,500;0,600;0,700;0,900;1,400;1,500",
  "Playfair Display": "ital,wght@0,400;0,500;0,600;0,700;0,900;1,400;1,500",
  Lora: "ital,wght@0,400;0,500;0,600;0,700;1,400;1,500",
  Newsreader: "ital,wght@0,300;0,400;0,500;0,600;1,300;1,400;1,500",
  "EB Garamond": "ital,wght@0,400;0,500;0,600;0,700;1,400;1,500",
  "Cormorant Garamond": "ital,wght@0,400;0,500;0,600;0,700;1,400;1,500",
  Cormorant: "ital,wght@0,400;0,500;0,600;0,700;1,400;1,500",
  "Libre Baskerville": "ital,wght@0,400;0,700;1,400",
  "DM Serif Display": "ital@0;1",
  "DM Serif Text": "ital@0;1",
  "Instrument Serif": "ital@0;1",
  "Source Serif 4": "ital,wght@0,400;0,600;0,700;1,400",
  "Crimson Pro": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  Spectral: "ital,wght@0,400;0,500;0,600;0,700;1,400",
  Merriweather: "ital,wght@0,400;0,700;0,900;1,400",
  "Bodoni Moda": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  Alegreya: "ital,wght@0,400;0,500;0,700;0,800;1,400",
  "IBM Plex Serif": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  "Zilla Slab": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  "Roboto Slab": "wght@400;500;600;700;800",
  Arvo: "ital,wght@0,400;0,700;1,400",
  "DM Sans": "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  "Space Grotesk": "wght@400;500;600;700",
  Poppins: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Montserrat: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  "Work Sans": "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Manrope: "wght@400;500;600;700;800",
  Outfit: "wght@400;500;600;700;800;900",
  Syne: "wght@400;500;600;700;800",
  Archivo: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Oswald: "wght@400;500;600;700",
  "Barlow Condensed": "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Barlow: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Rubik: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Nunito: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  "Nunito Sans": "ital,wght@0,400;0,600;0,700;0,800;1,400",
  Quicksand: "wght@400;500;600;700",
  "Plus Jakarta Sans": "ital,wght@0,400;0,500;0,600;0,700;0,800;1,400",
  Figtree: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Sora: "wght@400;500;600;700;800",
  Epilogue: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Karla: "ital,wght@0,400;0,500;0,600;0,700;0,800;1,400",
  "IBM Plex Sans": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  "Josefin Sans": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  Raleway: "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Lato: "ital,wght@0,400;0,700;0,900;1,400",
  "Open Sans": "ital,wght@0,400;0,500;0,600;0,700;0,800;1,400",
  Roboto: "ital,wght@0,400;0,500;0,700;0,900;1,400",
  "Libre Franklin": "ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400",
  Chivo: "ital,wght@0,400;0,500;0,700;0,800;0,900;1,400",
  Unbounded: "wght@400;500;600;700;800;900",
  "Big Shoulders Display": "wght@400;500;600;700;800;900",
  "Instrument Sans": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  "Bricolage Grotesque": "wght@400;500;600;700;800",
  "Familjen Grotesk": "ital,wght@0,400;0,500;0,600;0,700;1,400",
  Caveat: "wght@400;500;600;700",
  Kalam: "wght@300;400;700",
  "Archivo Black": "",
  Anton: "",
  "Bebas Neue": "",
  "Abril Fatface": "",
  "Young Serif": "",
  Gloock: "",
  Prata: "",
  Righteous: "",
  Pacifico: "",
  Lobster: "",
  "Patrick Hand": "",
  "Shadows Into Light": "",
  "Alfa Slab One": "",
  Ultra: "",
  Bungee: "",
  "Titan One": "",
  "Dela Gothic One": "",
  Staatliches: "",
  "Bowlby One": "",
  "Rubik Mono One": "",
  "Paytone One": "",
};

const SERIF_FONTS = new Set([
  "Fraunces", "Playfair Display", "Lora", "Newsreader", "EB Garamond", "Cormorant Garamond", "Cormorant",
  "Libre Baskerville", "DM Serif Display", "DM Serif Text", "Instrument Serif", "Source Serif 4", "Crimson Pro",
  "Spectral", "Merriweather", "Bodoni Moda", "Alegreya", "IBM Plex Serif", "Young Serif", "Gloock", "Prata",
  "Abril Fatface", "Zilla Slab", "Roboto Slab", "Arvo", "Alfa Slab One", "Ultra", "Noto Serif", "PT Serif",
  "Libre Caslon Text", "Libre Caslon Display", "Cardo", "Marcellus", "Gelasio", "Literata", "Petrona", "Brygada 1918",
]);

function fontName(v: unknown, fb: string): string {
  let s = typeof v === "string" ? v : "";
  s = s.split(/[,;'"{}()<>:\\/]/)[0].replace(/[^A-Za-z0-9 ]/g, "").replace(/\s+/g, " ").trim().slice(0, 40);
  if (!s || /^(serif|sans serif|sans|monospace|system ui|cursive)$/i.test(s)) return fb;
  if (s === s.toLowerCase()) s = s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
  return s;
}

function fontLinks(families: string[]): string {
  const uniq = Array.from(new Set(families.filter(Boolean)));
  let out =
    '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>';
  for (const f of uniq) {
    const fam = f.replace(/ /g, "+");
    // Base request always succeeds for a real family; richer requests may 400 harmlessly for static families.
    const qs = [`family=${fam}`];
    const spec = FONT_SPECS[f];
    if (spec === undefined) qs.push(`family=${fam}:wght@400;700`, `family=${fam}:ital,wght@0,400;0,700;1,400`);
    else if (spec) qs.push(`family=${fam}:${spec}`);
    for (const q of qs) out += `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?${q}&amp;display=swap">`;
  }
  return out;
}

/* ────────────────────────────── opening hours (OSM) ────────────────────────────── */

type Week = [number, number][][];
const OSM_DAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const DAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Parses the common subset of OSM opening_hours. Returns null when anything is outside that subset. */
function parseOpeningHours(raw: unknown): Week | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s || s.length > 400) return null;
  if (s === "24/7") return OSM_DAYS.map(() => [[0, 1440]] as [number, number][]);
  const week: Week = OSM_DAYS.map(() => []);
  let any = false;
  const dayTok = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)";
  const daySeg = `${dayTok}(?:\\s*-\\s*${dayTok})?`;
  const ruleRe = new RegExp(`^((?:${daySeg})(?:\\s*,\\s*${daySeg})*)?\\s*(.*)$`);
  for (const rule of s.split(/\s*;\s*|\s*\|\|\s*/).filter(Boolean)) {
    const m = rule.match(ruleRe);
    if (!m) return null;
    const daysPart = m[1] || "";
    const timePart = (m[2] || "").trim().replace(/^:\s*/, "");
    let days: number[] = [];
    if (daysPart) {
      let holidayOnly = true;
      for (const seg of daysPart.split(/\s*,\s*/)) {
        if (seg === "PH" || seg === "SH") continue;
        holidayOnly = false;
        const [a, b] = seg.split(/\s*-\s*/);
        const ia = OSM_DAYS.indexOf(a);
        const ib = b ? OSM_DAYS.indexOf(b) : ia;
        if (ia < 0 || ib < 0) return null;
        for (let i = ia, guard = 0; guard < 8; i = (i + 1) % 7, guard++) {
          days.push(i);
          if (i === ib) break;
        }
      }
      if (holidayOnly) continue;
    } else days = [0, 1, 2, 3, 4, 5, 6];
    if (/^(off|closed)$/i.test(timePart)) {
      for (const d of days) week[d] = [];
      any = true;
      continue;
    }
    if (!timePart) return null;
    const ranges: [number, number][] = [];
    for (const tr of timePart.split(/\s*,\s*/)) {
      const t = tr.match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
      if (!t) return null;
      const a = +t[1] * 60 + +t[2];
      let b = +t[3] * 60 + +t[4];
      if (a > 1440 || b > 1440 * 2 || +t[2] > 59 || +t[4] > 59) return null;
      if (b <= a) b += 1440; // overnight
      ranges.push([a, b]);
    }
    ranges.sort((x, y) => x[0] - y[0]);
    for (const d of new Set(days)) week[d] = ranges.slice();
    any = true;
  }
  return any ? week : null;
}

function fmtTime(m: number, end = false): string {
  if (end && m % 1440 === 0) return "Midnight";
  const x = ((m % 1440) + 1440) % 1440;
  const h = Math.floor(x / 60);
  const mm = x % 60;
  const suf = h < 12 ? "AM" : "PM";
  const h12 = h % 12 || 12;
  return mm ? `${h12}:${String(mm).padStart(2, "0")} ${suf}` : `${h12} ${suf}`;
}

function dayRanges(r: [number, number][]): string {
  if (!r.length) return "Closed";
  if (r.length === 1 && r[0][0] === 0 && r[0][1] >= 1440) return "Open 24 hours";
  return r.map(([a, b]) => `${fmtTime(a)} – ${fmtTime(b, true)}`).join(", ");
}

function weekRows(w: Week): { days: number[]; label: string; value: string }[] {
  const rows: { days: number[]; label: string; value: string }[] = [];
  for (let d = 0; d < 7; d++) {
    const v = dayRanges(w[d]);
    const last = rows[rows.length - 1];
    if (last && last.value === v && last.days[last.days.length - 1] === d - 1) last.days.push(d);
    else rows.push({ days: [d], label: "", value: v });
  }
  for (const r of rows)
    r.label =
      r.days.length === 1
        ? DAY_SHORT[r.days[0]]
        : r.days.length === 7
          ? "Every day"
          : `${DAY_SHORT[r.days[0]]} – ${DAY_SHORT[r.days[r.days.length - 1]]}`;
  return rows;
}

/* ────────────────────────────── icons ────────────────────────────── */

const I_ARROW =
  '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 8h11M9 3.5 13.5 8 9 12.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const I_EXT =
  '<svg class="ic" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 11.5 11.5 4.5M6 4.5h5.5V10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const I_PIN =
  '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 14.5s4.5-4.2 4.5-8a4.5 4.5 0 0 0-9 0c0 3.8 4.5 8 4.5 8Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="6.5" r="1.6" fill="currentColor"/></svg>';
const I_PHONE =
  '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.6 2.5h2.1l1 2.8-1.4 1a7.6 7.6 0 0 0 4.4 4.4l1-1.4 2.8 1v2.1a1.2 1.2 0 0 1-1.3 1.2C7 13.2 2.8 9 2.4 3.8a1.2 1.2 0 0 1 1.2-1.3Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
const I_CHEVRON =
  '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 10l4-4 4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const I_X =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>';
const I_CHECK =
  '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3 8.5 6.5 12 13 4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const DOODLES = [
  '<svg class="doodle" viewBox="0 0 48 48" aria-hidden="true"><circle cx="24" cy="24" r="7.5"/><path d="M24 5.5v6.5M24 36v6.5M5.5 24H12M36 24h6.5M11 11l4.4 4.4M32.6 32.6 37 37M37 11l-4.4 4.4M15.4 32.6 11 37"/></svg>',
  '<svg class="doodle" viewBox="0 0 48 48" aria-hidden="true"><path d="M5 30c5-13 11-15 13.5-6.5S26 34 30.5 22.5 39 12 43 24"/><path d="M8 39c8-3 24-3 32 0"/></svg>',
  '<svg class="doodle" viewBox="0 0 48 48" aria-hidden="true"><path d="M9 41C17 27 27 17 40 8"/><path d="M17 31c-6-1.5-9.5-6.5-9.5-12 6.5.2 10.4 4.6 11 10.8"/><path d="M25 22.5c-1.2-6.2 1.6-11.2 7-13.4 2.3 6-.3 11.3-5.4 14"/><path d="M23.5 27c6.3-1 11.3 1.5 13.3 6.8-6.1 2-11.3-.2-13.6-5.5"/></svg>',
];

/* ────────────────────────────── context ────────────────────────────── */

const FOOD = new Set([
  "cafe", "restaurant", "bar", "pub", "fast_food", "bakery", "ice_cream", "food_court", "biergarten", "deli",
  "coffee", "juice", "tea", "pastry", "confectionery", "wine", "brewery", "food", "street_food", "pizza",
]);
const CAT_LABEL: Record<string, string> = {
  cafe: "Café",
  restaurant: "Restaurant",
  bar: "Bar",
  pub: "Pub",
  fast_food: "Counter service",
  bakery: "Bakery",
  ice_cream: "Ice cream",
  books: "Bookshop",
  bicycle: "Bike shop",
  hairdresser: "Salon",
  beauty: "Beauty studio",
  florist: "Florist",
  clothes: "Clothing",
  gift: "Gift shop",
  deli: "Deli",
  wine: "Wine shop",
  coffee: "Coffee",
  convenience: "Corner store",
  gym: "Gym",
  fitness_centre: "Fitness studio",
  yoga: "Yoga studio",
  art: "Art",
  music: "Music",
  tattoo: "Tattoo studio",
  barber: "Barber",
  laundry: "Laundry",
  pet: "Pet shop",
  shoes: "Shoes",
  jewelry: "Jewelry",
  furniture: "Furniture",
  hardware: "Hardware",
  optician: "Optician",
  dentist: "Dentist",
  nightclub: "Club",
};

/** "Spoke & Sprocket Bike Co-op" → "Spoke & Sprocket" for friendlier headings. */
function shortName(name: string): string {
  const re =
    /\s+(coffee(\s+(co\.?|company|roasters|shop|bar|house))?|caf[eé]|kitchen|bakery|bike\s+co-?op|co-?op|restaurant|grill|deli|shop|studio|salon|bar|llc|inc\.?)$/i;
  let s = name.trim();
  for (let i = 0; i < 2; i++) {
    const t = s.replace(re, "").trim();
    if (t.length >= 3 && t !== s) s = t;
  }
  return s;
}

function titleCase(s: string): string {
  return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

interface Offer {
  name: string;
  description: string;
  price: string;
}

interface Ctx {
  biz: Business;
  theme: SiteTheme;
  pal: Pal;
  base: string;
  id: string;
  name: string;
  initials: string;
  hrefClaim: string;
  hrefRemove: string;
  headline: string;
  sub: string;
  about: string;
  story: string;
  tagline: string;
  highlights: { title: string; text: string }[];
  offerings: Offer[];
  confirmed: boolean;
  offTitle: string;
  navMenu: string;
  cta: string;
  hoursText: string;
  week: Week | null;
  tzLA: boolean;
  street: string;
  address: string;
  catLabel: string;
  kicker: string[];
  lat: number | null;
  lon: number | null;
  directions: string | null;
  tel: string | null;
  telLabel: string;
  website: string | null;
  websiteLabel: string;
  hero: string | null;
  video: string | null;
  keywords: string[];
  signals: string[];
  paid: boolean;
  score: number | null;
  drafts: number;
  fontH: string;
  fontB: string;
  fontA: string;
  hw: number;
  headK: number; // average glyph width factor for fitting display type
}

function initialsOf(name: string): string {
  const words = name
    .replace(/^the\s+/i, "")
    .split(/[\s&+/-]+/)
    .filter((w) => /[A-Za-z0-9]/.test(w));
  const first = (w: string) => (w.match(/[A-Za-z0-9]/) || [""])[0].toUpperCase();
  if (!words.length) return (Array.from(name.trim())[0] || "C").toUpperCase();
  if (words.length === 1) return first(words[0]);
  return first(words[0]) + first(words[1]);
}

function similar(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const x = n(a);
  const y = n(b);
  if (!x || !y) return false;
  if (x.includes(y) || y.includes(x)) return true;
  return x.slice(0, 48) === y.slice(0, 48);
}

function fmtPhone(raw: string): { tel: string; label: string } | null {
  const first = raw.split(/[;,/]/)[0].trim();
  const digits = first.replace(/[^\d+]/g, "");
  const d = digits.replace(/\D/g, "");
  if (d.length < 7 || d.length > 15) return null;
  let label = first.replace(/[^\d+()\-.\s]/g, "").trim();
  const us = d.length === 11 && d.startsWith("1") ? d.slice(1) : d.length === 10 ? d : null;
  if (us) label = `(${us.slice(0, 3)}) ${us.slice(3, 6)}-${us.slice(6)}`;
  const tel = us ? `+1${us}` : digits.startsWith("+") ? digits : d;
  return { tel, label: label || d };
}

function buildCtx(biz: Business, brand: Brand, site: SiteSpec, base: string): Ctx {
  const theme: SiteTheme = site.theme === "bold" || site.theme === "warm" ? site.theme : "editorial";
  const tags = biz.osmTags && typeof biz.osmTags === "object" ? biz.osmTags : {};
  const name = clean(biz.name, 80) || clean(brand.name, 80) || "This shop";
  const id = String(biz.id || "");
  const pal = buildPalette(brand, theme, id || name);

  const cat = clean(biz.category, 40).toLowerCase();
  const catLabel = CAT_LABEL[cat] || titleCase(cat.replace(/_/g, " ")) || "Local business";
  const cuisine = clean((tags.cuisine || "").split(/[;,]/)[0].replace(/_/g, " "), 30);
  const address = clean(biz.address || "", 140);
  const street = clean(address.split(",")[0], 60);
  const cuisineRedundant =
    !cuisine ||
    catLabel.toLowerCase().includes(cuisine.toLowerCase()) ||
    (cat === "cafe" && /coffee|caf[eé]|espresso/i.test(cuisine)) ||
    (cat === "bakery" && /bak|pastr/i.test(cuisine));
  const kicker = [
    cuisineRedundant ? "" : titleCase(cuisine),
    catLabel,
    street,
  ].filter(Boolean);

  const lat = num(biz.lat);
  const lon = num(biz.lon);
  const hasGeo = lat !== null && lon !== null && Math.abs(lat) <= 85 && Math.abs(lon) <= 180;
  const directions = hasGeo
    ? `https://www.openstreetmap.org/?mlat=${lat!.toFixed(6)}&mlon=${lon!.toFixed(6)}#map=18/${lat!.toFixed(6)}/${lon!.toFixed(6)}`
    : address
      ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`
      : null;

  const phoneRaw = biz.phone || tags.phone || tags["contact:phone"] || "";
  const ph = phoneRaw ? fmtPhone(String(phoneRaw)) : null;
  const website = safeHttpUrl(biz.website || tags.website || tags["contact:website"] || "");
  let websiteLabel = "";
  if (website) {
    try {
      websiteLabel = new URL(website).hostname.replace(/^www\./, "");
    } catch {
      websiteLabel = "Website";
    }
  }

  const offersRaw = (site.offerings && site.offerings.length ? site.offerings : brand.offerings) || [];
  const confirmed = !!brand.offeringsConfirmed;
  const offerings: Offer[] = offersRaw
    .filter((o) => o && (o.name || o.description))
    .slice(0, 12)
    .map((o) => ({
      name: clean(o.name, 60),
      description: clean(o.description, 180),
      // Prices only ever appear when they came from the business's own site.
      price: confirmed ? clean(o.price || "", 16) : "",
    }))
    .filter((o) => o.name);

  const highlights = (site.highlights || [])
    .filter((h) => h && (h.title || h.text))
    .slice(0, 3)
    .map((h) => ({ title: clean(h.title, 60), text: clean(h.text, 220) }));

  const offTitle = clean(site.offeringsTitle, 48) || (FOOD.has(cat) ? "The menu" : "What we offer");
  const navMenu = offTitle.length <= 14 ? offTitle : FOOD.has(cat) ? "Menu" : "Offerings";
  const about = clean(site.about, 900);
  const storyRaw = clean(brand.story, 700);
  const story = storyRaw && !similar(storyRaw, about) ? storyRaw : "";
  const tagline = clean(brand.tagline, 120);

  const heroSrc = safeMediaSrc(biz.heroImage);
  const video = biz.video && biz.video.status === "ready" ? safeMediaSrc(biz.video.url) : null;

  const scores = Array.isArray(biz.scores) ? biz.scores : [];
  const lastScore = scores.length ? num(scores[scores.length - 1].score) : null;

  const fbH = theme === "bold" ? "Archivo Black" : "Fraunces";
  const fbB = theme === "bold" ? "Archivo" : theme === "warm" ? "Nunito" : "Inter";
  const fontH = fontName(brand.fonts && brand.fonts.heading, fbH);
  const fontB = fontName(brand.fonts && brand.fonts.body, fbB);
  const single = FONT_SPECS[fontH] === "";
  const serifH = SERIF_FONTS.has(fontH);
  const fontA = theme === "warm" ? "Caveat" : theme === "editorial" ? (serifH ? fontH : "Newsreader") : fontH;
  const hw = single ? 400 : theme === "bold" ? 800 : theme === "warm" ? (serifH ? 500 : 700) : serifH ? 400 : 500;
  const condensed = /condensed|bebas|anton|oswald|big shoulders|staatliches/i.test(fontH);
  const headK = theme === "bold" ? (condensed ? 0.46 : 0.68) : serifH ? 0.5 : 0.56;

  const kws = (brand.keywords || []).map((k) => clean(k, 28)).filter(Boolean).slice(0, 8);

  return {
    biz,
    theme,
    pal,
    base,
    id,
    name,
    initials: initialsOf(name),
    hrefClaim: `/s/${encodeURIComponent(id)}/claim`,
    hrefRemove: `/s/${encodeURIComponent(id)}/remove`,
    headline: clean(site.headline, 140) || name,
    sub: clean(site.subheadline, 260),
    about,
    story,
    tagline: tagline && !similar(tagline, clean(site.headline, 140)) ? tagline : "",
    highlights,
    offerings,
    confirmed,
    offTitle,
    navMenu,
    cta: clean(site.ctaLabel, 28) || "Visit us",
    hoursText: clean(site.hoursText, 220) || "Hours — owner to confirm",
    week: parseOpeningHours(biz.openingHours || tags.opening_hours),
    tzLA: hasGeo && lon! > -125 && lon! < -114 && lat! > 32 && lat! < 49.5,
    street,
    address,
    catLabel,
    kicker,
    lat: hasGeo ? lat : null,
    lon: hasGeo ? lon : null,
    directions,
    tel: ph ? ph.tel : null,
    telLabel: ph ? ph.label : "",
    website,
    websiteLabel,
    hero: heroSrc,
    video,
    keywords: kws,
    signals: (brand.sourceSignals || []).map((s) => clean(s, 120)).filter(Boolean).slice(0, 10),
    paid: biz.status === "paid",
    score: lastScore,
    drafts: scores.length,
    fontH,
    fontB,
    fontA,
    hw,
    headK,
  };
}

/* ────────────────────────────── shared fragments ────────────────────────────── */

/** Inline font-size that guarantees the longest word fits the viewport and the text fits the column. */
function fitSize(text: string, k: number, o: { min: number; vw: number; max: number; col?: number }): string {
  const longest = Math.max(4, ...text.split(/\s+/).map((w) => w.length));
  const vw = Math.min(o.vw, 88 / (longest * k));
  const min = Math.min(o.min, Math.floor(330 / (longest * k)));
  const max = Math.min(o.max, Math.floor((o.col || 1180) / (longest * k)));
  return `font-size:clamp(${Math.max(20, min)}px,${vw.toFixed(2)}vw,${Math.max(min, max)}px)`;
}

/** Inline font-size for a single unbroken line (giant footer wordmarks). */
function fitLine(text: string, k: number, o: { min: number; vw: number; max: number; col?: number }): string {
  const len = Math.max(4, text.length);
  const vw = Math.min(o.vw, 90 / (len * k));
  const max = Math.min(o.max, Math.floor((o.col || 1200) / (len * k)));
  const min = Math.min(o.min, Math.floor(330 / (len * k)));
  return `font-size:clamp(${Math.max(16, min)}px,${vw.toFixed(2)}vw,${Math.max(min, max)}px)`;
}

function sizeClass(text: string): string {
  const n = text.length;
  return n <= 26 ? "s1" : n <= 46 ? "s2" : n <= 76 ? "s3" : "s4";
}

function emLast(h: string): string {
  const w = h.split(" ");
  if (w.length < 3) return esc(h);
  const last = w.pop() as string;
  return `${esc(w.join(" "))} <em>${esc(last)}</em>`;
}

function banner(c: Ctx): string {
  const claimed = c.paid
    ? `<span class="co-claimed">${I_CHECK} Claimed — handoff in progress</span>`
    : `<a class="co-btn co-claim" id="co-claim" href="${esc(c.hrefClaim)}">Claim it · $49</a>`;
  return `<div class="co" id="co" role="region" aria-label="Preview notice">
<div class="co-in">
<a class="co-mark" href="${esc(c.base)}/" aria-label="Cold Open">CO</a>
<p class="co-txt">Unofficial concept preview made for <b>${esc(c.name)}</b> by Cold Open — not the official site.</p>
<div class="co-act">${claimed}<a class="co-btn co-rm" href="${esc(c.hrefRemove)}">Remove this preview</a>
<button class="co-x" id="co-x" type="button" aria-label="Minimize preview notice" title="Minimize">${I_X}</button></div>
</div></div>
<button class="co-pill" id="co-pill" type="button" aria-controls="co" aria-expanded="true"><span class="co-dot"></span>Unofficial preview · Cold Open ${I_CHEVRON}</button>`;
}

function heroMedia(c: Ctx): string {
  if (c.video) {
    return `<div class="hm"><video autoplay muted loop playsinline preload="metadata"${c.hero ? ` poster="${esc(c.hero)}"` : ""} aria-hidden="true"><source src="${esc(c.video)}"></video></div>`;
  }
  if (c.hero) {
    return `<div class="hm"><img src="${esc(c.hero)}" alt="" fetchpriority="high" decoding="async" width="1600" height="1000"></div>`;
  }
  return `<div class="hm gen" aria-hidden="true"><div class="gen-l"></div><span class="gen-m">${esc(c.initials)}</span></div>`;
}

function heroCaption(c: Ctx): string {
  if (c.video) return `<p class="cap">Concept film · AI-generated</p>`;
  if (c.hero) return `<p class="cap">Illustrative image · AI-generated for this concept</p>`;
  return "";
}

function navLinks(c: Ctx): string {
  const l: string[] = [];
  if (c.offerings.length) l.push(`<a href="#menu">${esc(c.navMenu)}</a>`);
  if (c.about) l.push(`<a href="#story">Story</a>`);
  l.push(`<a href="#visit">Visit</a>`);
  return l.join("");
}

function heroButtons(c: Ctx, primaryCls: string, secondaryCls: string): string {
  let out = `<a class="${primaryCls}" href="#visit">${esc(c.cta)} ${I_ARROW}</a>`;
  if (c.offerings.length) {
    const label = c.navMenu === "Menu" ? "See the menu" : `See ${c.navMenu.toLowerCase()}`;
    out += `<a class="${secondaryCls}" href="#menu">${esc(label)}</a>`;
  }
  return out;
}

function previewNote(c: Ctx, cls = "pv"): string {
  if (c.confirmed) return "";
  const what = c.navMenu === "Menu" || c.navMenu === "The menu" ? "menu" : "list";
  return `<div class="${cls}"><span class="pv-tag"><span class="pv-dot"></span>Preview — owner to confirm</span><p>Items are typical for a ${esc(c.catLabel.toLowerCase())}, not ${esc(c.name)}'s actual ${what}. The owner confirms the real one before launch.</p></div>`;
}

function hoursBlock(c: Ctx): string {
  if (c.week) {
    const rows = weekRows(c.week)
      .map((r) => `<tr data-d="${r.days.join(",")}"><th scope="row">${esc(r.label)}</th><td>${esc(r.value)}</td></tr>`)
      .join("");
    const data = c.tzLA ? JSON.stringify(c.week) : "";
    return `${data ? `<p class="oh" id="oh" data-w="${esc(data)}" hidden></p>` : ""}<table class="ht"><caption class="sr">Opening hours</caption><tbody>${rows}</tbody></table><p class="ht-src">Hours from OpenStreetMap</p>`;
  }
  return `<p class="ht-text">${esc(c.hoursText)}</p>`;
}

function visitButtons(c: Ctx, primary: string, ghost: string): string {
  const b: string[] = [];
  if (c.directions)
    b.push(`<a class="${primary}" href="${esc(c.directions)}" target="_blank" rel="noopener">${I_PIN} Get directions</a>`);
  if (c.tel) b.push(`<a class="${ghost}" href="tel:${esc(c.tel)}">${I_PHONE} ${esc(c.telLabel)}</a>`);
  if (c.website)
    b.push(
      `<a class="${ghost}" href="${esc(c.website)}" target="_blank" rel="noopener nofollow">${esc(c.websiteLabel)} ${I_EXT}</a>`,
    );
  return b.join("");
}

function mapBlock(c: Ctx, extraCls = ""): string {
  if (c.lat === null || c.lon === null) return "";
  const z = 17;
  const n = Math.pow(2, z);
  const x = ((c.lon + 180) / 360) * n;
  const latR = (c.lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2) * n;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const fx = (x - cx) * 256;
  const fy = (y - cy) * 256;
  let imgs = "";
  for (let r = -1; r <= 1; r++) {
    for (let col = -2; col <= 2; col++) {
      const tx = (((cx + col) % n) + n) % n;
      const ty = cy + r;
      if (ty < 0 || ty >= n) continue;
      imgs += `<img src="https://tile.openstreetmap.org/${z}/${tx}/${ty}.png" alt="" loading="lazy" decoding="async" width="256" height="256" style="left:${(col + 2) * 256}px;top:${(r + 1) * 256}px">`;
    }
  }
  const href = c.directions ? esc(c.directions) : "#visit";
  return `<figure class="map ${extraCls}"><a class="map-v" href="${href}" target="_blank" rel="noopener" aria-label="Open ${esc(c.name)} in OpenStreetMap"><div class="tiles" style="left:calc(50% - ${Math.round(512 + fx)}px);top:calc(50% - ${Math.round(256 + fy)}px)">${imgs}</div><span class="tint"></span><span class="pin"></span><span class="pin-l">${esc(c.name)}</span></a><figcaption>Map data © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors</figcaption></figure>`;
}

function howMade(c: Ctx): string {
  const items = c.signals.map((s) => `<li>${esc(s)}</li>`).join("");
  const score =
    c.score !== null
      ? `<p>Cleared Cold Open's taste gate at <b>${Math.round(c.score)}/100</b>${c.drafts > 1 ? ` after ${c.drafts} drafts` : ""}.</p>`
      : "";
  return `<details class="src"><summary>How this preview was made</summary><div class="src-b"><p>Composed by Cold Open's agents from public information only. Nothing here was written or approved by ${esc(c.name)}.</p>${items ? `<ul>${items}</ul>` : ""}${score}</div></details>`;
}

function footMeta(c: Ctx): string {
  const claim = c.paid ? "" : `<a href="${esc(c.hrefClaim)}">Claim it · $49</a>`;
  return `<div class="fm"><p>Unofficial concept preview made for ${esc(c.name)} by <a href="${esc(c.base)}/">Cold Open</a>. Not affiliated with or endorsed by ${esc(c.name)}.${c.hero || c.video ? " Imagery is AI-generated and illustrative." : ""}</p><p class="fm-l">${claim}<a href="${esc(c.hrefRemove)}">Remove this preview</a></p>${howMade(c)}</div>`;
}

function hoursShort(c: Ctx): string {
  if (c.week) {
    return weekRows(c.week)
      .map((r) => `<span>${esc(r.label)} · ${esc(r.value)}</span>`)
      .join("");
  }
  return `<span>${esc(c.hoursText)}</span>`;
}

function footCols(c: Ctx): string {
  const cols: string[] = [];
  cols.push(
    `<div><p class="fl">Find us</p>${c.address ? `<p>${esc(c.address)}</p>` : `<p>${esc(c.name)}</p>`}${c.directions ? `<a href="${esc(c.directions)}" target="_blank" rel="noopener">Directions ${I_EXT}</a>` : ""}</div>`,
  );
  cols.push(`<div><p class="fl">Hours</p><p class="fh">${hoursShort(c)}</p></div>`);
  const contact: string[] = [];
  if (c.tel) contact.push(`<a href="tel:${esc(c.tel)}">${esc(c.telLabel)}</a>`);
  if (c.website)
    contact.push(`<a href="${esc(c.website)}" target="_blank" rel="noopener nofollow">${esc(c.websiteLabel)} ${I_EXT}</a>`);
  if (contact.length) cols.push(`<div><p class="fl">Contact</p>${contact.join("")}</div>`);
  return cols.join("");
}

/* ────────────────────────────── base CSS (all themes) ────────────────────────────── */

const GRAIN =
  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 .55 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")";

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%;scroll-behavior:smooth;scroll-padding-top:84px}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--bf);font-size:17px;line-height:1.62;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility;overflow-x:hidden}
img,video,svg{display:block;max-width:100%}
a{color:inherit}
h1,h2,h3{font-family:var(--hf);font-weight:var(--hw);margin:0;text-wrap:balance;font-synthesis:none}
p{margin:0;text-wrap:pretty}
figure{margin:0}
::selection{background:var(--pr);color:var(--on-p)}
:focus-visible{outline:2px solid var(--p);outline-offset:3px;border-radius:4px}
.sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.wrap{width:min(1240px,calc(100% - 32px));margin-inline:auto}
@media(min-width:768px){.wrap{width:min(1240px,calc(100% - 72px))}}
.ic{flex:none;display:inline-block;vertical-align:-.14em}
.foot-g a{display:inline-flex;align-items:center;gap:6px;justify-self:start}

/* Cold Open preview layer — deliberately neutral, identical across themes */
.co{position:sticky;top:0;z-index:1000;background:rgba(10,10,11,.94);-webkit-backdrop-filter:saturate(1.4) blur(12px);backdrop-filter:saturate(1.4) blur(12px);color:#F4F1EA;font:500 13px/1.4 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;border-bottom:1px solid #232327}
.co-in{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;padding:9px 16px;max-width:1440px;margin:auto}
.co-mark{flex:none;width:24px;height:24px;border-radius:7px;background:#FF5B1F;color:#0A0A0B;display:grid;place-items:center;font:800 9.5px/1 ui-sans-serif,system-ui,sans-serif;letter-spacing:.02em;text-decoration:none}
.co-txt{flex:1 1 300px;min-width:0;color:#D9D5CC}
.co-txt b{color:#F4F1EA;font-weight:650}
.co-act{display:flex;align-items:center;gap:8px;margin-left:auto}
.co-btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:999px;font-weight:650;font-size:12.5px;text-decoration:none;white-space:nowrap;transition:background .2s,border-color .2s,color .2s}
.co-claim{background:#FF5B1F;color:#0A0A0B}
.co-claim:hover{background:#FF7A47}
.co-rm{color:#F4F1EA;border:1px solid #3A3A40}
.co-rm:hover{border-color:#8A877F}
.co-claimed{display:inline-flex;align-items:center;gap:6px;color:#3DDC84;font-weight:650;font-size:12.5px;padding:0 6px}
.co-x{flex:none;width:32px;height:32px;border:0;border-radius:999px;background:transparent;color:#8A877F;cursor:pointer;display:grid;place-items:center}
.co-x:hover{color:#F4F1EA;background:#1C1C1F}
.co-pill{position:fixed;left:14px;bottom:14px;z-index:1000;display:none;align-items:center;gap:8px;height:36px;padding:0 14px 0 12px;border:1px solid #2C2C31;border-radius:999px;background:rgba(10,10,11,.92);color:#F4F1EA;font:600 12px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;cursor:pointer;box-shadow:0 10px 30px rgba(0,0,0,.28);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px)}
.co-pill:hover{border-color:#8A877F}
.co-dot{width:7px;height:7px;border-radius:50%;background:#FF5B1F;box-shadow:0 0 0 3px rgba(255,91,31,.22)}
html.co-min .co{display:none}
html.co-min .co-pill{display:inline-flex}
@media(max-width:640px){.co-in{padding:8px 12px 9px}.co-txt{font-size:12.5px;flex-basis:calc(100% - 40px)}.co-act{margin-left:0;width:100%}.co-rm{margin-right:auto}}

/* hero media */
.hm{position:absolute;inset:0;z-index:-2;overflow:hidden;background:var(--deep)}
.hm img,.hm video{width:100%;height:100%;object-fit:cover}
.hm img{transform-origin:60% 45%;animation:kb 28s ease-in-out infinite alternate;will-change:transform}
@keyframes kb{0%{transform:scale(1.04) translate3d(0,0,0)}100%{transform:scale(1.15) translate3d(-1.6%,-1.8%,0)}}
.gen .gen-l{position:absolute;inset:-12%;background:radial-gradient(55% 60% at 18% 30%,var(--pr) 0%,transparent 70%),radial-gradient(45% 55% at 82% 72%,var(--ar) 0%,transparent 72%),radial-gradient(40% 40% at 62% 18%,var(--sr) 0%,transparent 70%),var(--deep);filter:saturate(1.1);animation:drift 22s ease-in-out infinite alternate}
.gen::after{content:"";position:absolute;inset:0;background-image:${GRAIN};opacity:.35;mix-blend-mode:overlay}
.gen-m{position:absolute;right:-.06em;bottom:-.22em;font:var(--hw) min(62vh,52vw)/1 var(--hf);color:#fff;opacity:.1;letter-spacing:-.04em;user-select:none}
@keyframes drift{0%{transform:translate3d(0,0,0) scale(1)}100%{transform:translate3d(-4%,3%,0) scale(1.08)}}
.cap{position:absolute;right:14px;top:50%;transform:translateY(-50%) rotate(180deg);writing-mode:vertical-rl;font:500 10.5px/1 var(--bf);letter-spacing:.12em;text-transform:uppercase;color:#fff;opacity:.58;margin:0;pointer-events:none}
@media(max-width:640px){.cap{display:none}}
.hero-in>*{animation:rise 1.1s cubic-bezier(.2,.7,.2,1) both}
.hero-in>*:nth-child(2){animation-delay:.12s}.hero-in>*:nth-child(3){animation-delay:.24s}.hero-in>*:nth-child(4){animation-delay:.36s}
@keyframes rise{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:none}}

/* scroll reveal (only when JS is on) */
.js .rv{opacity:0;transform:translateY(28px);transition:opacity 1s cubic-bezier(.2,.7,.2,1),transform 1s cubic-bezier(.2,.7,.2,1);transition-delay:calc(var(--d,0) * 90ms)}
.js .rv.in{opacity:1;transform:none}

/* preview note */
.pv-tag{display:inline-flex;align-items:center;gap:8px;font:650 11px/1 var(--bf);letter-spacing:.14em;text-transform:uppercase;padding:9px 13px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.pv-dot{width:7px;height:7px;border-radius:50%;background:var(--a)}
.pv p{margin-top:12px;font-size:14px;line-height:1.5;opacity:.78;max-width:44ch}

/* hours */
.oh{display:inline-flex;align-items:center;gap:8px;font:650 13px/1 var(--bf);padding:8px 12px 8px 10px;border-radius:999px;margin-bottom:16px;background:var(--surface);border:1px solid var(--line)}
.oh::before{content:"";width:8px;height:8px;border-radius:50%;background:#9a9a9a}
.oh.is-open::before{background:#1FA463;box-shadow:0 0 0 3px rgba(31,164,99,.2)}
.oh.is-closed::before{background:#C9503A}
.ht{border-collapse:collapse;width:100%;max-width:440px;font-size:15.5px}
.ht th,.ht td{padding:10px 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.ht th{font-weight:600;width:42%;padding-right:16px}
.ht td{font-variant-numeric:tabular-nums}
.ht tr.today th,.ht tr.today td{color:var(--p)}
.ht tr.today th::after{content:" · today";font-weight:500;font-size:.85em;opacity:.8}
.ht-src{font-size:12px;opacity:.6;margin-top:10px}
.ht-text{font-size:17px}

/* map */
.map{position:relative}
.map-v{position:relative;display:block;height:clamp(300px,38vw,460px);overflow:hidden;background:var(--surface);isolation:isolate}
.tiles{position:absolute;width:1280px;height:768px}
.tiles img{position:absolute;width:256px;height:256px;max-width:none;user-select:none}
.tint{position:absolute;inset:0;pointer-events:none}
.pin{position:absolute;left:50%;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:var(--pr);border:3px solid #fff;box-shadow:0 4px 14px rgba(0,0,0,.3)}
.pin::after{content:"";position:absolute;inset:-12px;border-radius:50%;border:2px solid var(--pr);opacity:0;animation:ping 2.6s ease-out infinite}
@keyframes ping{0%{transform:scale(.4);opacity:.9}100%{transform:scale(2.2);opacity:0}}
.pin-l{position:absolute;left:calc(50% + 18px);top:50%;transform:translateY(-50%);background:var(--ink);color:var(--bg);font:650 12.5px/1 var(--bf);padding:8px 11px;border-radius:999px;white-space:nowrap;max-width:48%;overflow:hidden;text-overflow:ellipsis;box-shadow:0 6px 18px rgba(0,0,0,.18)}
.map figcaption{font-size:11.5px;opacity:.62;margin-top:10px}
.map figcaption a{text-decoration:none}

/* footer meta */
.fm{margin-top:48px;padding-top:24px;border-top:1px solid currentColor;border-color:rgba(127,127,127,.28);font-size:13px;line-height:1.55;display:grid;gap:14px}
.fm p{opacity:.72;max-width:72ch}
.fm-l{display:flex;flex-wrap:wrap;gap:8px 22px;opacity:1!important}
.fm-l a{font-weight:650;text-underline-offset:4px}
.src summary{cursor:pointer;font-weight:600;opacity:.8;list-style:none;display:inline-flex;align-items:center;gap:8px}
.src summary::-webkit-details-marker{display:none}
.src summary::before{content:"+";display:inline-grid;place-items:center;width:18px;height:18px;border:1px solid currentColor;border-radius:50%;font-size:12px;line-height:1}
.src[open] summary::before{content:"–"}
.src-b{padding:12px 0 0 26px;display:grid;gap:8px;opacity:.78}
.src ul{margin:0;padding-left:18px;display:grid;gap:4px}

@media (prefers-reduced-motion:reduce){
  html{scroll-behavior:auto}
  *,*::before,*::after{animation:none!important;transition:none!important}
  .js .rv{opacity:1;transform:none}
}
`;

/* ────────────────────────────── theme: EDITORIAL ────────────────────────────── */

const EDITORIAL_CSS = `
.hero{position:relative;height:clamp(620px,94svh,960px);overflow:hidden;color:#fff;isolation:isolate;display:flex;flex-direction:column}
.hm img{filter:saturate(.92) contrast(1.02)}
.scrim{position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(0,0,0,.5) 0%,rgba(0,0,0,.08) 24%,rgba(0,0,0,0) 44%,rgba(0,0,0,.5) 72%,rgba(0,0,0,.82) 100%)}
.nav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:22px;position:relative;z-index:2}
.bm{display:flex;align-items:center;gap:12px;text-decoration:none;font:var(--hw) 21px/1.1 var(--hf);letter-spacing:-.01em;min-width:0}
.bm span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mono{flex:none;width:38px;height:38px;border-radius:50%;border:1px solid rgba(255,255,255,.6);display:grid;place-items:center;font:600 12px/1 var(--bf);letter-spacing:.06em}
.links{display:none;gap:34px;font:600 11.5px/1 var(--bf);letter-spacing:.18em;text-transform:uppercase}
.links a{text-decoration:none;opacity:.86;padding:6px 0;border-bottom:1px solid transparent;transition:opacity .2s,border-color .2s}
.links a:hover{opacity:1;border-color:currentColor}
@media(min-width:880px){.links{display:flex}}
.nav-cta{flex:none;display:inline-flex;align-items:center;gap:8px;height:40px;padding:0 18px;border:1px solid rgba(255,255,255,.7);border-radius:999px;text-decoration:none;font:600 13.5px/1 var(--bf);transition:background .2s,color .2s}
.nav-cta:hover{background:#fff;color:#111}
.hero-in{margin-top:auto;padding-bottom:clamp(40px,6.5vw,84px);position:relative;z-index:2}
.kicker{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;font:600 11.5px/1.3 var(--bf);letter-spacing:.2em;text-transform:uppercase;opacity:.92;margin-bottom:26px}
.kicker span+span::before{content:"";display:inline-block;width:18px;height:1px;background:currentColor;vertical-align:middle;margin-right:14px;opacity:.7}
.hero h1{line-height:.95;letter-spacing:-.028em;max-width:15ch}
.hero h1 em{font-family:var(--af);font-style:italic;font-weight:400;letter-spacing:-.02em}
.hero-row{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:26px 56px;margin-top:30px}
.sub{max-width:44ch;font-size:clamp(17px,1.5vw,20px);line-height:1.5;opacity:.92}
.btns{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-flex;align-items:center;gap:10px;min-height:50px;padding:0 24px;border-radius:999px;background:var(--pr);color:var(--on-p);text-decoration:none;font:650 15px/1 var(--bf);letter-spacing:.01em;transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s,background .25s;border:0}
.btn:hover{transform:translateY(-2px);box-shadow:0 12px 28px -12px rgba(0,0,0,.45)}
.btn .ic{transition:transform .25s}.btn:hover .ic{transform:translateX(3px)}
.btn-w{background:#fff;color:#111}
.btn-o{background:transparent;color:inherit;box-shadow:inset 0 0 0 1px currentColor}
.btn-o:hover{box-shadow:inset 0 0 0 1px currentColor,0 12px 28px -14px rgba(0,0,0,.35)}
.label{font:650 11.5px/1 var(--bf);letter-spacing:.2em;text-transform:uppercase;color:var(--p);display:flex;align-items:center;gap:12px}
.label::before{content:"";width:26px;height:1px;background:currentColor}

.intro{padding:clamp(80px,11vw,168px) 0 clamp(48px,6vw,96px)}
.intro-g{display:grid;gap:28px}
@media(min-width:900px){.intro-g{grid-template-columns:3fr 9fr;gap:48px}}
.folio{font:500 12px/1.6 var(--bf);letter-spacing:.16em;text-transform:uppercase;color:var(--muted);padding-top:14px;border-top:1px solid var(--ink)}
.folio b{display:block;color:var(--ink);font-weight:650}
.deck{font:400 clamp(30px,4.3vw,62px)/1.1 var(--af);letter-spacing:-.018em;max-width:20ch}

.feats{padding:clamp(24px,4vw,56px) 0 clamp(96px,12vw,176px)}
.feats-g{display:grid;gap:56px}
@media(min-width:900px){.feats-g{grid-template-columns:repeat(12,1fr);gap:0 32px}
.feat:nth-child(1){grid-column:1/span 5}
.feat:nth-child(2){grid-column:7/span 3;margin-top:clamp(64px,9vw,136px)}
.feat:nth-child(3){grid-column:10/span 3;margin-top:clamp(128px,18vw,272px)}}
.feat{border-top:1px solid var(--ink);padding-top:22px}
.fn{display:block;font:italic 400 clamp(64px,7vw,108px)/.85 var(--af);color:var(--p);margin-bottom:34px;letter-spacing:-.03em}
.feat h3{font-size:clamp(24px,2.3vw,34px);line-height:1.08;letter-spacing:-.015em;margin-bottom:14px}
.feat p{color:var(--muted);max-width:38ch;font-size:16px}
.feat:nth-child(1) h3{font-size:clamp(28px,3vw,44px)}

.story{background:var(--surface);padding:clamp(88px,11vw,168px) 0;border-block:1px solid var(--line)}
.story-g{display:grid;gap:48px;align-items:start}
@media(min-width:900px){.story-g{grid-template-columns:5fr 7fr;gap:clamp(48px,7vw,112px)}}
.sfig{position:relative}
.sf-img{aspect-ratio:4/5;overflow:hidden;background:var(--deep)}
.sf-img img{width:100%;height:100%;object-fit:cover;transform:scale(1.45);transform-origin:70% 38%;filter:saturate(.85)}
.sfig figcaption{display:flex;justify-content:space-between;gap:16px;font:500 11.5px/1.4 var(--bf);letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin-top:12px}
.smono{aspect-ratio:4/5;display:grid;place-items:center;background:var(--pr);color:var(--on-p);font:var(--hw) clamp(120px,16vw,240px)/1 var(--hf);letter-spacing:-.04em;position:relative;overflow:hidden}
.smono::after{content:"";position:absolute;inset:0;background-image:${GRAIN};opacity:.3;mix-blend-mode:overlay}
.story h2{font-size:clamp(34px,4vw,58px);line-height:1.02;letter-spacing:-.02em;margin:22px 0 32px;max-width:16ch}
.lead{font:400 clamp(21px,2vw,27px)/1.45 var(--af);letter-spacing:-.005em}
.lead.dc::first-letter{float:left;font:var(--hw) 4.4em/.78 var(--hf);padding:.08em .12em 0 0;color:var(--p)}
.story-b{margin-top:26px;color:var(--muted);max-width:58ch}
.filed{margin-top:36px;display:flex;flex-wrap:wrap;gap:8px 10px;align-items:center;font-size:13px}
.filed>span:first-child{font:650 11px/1 var(--bf);letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-right:6px}
.chip{padding:6px 12px;border:1px solid var(--line);border-radius:999px;background:var(--bg)}

.menu{padding:clamp(96px,12vw,176px) 0}
.menu-h{display:grid;gap:28px;align-items:end;padding-bottom:36px;border-bottom:1px solid var(--ink)}
@media(min-width:900px){.menu-h{grid-template-columns:7fr 5fr}}
.menu-h h2{font-size:clamp(44px,6.4vw,96px);line-height:.95;letter-spacing:-.03em;margin-top:22px}
.menu-h .pv{justify-self:start}
@media(min-width:900px){.menu-h .pv{justify-self:end;text-align:left}}
.ml{list-style:none;margin:0;padding:0;display:grid;column-gap:72px}
@media(min-width:900px){.ml{grid-template-columns:1fr 1fr}}
.mi{display:grid;grid-template-columns:44px 1fr;gap:14px;padding:26px 0;border-bottom:1px solid var(--line)}
.mi-n{font:italic 400 17px/1.5 var(--af);color:var(--p)}
.mi-t{display:flex;align-items:baseline;gap:14px}
.mi h3{font-size:clamp(21px,1.8vw,25px);line-height:1.2;letter-spacing:-.01em}
.dots{flex:1;border-bottom:1px dotted var(--muted);transform:translateY(-6px);min-width:24px}
.price{font:600 15px/1 var(--bf);font-variant-numeric:tabular-nums}
.mi p{color:var(--muted);font-size:15.5px;line-height:1.55;margin-top:6px;max-width:48ch}

.visit{padding:0 0 clamp(96px,12vw,176px)}
.visit-g{display:grid;gap:56px;align-items:start}
@media(min-width:960px){.visit-g{grid-template-columns:5fr 7fr;gap:clamp(48px,6vw,96px)}}
.visit h2{font-size:clamp(40px,5vw,76px);line-height:.98;letter-spacing:-.028em;margin:22px 0 14px}
.addr{color:var(--muted);font-size:17px;margin-bottom:34px}
.vi .btns{margin-top:34px}
.vi .btn-o{color:var(--ink)}
.map-v{border-radius:2px}
.map .tiles img{filter:grayscale(1) contrast(1.06) brightness(1.02)}
.map .tint{background:var(--pr);mix-blend-mode:soft-light;opacity:.55}

.foot{background:var(--ink);color:var(--bg);padding:clamp(72px,9vw,128px) 0 40px;overflow:hidden}
.foot a{color:inherit;text-underline-offset:4px}
.foot-g{display:grid;gap:36px;font-size:15px}
@media(min-width:760px){.foot-g{grid-template-columns:repeat(3,1fr)}}
.foot-g>div{display:grid;gap:8px;align-content:start}
.fl{font:650 11px/1 var(--bf);letter-spacing:.2em;text-transform:uppercase;opacity:.6;margin-bottom:6px}
.fh span{display:block}
.fh-n{font:var(--hw) 1em/1 var(--hf);display:block;letter-spacing:-.035em;line-height:.9;margin:clamp(56px,8vw,112px) 0 0;white-space:nowrap}
`;

function editorialBody(c: Ctx): string {
  const hs = sizeClass(c.headline);
  const h1Size = fitSize(c.headline, c.headK, {
    min: 50,
    vw: hs === "s1" ? 9.6 : hs === "s2" ? 7.8 : hs === "s3" ? 6.2 : 4.8,
    max: hs === "s1" ? 150 : hs === "s2" ? 120 : hs === "s3" ? 94 : 74,
  });
  const deck = c.tagline;
  const intro = deck
    ? `<section class="intro"><div class="wrap intro-g"><p class="folio rv"><b>${esc(c.name)}</b>${esc(c.catLabel)}${c.street ? `<br>${esc(c.street)}` : ""}</p><p class="deck rv" style="--d:1">${esc(deck)}</p></div></section>`
    : "";
  const feats = c.highlights.length
    ? `<section class="feats"${intro ? "" : ' style="padding-top:clamp(80px,11vw,160px)"'}><div class="wrap feats-g">${c.highlights
        .map(
          (h, i) =>
            `<article class="feat rv" style="--d:${i}"><span class="fn" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><h3>${esc(h.title)}</h3><p>${esc(h.text)}</p></article>`,
        )
        .join("")}</div></section>`
    : "";
  const fig = c.hero
    ? `<figure class="sfig rv"><div class="sf-img"><img src="${esc(c.hero)}" alt="" loading="lazy" decoding="async"></div><figcaption><span>${esc(c.name)}</span><span>Detail · illustrative</span></figcaption></figure>`
    : `<div class="smono rv" aria-hidden="true">${esc(c.initials)}</div>`;
  const chips = c.keywords.length
    ? `<p class="filed rv"><span>Filed under</span>${c.keywords
        .slice(0, 6)
        .map((k) => `<span class="chip">${esc(k)}</span>`)
        .join("")}</p>`
    : "";
  let secN = 0;
  const secLabel = (word: string, title: string) => {
    secN++;
    const n = `Nº ${String(secN).padStart(2, "0")}`;
    const w = word.replace(/^the\s+/i, "");
    return `<p class="label rv">${esc(title.toLowerCase().includes(w.toLowerCase()) ? n : `${n} · ${word}`)}</p>`;
  };
  const story = c.about
    ? `<section class="story" id="story"><div class="wrap story-g">${fig}<div>${secLabel("The story", c.name)}<h2 class="rv">${esc(c.name)}</h2><p class="lead rv${c.about.length > 140 ? " dc" : ""}">${esc(c.about)}</p>${c.story ? `<p class="story-b rv">${esc(c.story)}</p>` : ""}${chips}</div></div></section>`
    : "";
  const menu = c.offerings.length
    ? `<section class="menu" id="menu"><div class="wrap"><div class="menu-h"><div>${secLabel(c.navMenu, c.offTitle)}<h2 class="rv">${esc(c.offTitle)}</h2></div>${previewNote(c, "pv rv")}</div><ol class="ml">${c.offerings
        .map(
          (o, i) =>
            `<li class="mi rv" style="--d:${i % 2}"><span class="mi-n" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><div><div class="mi-t"><h3>${esc(o.name)}</h3>${o.price ? `<span class="dots"></span><span class="price">${esc(o.price)}</span>` : ""}</div>${o.description ? `<p>${esc(o.description)}</p>` : ""}</div></li>`,
        )
        .join("")}</ol></div></section>`
    : "";
  const map = mapBlock(c, "rv");
  const visit = `<section class="visit" id="visit"${c.offerings.length ? "" : ' style="padding-top:clamp(96px,12vw,176px)"'}><div class="wrap visit-g"${map ? "" : ' style="grid-template-columns:1fr"'}><div class="vi">${secLabel("Visit", c.street || c.cta)}<h2 class="rv">${esc(c.street || c.cta)}</h2>${c.address ? `<p class="addr rv">${esc(c.address)}</p>` : '<p class="addr rv">Address — owner to confirm</p>'}<div class="rv">${hoursBlock(c)}</div><div class="btns rv">${visitButtons(c, "btn", "btn btn-o")}</div></div>${map}</div></section>`;
  const nameSize = fitLine(c.name, c.headK * 1.04, { min: 40, vw: 18, max: 260, col: 1220 });
  const foot = `<footer class="foot"><div class="wrap"><div class="foot-g">${footCols(c)}</div><p class="fh-n" style="${nameSize}" aria-hidden="true">${esc(c.name)}</p>${footMeta(c)}</div></footer>`;

  return `<header class="hero" id="top">${heroMedia(c)}<div class="scrim"></div>
<nav class="nav wrap" aria-label="Site"><a class="bm" href="#top"><span class="mono">${esc(c.initials)}</span><span>${esc(c.name)}</span></a><div class="links">${navLinks(c)}</div><a class="nav-cta" href="#visit">${esc(c.cta)}</a></nav>
<div class="hero-in wrap"><p class="kicker">${c.kicker.map((k) => `<span>${esc(k)}</span>`).join("")}</p><h1 style="${h1Size}">${emLast(c.headline)}</h1><div class="hero-row">${c.sub ? `<p class="sub">${esc(c.sub)}</p>` : "<span></span>"}<div class="btns">${heroButtons(c, "btn btn-w", "btn btn-o")}</div></div></div>${heroCaption(c)}</header>
<main>${intro}${feats}${story}${menu}${visit}</main>${foot}`;
}

/* ────────────────────────────── theme: BOLD ────────────────────────────── */

const BOLD_CSS = `
body{font-size:17px}
.hero{position:relative;min-height:clamp(640px,96svh,1000px);overflow:hidden;color:#fff;isolation:isolate;display:flex;flex-direction:column}
.hm img{filter:grayscale(1) contrast(1.18) brightness(.98)}
.tone{position:absolute;inset:0;z-index:-1;background:var(--tone);mix-blend-mode:multiply;opacity:.92}
.gen~.tone{display:none}
.scrim{position:absolute;inset:0;z-index:-1;background:linear-gradient(180deg,rgba(0,0,0,.42) 0%,rgba(0,0,0,0) 28%,rgba(0,0,0,0) 50%,rgba(0,0,0,.58) 100%)}
.nav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding-block:20px;position:relative;z-index:2}
.bm{display:flex;align-items:center;gap:12px;text-decoration:none;font:var(--hw) 18px/1 var(--hf);text-transform:uppercase;letter-spacing:.01em;min-width:0}
.bm span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mono{flex:none;width:40px;height:40px;background:var(--ar);color:var(--on-a);display:grid;place-items:center;font:var(--hw) 14px/1 var(--hf)}
.links{display:none;gap:6px}
.links a{text-decoration:none;font:700 13px/1 var(--bf);text-transform:uppercase;letter-spacing:.08em;padding:11px 14px;border:2px solid transparent;transition:border-color .2s}
.links a:hover{border-color:#fff}
@media(min-width:880px){.links{display:flex}}
.nav-cta{flex:none;display:inline-flex;align-items:center;height:44px;padding:0 18px;background:#fff;color:#111;text-decoration:none;font:800 13px/1 var(--bf);text-transform:uppercase;letter-spacing:.06em;transition:background .2s,color .2s}
.nav-cta:hover{background:var(--ar);color:var(--on-a)}
.hero-in{margin-top:auto;padding-bottom:clamp(36px,5vw,64px);position:relative;z-index:2}
.kicker{display:inline-flex;flex-wrap:wrap;gap:0;margin-bottom:22px;font:800 12px/1 var(--bf);text-transform:uppercase;letter-spacing:.12em}
.kicker span{padding:9px 12px;background:#fff;color:#111}
.kicker span:nth-child(2){background:var(--ar);color:var(--on-a)}
.kicker span:nth-child(3){background:transparent;color:#fff;box-shadow:inset 0 0 0 2px #fff}
.hero h1{text-transform:uppercase;line-height:.86;letter-spacing:-.035em;max-width:none}
.hero h1 em{font-style:normal;color:var(--hem)}
.hero-row{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:24px 48px;margin-top:30px}
.sub{max-width:40ch;font-size:clamp(17px,1.5vw,21px);line-height:1.45;font-weight:500}
.btns{display:flex;flex-wrap:wrap;gap:12px}
.btn{display:inline-flex;align-items:center;gap:10px;min-height:54px;padding:0 24px;background:var(--pr);color:var(--on-p);text-decoration:none;font:800 14.5px/1 var(--bf);text-transform:uppercase;letter-spacing:.06em;border:0;box-shadow:5px 5px 0 var(--ink);transition:transform .15s,box-shadow .15s}
.btn:hover{transform:translate(-2px,-2px);box-shadow:7px 7px 0 var(--ink)}
.btn:active{transform:translate(3px,3px);box-shadow:2px 2px 0 var(--ink)}
.btn-a{background:var(--ar);color:var(--on-a);box-shadow:5px 5px 0 #000}
.btn-a:hover{box-shadow:7px 7px 0 #000}
.btn-w{background:#fff;color:#111;box-shadow:5px 5px 0 #000}
.btn-w:hover{box-shadow:7px 7px 0 #000}
.btn-ink{background:var(--ink);color:var(--bg);box-shadow:5px 5px 0 var(--ar)}
.btn-ink:hover{box-shadow:7px 7px 0 var(--ar)}
.btn-line{background:transparent;color:inherit;box-shadow:inset 0 0 0 2px currentColor}
.btn-line:hover{box-shadow:inset 0 0 0 2px currentColor,5px 5px 0 currentColor}
.spin{position:absolute;right:clamp(16px,4vw,56px);top:clamp(96px,14vh,150px);width:clamp(104px,11vw,156px);height:auto;z-index:2;color:#fff}
.spin .ring{transform-origin:100px 100px;animation:spin 26s linear infinite}
.spin text{font:800 12.5px/1 var(--bf);letter-spacing:.24em;text-transform:uppercase;fill:currentColor}
.spin .core{fill:var(--ar)}
.spin .ci{font:var(--hw) 40px/1 var(--hf);fill:var(--on-a);letter-spacing:0}
@keyframes spin{to{transform:rotate(1turn)}}
@media(max-width:640px){.spin{display:none}}

.mq{overflow:hidden;background:var(--ar);color:var(--on-a);border-block:3px solid var(--ink);user-select:none}
.mq-t{display:flex;width:max-content;animation:mq 42s linear infinite}
.mq-t>span{font:var(--hw) clamp(30px,4.8vw,72px)/1 var(--hf);text-transform:uppercase;white-space:pre;padding:.3em 0;letter-spacing:-.01em}
.mq-t i{font-style:normal;display:inline-block;margin:0 .45em;transform:translateY(-.06em);opacity:.9}
.mq.rev{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.mq.rev .mq-t{animation-direction:reverse;animation-duration:54s}
.mq.rev i{color:var(--ar)}
@keyframes mq{to{transform:translateX(-50%)}}

.about{padding:clamp(88px,11vw,168px) 0}
.about-g{display:grid;gap:40px}
@media(min-width:960px){.about-g{grid-template-columns:2fr 10fr;gap:48px}}
.tag{align-self:start;justify-self:start;display:inline-block;font:800 12px/1 var(--bf);text-transform:uppercase;letter-spacing:.14em;padding:10px 12px;background:var(--ink);color:var(--bg);transform:rotate(-3deg)}
.big{font:var(--hw) clamp(30px,4.3vw,66px)/1.02 var(--hf);letter-spacing:-.025em;max-width:22ch}
.big-l{font-size:clamp(26px,3.3vw,50px);line-height:1.04}
.big::after{content:"";display:block;width:clamp(72px,9vw,120px);height:10px;background:var(--ar);margin-top:clamp(28px,3vw,44px)}
.about-s{margin-top:clamp(28px,3vw,44px);max-width:56ch}
.about-s p{font-size:clamp(17px,1.4vw,19px);line-height:1.6;font-weight:500}

.blocks{display:grid}
@media(min-width:900px){.blocks{grid-template-columns:repeat(3,1fr)}}
.blk{padding:clamp(32px,4vw,56px);min-height:clamp(340px,34vw,500px);display:flex;flex-direction:column;justify-content:space-between;gap:56px;position:relative;overflow:hidden}
.blk:nth-child(1){background:var(--pr);color:var(--on-p)}
.blk:nth-child(2){background:var(--b2);color:var(--on-b2)}
.blk:nth-child(3){background:var(--ink);color:var(--bg)}
.blk-n{font:var(--hw) clamp(96px,11vw,176px)/.78 var(--hf);letter-spacing:-.05em;opacity:.95}
.blk h3{font-size:clamp(28px,2.7vw,42px);line-height:.95;text-transform:uppercase;letter-spacing:-.02em;margin-bottom:16px}
.blk p{font-size:17px;line-height:1.5;max-width:34ch;opacity:.92}

.menu{padding:clamp(88px,11vw,168px) 0}
.menu-h{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:flex-end;gap:28px;margin-bottom:clamp(40px,5vw,72px)}
.menu-h h2{font-size:clamp(52px,8vw,132px);line-height:.84;text-transform:uppercase;letter-spacing:-.04em}
.menu-h .pv{max-width:380px;transform:rotate(2deg);background:var(--ar);color:var(--on-a);padding:18px 20px;box-shadow:6px 6px 0 var(--ink)}
.menu-h .pv-tag{border-color:currentColor}
.menu-h .pv-dot{background:currentColor}
.menu-h .pv p{opacity:.9}
.mg{list-style:none;margin:0;padding:0;display:grid;gap:0;border-top:3px solid var(--ink);border-left:3px solid var(--ink)}
@media(min-width:640px){.mg{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1000px){.mg{grid-template-columns:repeat(3,1fr)}}
.mc{border-right:3px solid var(--ink);border-bottom:3px solid var(--ink);padding:28px 26px 30px;display:flex;flex-direction:column;gap:12px;transition:background .2s,color .2s}
@media(min-width:640px){.mc{min-height:220px}}
.mc:hover{background:var(--pr);color:var(--on-p)}
.mc-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;font:800 13px/1 var(--bf);letter-spacing:.1em}
.mc-top .price{padding:6px 9px;background:var(--ink);color:var(--bg);letter-spacing:.02em}
.mc h3{font-size:clamp(24px,2.1vw,32px);line-height:.98;text-transform:uppercase;letter-spacing:-.015em}
.mc p{font-size:15.5px;line-height:1.5;opacity:.85}

.visit{background:var(--pr);color:var(--on-p);padding:clamp(88px,11vw,160px) 0;border-top:3px solid var(--ink)}
.visit-g{display:grid;gap:56px;align-items:start}
@media(min-width:960px){.visit-g{grid-template-columns:6fr 6fr;gap:clamp(48px,6vw,96px)}}
.visit h2{font-size:clamp(64px,10vw,168px);line-height:.82;text-transform:uppercase;letter-spacing:-.045em}
.addr{font:700 clamp(18px,1.6vw,22px)/1.35 var(--bf);margin:24px 0 32px}
.visit .ht th,.visit .ht td{border-color:currentColor;border-color:rgba(127,127,127,.35)}
.visit .ht tr.today th,.visit .ht tr.today td{color:inherit;text-decoration:underline;text-decoration-thickness:2px;text-underline-offset:5px}
.visit .oh{background:transparent;border:2px solid currentColor;border-radius:0;color:inherit}
.visit .btns{margin-top:36px}
.map-v{border:3px solid var(--ink);box-shadow:10px 10px 0 var(--ink)}
.map .tiles img{filter:grayscale(1) contrast(1.25) brightness(1.05)}
.map .tint{background:var(--tone);mix-blend-mode:multiply;opacity:.55}
.map .pin{border-radius:0;background:var(--ar);border-color:var(--ink);width:22px;height:22px;margin:-11px 0 0 -11px;transform:rotate(45deg)}
.map .pin::after{border-radius:0;border-color:var(--ar)}
.map .pin-l{border-radius:0;font-weight:800;text-transform:uppercase;letter-spacing:.06em}
.map figcaption{opacity:.8}

.foot{background:var(--ink);color:var(--bg);padding:clamp(64px,8vw,112px) 0 40px;overflow:hidden}
.foot a{color:inherit;text-underline-offset:4px}
.fh-n{font:var(--hw) 1em/1 var(--hf);text-transform:uppercase;letter-spacing:-.045em;line-height:.84;margin:0 0 clamp(48px,6vw,80px);color:var(--fa);white-space:nowrap}
.foot-g{display:grid;gap:36px;font-size:15px}
@media(min-width:760px){.foot-g{grid-template-columns:repeat(3,1fr)}}
.foot-g>div{display:grid;gap:8px;align-content:start}
.fl{font:800 12px/1 var(--bf);letter-spacing:.14em;text-transform:uppercase;color:var(--fa);margin-bottom:6px}
.fh span{display:block}
`;

function marquee(items: string[], cls = ""): string {
  const unit = items.map((t) => `${esc(t)}<i>✦</i>`).join("");
  const unitLen = items.join("   ").length + items.length * 3;
  const reps = Math.max(1, Math.ceil(70 / Math.max(8, unitLen)));
  const half = unit.repeat(reps);
  return `<div class="mq ${cls}" aria-hidden="true"><div class="mq-t"><span>${half}</span><span>${half}</span></div></div>`;
}

function boldBody(c: Ctx): string {
  const hs = sizeClass(c.headline);
  const h1Size = fitSize(c.headline.toUpperCase(), c.headK, {
    min: 68,
    vw: hs === "s1" ? 13.5 : hs === "s2" ? 10 : hs === "s3" ? 7.4 : 5.6,
    max: hs === "s1" ? 236 : hs === "s2" ? 176 : hs === "s3" ? 128 : 96,
    col: 1300,
  });
  const ringUnit = `${c.name.slice(0, 26)} ✦ Concept preview ✦ `;
  const ringText = ringUnit.repeat(Math.max(1, Math.round(46 / ringUnit.length)));
  const spin = `<svg class="spin" viewBox="0 0 200 200" aria-hidden="true"><defs><path id="ring-p" d="M100,100 m-78,0 a78,78 0 1,1 156,0 a78,78 0 1,1 -156,0"/></defs><g class="ring"><text><textPath href="#ring-p" textLength="486" lengthAdjust="spacing">${esc(ringText)}</textPath></text></g><circle class="core" cx="100" cy="100" r="44"/><text class="ci" x="100" y="101" text-anchor="middle" dominant-baseline="central">${esc(c.initials)}</text></svg>`;

  const mqItems = (c.keywords.length >= 3 ? c.keywords : c.offerings.map((o) => o.name)).slice(0, 6);
  const mq1 = marquee(mqItems.length >= 2 ? mqItems : [c.name, c.catLabel, c.street || c.cta].filter(Boolean));
  const mq2 = marquee([c.name, c.cta, c.street || c.catLabel].filter(Boolean), "rev");

  const about = c.about
    ? `<section class="about" id="story"><div class="wrap about-g"><span class="tag rv">The story</span><div><p class="big rv${c.about.length > 200 ? " big-l" : ""}">${esc(c.about)}</p>${c.story ? `<div class="about-s rv" style="--d:1"><p>${esc(c.story)}</p></div>` : ""}</div></div></section>`
    : "";
  const blocks = c.highlights.length
    ? `<section class="blocks" aria-label="Highlights">${c.highlights
        .map(
          (h, i) =>
            `<article class="blk"><span class="blk-n rv" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span><div class="rv" style="--d:1"><h3>${esc(h.title)}</h3><p>${esc(h.text)}</p></div></article>`,
        )
        .join("")}</section>`
    : "";
  const menu = c.offerings.length
    ? `<section class="menu" id="menu"><div class="wrap"><div class="menu-h"><h2 class="rv">${esc(c.offTitle)}</h2>${previewNote(c, "pv rv")}</div><ol class="mg">${c.offerings
        .map(
          (o, i) =>
            `<li class="mc rv" style="--d:${i % 3}"><div class="mc-top"><span>${String(i + 1).padStart(2, "0")}</span>${o.price ? `<span class="price">${esc(o.price)}</span>` : ""}</div><h3>${esc(o.name)}</h3>${o.description ? `<p>${esc(o.description)}</p>` : ""}</li>`,
        )
        .join("")}</ol></div></section>`
    : "";
  const map = mapBlock(c, "rv");
  const visit = `<section class="visit" id="visit"><div class="wrap visit-g"${map ? "" : ' style="grid-template-columns:1fr"'}><div><h2 class="rv">Find us</h2>${c.address ? `<p class="addr rv">${esc(c.address)}</p>` : '<p class="addr rv">Address — owner to confirm</p>'}<div class="rv">${hoursBlock(c)}</div><div class="btns rv">${visitButtons(c, "btn btn-ink", "btn btn-line")}</div></div>${map}</div></section>`;
  const nameSize = fitLine(c.name.toUpperCase(), c.headK * 1.04, { min: 44, vw: 19, max: 300, col: 1220 });
  const foot = `<footer class="foot"><div class="wrap"><p class="fh-n" style="${nameSize}" aria-hidden="true">${esc(c.name)}</p><div class="foot-g">${footCols(c)}</div>${footMeta(c)}</div></footer>`;

  return `<header class="hero" id="top">${heroMedia(c)}${c.video ? "" : '<div class="tone"></div>'}<div class="scrim"></div>
<nav class="nav wrap" aria-label="Site"><a class="bm" href="#top"><span class="mono">${esc(c.initials)}</span><span>${esc(c.name)}</span></a><div class="links">${navLinks(c)}</div><a class="nav-cta" href="#visit">${esc(c.cta)}</a></nav>
${spin}
<div class="hero-in wrap"><p class="kicker">${c.kicker.map((k) => `<span>${esc(k)}</span>`).join("")}</p><h1 style="${h1Size}">${emLast(c.headline)}</h1><div class="hero-row">${c.sub ? `<p class="sub">${esc(c.sub)}</p>` : "<span></span>"}<div class="btns">${heroButtons(c, "btn btn-a", "btn btn-w")}</div></div></div>${heroCaption(c)}</header>
${mq1}<main>${about}${blocks}${menu}${mq2}${visit}</main>${foot}`;
}

/* ────────────────────────────── theme: WARM ────────────────────────────── */

const WARM_CSS = `
body{font-size:17.5px}
.hero{position:relative;margin:10px;border-radius:clamp(22px,3vw,40px);height:clamp(600px,90svh,920px);overflow:hidden;color:#fff;isolation:isolate;display:flex;flex-direction:column;box-shadow:0 30px 60px -40px rgba(60,40,20,.5)}
@media(min-width:768px){.hero{margin:14px}}
.hm img{filter:saturate(1.04) sepia(.08)}
.scrim{position:absolute;inset:0;z-index:-1;background:radial-gradient(70% 55% at 50% 72%,rgba(20,12,6,.42),rgba(20,12,6,0) 70%),linear-gradient(180deg,rgba(20,12,6,.3) 0%,rgba(20,12,6,0) 30%,rgba(20,12,6,.12) 55%,rgba(20,12,6,.7) 100%)}
.nav{position:relative;z-index:2;margin:14px auto 0;width:min(1180px,calc(100% - 28px));display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 8px 8px 10px;border-radius:999px;background:var(--navbg);color:var(--ink);-webkit-backdrop-filter:blur(14px) saturate(1.3);backdrop-filter:blur(14px) saturate(1.3);box-shadow:0 10px 30px -18px rgba(40,25,10,.5)}
.bm{display:flex;align-items:center;gap:10px;text-decoration:none;font:var(--hw) 18px/1 var(--hf);letter-spacing:-.01em;min-width:0}
.bm span:last-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.mono{flex:none;width:36px;height:36px;border-radius:50%;background:var(--pr);color:var(--on-p);display:grid;place-items:center;font:700 12.5px/1 var(--bf)}
.links{display:none;gap:4px}
.links a{text-decoration:none;font:650 14.5px/1 var(--bf);padding:10px 14px;border-radius:999px;transition:background .2s}
.links a:hover{background:var(--t1)}
@media(min-width:880px){.links{display:flex}}
.nav-cta{flex:none;display:inline-flex;align-items:center;height:42px;padding:0 18px;border-radius:999px;background:var(--pr);color:var(--on-p);text-decoration:none;font:700 14px/1 var(--bf);transition:transform .2s}
.nav-cta:hover{transform:translateY(-1px)}
.hero-in{margin-top:auto;padding-bottom:clamp(40px,6vw,80px);position:relative;z-index:2;text-align:center;display:flex;flex-direction:column;align-items:center}
.hand{font:600 clamp(26px,3vw,40px)/1.05 var(--af);color:var(--hand);transform:rotate(-3deg);margin-bottom:14px;max-width:26ch;text-wrap:balance}
.hero h1{line-height:1;letter-spacing:-.025em;max-width:16ch}
.hero h1 em{font-style:italic;color:var(--hand)}
.sub{max-width:46ch;font-size:clamp(17px,1.5vw,20px);line-height:1.5;margin-top:22px;opacity:.95}
.btns{display:flex;flex-wrap:wrap;gap:12px;justify-content:center}
.hero .btns{margin-top:32px}
.btn{display:inline-flex;align-items:center;gap:10px;min-height:52px;padding:0 26px;border-radius:999px;background:var(--pr);color:var(--on-p);text-decoration:none;font:700 15.5px/1 var(--bf);border:0;box-shadow:0 10px 24px -12px rgba(60,35,10,.55);transition:transform .25s cubic-bezier(.2,.7,.2,1),box-shadow .25s}
.btn:hover{transform:translateY(-2px);box-shadow:0 16px 30px -12px rgba(60,35,10,.55)}
.btn .ic{transition:transform .25s}.btn:hover .ic{transform:translateX(3px)}
.btn-c{background:#fffaf1;color:#2a1d12}
.btn-g{background:rgba(255,255,255,.14);color:#fff;box-shadow:inset 0 0 0 1.5px rgba(255,255,255,.7);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}
.btn-s{background:var(--paper);color:var(--ink);box-shadow:inset 0 0 0 1.5px var(--line)}
.btn-s:hover{box-shadow:inset 0 0 0 1.5px var(--p)}
.kick{font:600 clamp(24px,2.4vw,32px)/1 var(--af);color:var(--p);display:inline-block;transform:rotate(-2deg)}
.sec-h{text-align:center;display:grid;justify-items:center;gap:8px;margin-bottom:clamp(40px,5vw,64px)}
.sec-h h2{font-size:clamp(38px,5vw,68px);line-height:1.02;letter-spacing:-.025em;max-width:18ch}
.squig{width:120px;height:14px;color:var(--a);margin-top:6px}

.feats{padding:clamp(80px,10vw,144px) 0 clamp(40px,5vw,72px)}
.cards{display:grid;gap:18px}
@media(min-width:900px){.cards{grid-template-columns:repeat(3,1fr);gap:22px}}
.card{border-radius:28px;padding:clamp(28px,3vw,40px);display:flex;flex-direction:column;gap:14px;min-height:280px;transition:transform .35s cubic-bezier(.2,.7,.2,1)}
.card:hover{transform:translateY(-4px) rotate(-.4deg)}
.card:nth-child(1){background:var(--t1)}
.card:nth-child(2){background:var(--t2)}
.card:nth-child(3){background:var(--t3)}
.doodle{width:52px;height:52px;fill:none;stroke:var(--p);stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;margin-bottom:auto}
.card h3{font-size:clamp(24px,2.2vw,30px);line-height:1.1;letter-spacing:-.015em;margin-top:28px}
.card p{font-size:16px;line-height:1.55;color:var(--muted)}

.story{padding:clamp(72px,9vw,136px) 0}
.story-g{display:grid;gap:48px;align-items:center}
@media(min-width:900px){.story-g{grid-template-columns:5fr 6fr;gap:clamp(48px,7vw,104px)}}
.blob{position:relative;aspect-ratio:1;max-width:520px;width:100%;justify-self:center}
.blob-i{position:absolute;inset:0;overflow:hidden;border-radius:58% 42% 54% 46%/47% 55% 45% 53%;animation:morph 16s ease-in-out infinite alternate;background:var(--pr)}
.blob-i img{width:100%;height:100%;object-fit:cover;transform:scale(1.35);transform-origin:40% 55%}
.blob-m{position:absolute;inset:0;display:grid;place-items:center;font:var(--hw) clamp(120px,16vw,220px)/1 var(--hf);color:var(--on-p)}
.blob::before{content:"";position:absolute;inset:-14px;border-radius:44% 56% 48% 52%/55% 44% 56% 45%;border:2px dashed var(--a);opacity:.55;animation:morph 20s ease-in-out infinite alternate-reverse}
.blob-note{position:absolute;right:-4px;bottom:8%;background:var(--paper);color:var(--ink);padding:12px 18px;border-radius:18px;font:600 24px/1.1 var(--af);transform:rotate(-5deg);box-shadow:0 14px 30px -16px rgba(60,35,10,.5);max-width:62%}
@keyframes morph{0%{border-radius:58% 42% 54% 46%/47% 55% 45% 53%}50%{border-radius:45% 55% 40% 60%/58% 42% 58% 42%}100%{border-radius:52% 48% 62% 38%/42% 60% 40% 58%}}
.story h2{font-size:clamp(36px,4.4vw,60px);line-height:1.04;letter-spacing:-.025em;margin:10px 0 24px}
.lead{font-size:clamp(19px,1.7vw,22px);line-height:1.6}
.story-b{margin-top:20px;color:var(--muted)}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-top:28px}
.chip{padding:8px 14px;border-radius:999px;background:var(--t1);font-size:14px;font-weight:600}
.chip:nth-child(3n+2){background:var(--t2)}.chip:nth-child(3n){background:var(--t3)}

.menu{padding:clamp(72px,9vw,136px) 0;background:var(--surface);border-radius:clamp(28px,4vw,56px);margin:0 10px}
@media(min-width:768px){.menu{margin:0 14px}}
.menu .pv{position:relative;margin:0 auto clamp(36px,4vw,56px);max-width:460px;background:var(--note);color:#2d2416;padding:18px 22px 20px;border-radius:6px 6px 22px 6px;transform:rotate(-1.4deg);box-shadow:0 18px 30px -20px rgba(60,35,10,.55);text-align:left}
.menu .pv::before{content:"";position:absolute;top:-12px;left:50%;width:86px;height:24px;margin-left:-43px;background:rgba(255,255,255,.55);transform:rotate(2deg);border-radius:3px}
.menu .pv-tag{border:0;padding:0;font:700 26px/1 var(--af);letter-spacing:0;text-transform:none}
.menu .pv-dot{display:none}
.menu .pv p{opacity:.85;margin-top:8px}
.mcards{list-style:none;margin:0;padding:0;display:grid;gap:14px}
@media(min-width:640px){.mcards{grid-template-columns:repeat(2,1fr)}}
@media(min-width:1040px){.mcards{grid-template-columns:repeat(3,1fr)}}
.mc{background:var(--paper);border-radius:22px;padding:24px 24px 26px;box-shadow:0 1px 0 var(--line),0 18px 32px -28px rgba(60,35,10,.5);display:flex;flex-direction:column;gap:8px;transition:transform .3s cubic-bezier(.2,.7,.2,1)}
.mc:hover{transform:translateY(-3px)}
.mc-t{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.mc h3{font-size:21px;line-height:1.2;letter-spacing:-.01em}
.mc .price{flex:none;font-weight:700;color:var(--p);font-size:15px}
.mc p{font-size:15.5px;line-height:1.55;color:var(--muted)}

.visit{padding:clamp(72px,9vw,136px) 0}
.vcard{display:grid;gap:0;background:var(--paper);border-radius:clamp(26px,3vw,40px);overflow:hidden;box-shadow:0 1px 0 var(--line),0 40px 70px -50px rgba(60,35,10,.55)}
@media(min-width:960px){.vcard{grid-template-columns:5fr 6fr}}
.vi{padding:clamp(32px,4.5vw,64px)}
.visit h2{font-size:clamp(34px,4vw,54px);line-height:1.04;letter-spacing:-.02em;margin:8px 0 12px}
.addr{color:var(--muted);margin-bottom:28px}
.vi .btns{justify-content:flex-start;margin-top:30px}
.vcard .map{height:100%}
.vcard .map-v{height:100%;min-height:340px}
.vcard .map figcaption{position:absolute;left:12px;bottom:10px;margin:0;background:rgba(255,252,246,.88);padding:4px 10px;border-radius:999px;color:#3a2e22;opacity:1;font-size:11px}
.map .tiles img{filter:sepia(.28) saturate(.9) brightness(1.02)}
.map .tint{background:var(--pr);mix-blend-mode:multiply;opacity:.08}
.map .pin-l{border-radius:999px}

.foot{position:relative;background:var(--foot);color:var(--on-foot);padding:clamp(56px,7vw,96px) 0 40px;margin-top:clamp(40px,5vw,72px)}
.foot a{color:inherit;text-underline-offset:4px}
.wave{position:absolute;left:0;right:0;top:-38px;height:40px;width:100%;color:var(--foot)}
.foot-top{display:grid;gap:12px;justify-items:center;text-align:center;margin-bottom:clamp(40px,5vw,64px)}
.fh-n{font:var(--hw) clamp(40px,6vw,88px)/1 var(--hf);letter-spacing:-.025em}
.foot .kick{color:inherit;opacity:.85}
.foot-g{display:grid;gap:32px;font-size:15px}
@media(min-width:760px){.foot-g{grid-template-columns:repeat(3,1fr)}}
.foot-g>div{display:grid;gap:8px;align-content:start}
.fl{font:600 22px/1 var(--af);opacity:.85;margin-bottom:4px}
.fh span{display:block}
`;

function warmBody(c: Ctx): string {
  const hs = sizeClass(c.headline);
  const h1Size = fitSize(c.headline, c.headK, {
    min: 46,
    vw: hs === "s1" ? 8.6 : hs === "s2" ? 7 : hs === "s3" ? 5.6 : 4.4,
    max: hs === "s1" ? 132 : hs === "s2" ? 108 : hs === "s3" ? 84 : 66,
  });
  const squig =
    '<svg class="squig" viewBox="0 0 120 14" aria-hidden="true"><path d="M2 8c9-7 16 5 25-1s16-6 24 0 16 6 24 0 16-6 24 0 11 4 19-1" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';

  const feats = c.highlights.length
    ? `<section class="feats"><div class="wrap"><div class="sec-h"><span class="kick rv">the good stuff</span><h2 class="rv">${esc(`Why ${shortName(c.name)}`)}</h2><span class="rv">${squig}</span></div><div class="cards">${c.highlights
        .map(
          (h, i) =>
            `<article class="card rv" style="--d:${i}">${DOODLES[i % 3]}<h3>${esc(h.title)}</h3><p>${esc(h.text)}</p></article>`,
        )
        .join("")}</div></div></section>`
    : "";
  const blobInner = c.hero
    ? `<div class="blob-i"><img src="${esc(c.hero)}" alt="" loading="lazy" decoding="async"></div>`
    : `<div class="blob-i"><span class="blob-m">${esc(c.initials)}</span></div>`;
  const chips = c.keywords.length
    ? `<div class="chips rv">${c.keywords
        .slice(0, 6)
        .map((k) => `<span class="chip">${esc(k)}</span>`)
        .join("")}</div>`
    : "";
  const story = c.about
    ? `<section class="story" id="story"><div class="wrap story-g"><div class="blob rv">${blobInner}${c.street ? `<span class="blob-note">${esc(c.street)}</span>` : ""}</div><div><span class="kick rv">the story</span><h2 class="rv">${esc(c.name)}</h2><p class="lead rv">${esc(c.about)}</p>${c.story ? `<p class="story-b rv">${esc(c.story)}</p>` : ""}${chips}</div></div></section>`
    : "";
  const menu = c.offerings.length
    ? `<section class="menu" id="menu"><div class="wrap"><div class="sec-h"><span class="kick rv">${esc(c.navMenu.toLowerCase())}</span><h2 class="rv">${esc(c.offTitle)}</h2></div>${previewNote(c, "pv rv")}<ul class="mcards">${c.offerings
        .map(
          (o, i) =>
            `<li class="mc rv" style="--d:${i % 3}"><div class="mc-t"><h3>${esc(o.name)}</h3>${o.price ? `<span class="price">${esc(o.price)}</span>` : ""}</div>${o.description ? `<p>${esc(o.description)}</p>` : ""}</li>`,
        )
        .join("")}</ul></div></section>`
    : "";
  const map = mapBlock(c);
  const visit = `<section class="visit" id="visit"><div class="wrap"><div class="vcard rv"${map ? "" : ' style="grid-template-columns:1fr"'}><div class="vi"><span class="kick">come find us</span><h2>${esc(c.street || c.name)}</h2>${c.address ? `<p class="addr">${esc(c.address)}</p>` : '<p class="addr">Address — owner to confirm</p>'}${hoursBlock(c)}<div class="btns">${visitButtons(c, "btn", "btn btn-s")}</div></div>${map}</div></div></section>`;
  const foot = `<footer class="foot"><svg class="wave" viewBox="0 0 1440 40" preserveAspectRatio="none" aria-hidden="true"><path d="M0 40V22C120 6 240 2 360 12s240 26 360 20 240-26 360-26 240 14 360 18v-6 22Z" fill="currentColor"/></svg><div class="wrap"><div class="foot-top"><span class="kick">see you soon</span><p class="fh-n">${esc(c.name)}</p></div><div class="foot-g">${footCols(c)}</div>${footMeta(c)}</div></footer>`;

  return `<header class="hero" id="top">${heroMedia(c)}<div class="scrim"></div>
<nav class="nav" aria-label="Site"><a class="bm" href="#top"><span class="mono">${esc(c.initials)}</span><span>${esc(c.name)}</span></a><div class="links">${navLinks(c)}</div><a class="nav-cta" href="#visit">${esc(c.cta)}</a></nav>
<div class="hero-in wrap">${c.tagline ? `<p class="hand">${esc(c.tagline)}</p>` : `<p class="hand">${esc(c.kicker.slice(0, 2).join(" · "))}</p>`}<h1 style="${h1Size}">${emLast(c.headline)}</h1>${c.sub ? `<p class="sub">${esc(c.sub)}</p>` : ""}<div class="btns">${heroButtons(c, "btn btn-c", "btn btn-g")}</div></div>${heroCaption(c)}</header>
<main>${feats}${story}${menu}${visit}</main>${foot}`;
}

/* ────────────────────────────── page assembly ────────────────────────────── */

function tokens(c: Ctx): string {
  const p = c.pal;
  const serifFb = 'Georgia,"Times New Roman",serif';
  const sansFb = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  const hFb = SERIF_FONTS.has(c.fontH) ? serifFb : c.theme === "bold" ? `Impact,"Arial Black",${sansFb}` : sansFb;
  const bFb = SERIF_FONTS.has(c.fontB) ? serifFb : sansFb;
  const aFb = c.theme === "warm" ? '"Bradley Hand","Segoe Print",cursive' : SERIF_FONTS.has(c.fontA) ? serifFb : sansFb;
  let extra = "";
  if (c.theme === "bold") {
    const b2 = contrast(p.sr, p.pr) >= 1.3 ? p.sr : mix(p.pr, lum(p.pr) > 0.4 ? "#000000" : "#ffffff", 0.35);
    extra += `--b2:${b2};--on-b2:${onColor(b2, [p.ink, p.bg])};--fa:${ensure(p.ar, p.ink, 3)};--hem:${ensure(p.ar, "#161616", 3.4)};`;
  }
  if (c.theme === "warm") {
    const foot = mix(p.pr, "#000000", lum(p.pr) > 0.35 ? 0.55 : 0.2);
    extra += `--navbg:${rgba(p.paper, 0.93)};--hand:${mix(p.ar, "#ffffff", 0.55)};--note:${mix(p.ar, "#fff6d8", 0.72)};--foot:${foot};--on-foot:${onColor(foot, ["#fbf3e4", p.bg])};`;
  }
  return `:root{--bg:${p.bg};--ink:${p.ink};--muted:${p.muted};--line:${p.line};--surface:${p.surface};--paper:${p.paper};--pr:${p.pr};--p:${p.p};--on-p:${p.onP};--sr:${p.sr};--on-s:${p.onS};--ar:${p.ar};--a:${p.a};--on-a:${p.onA};--deep:${p.deep};--tone:${p.tone};--t1:${p.t1};--t2:${p.t2};--t3:${p.t3};${extra}--hf:"${c.fontH}",${hFb};--bf:"${c.fontB}",${bFb};--af:"${c.fontA}",${aFb};--hw:${c.hw};color-scheme:${lum(p.bg) < 0.25 ? "dark" : "light"}}`;
}

function faviconSvg(letter: string, bg: string, fg: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="${bg}"/><text x="32" y="33" text-anchor="middle" dominant-baseline="central" font-family="Georgia,serif" font-size="${letter.length > 1 ? 26 : 36}" font-weight="700" fill="${fg}">${esc(letter)}</text></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

const SITE_JS = `(function(){var h=document.documentElement;try{
var x=document.getElementById('co-x'),p=document.getElementById('co-pill');
function setMin(m){if(m){h.classList.add('co-min')}else{h.classList.remove('co-min')}try{if(m){sessionStorage.setItem('co-min','1')}else{sessionStorage.removeItem('co-min')}}catch(e){}if(p){p.setAttribute('aria-expanded',m?'false':'true')}}
if(p&&h.classList.contains('co-min')){p.setAttribute('aria-expanded','false')}
if(x){x.addEventListener('click',function(){setMin(true);if(p){p.focus()}})}
if(p){p.addEventListener('click',function(){setMin(false);var c=document.getElementById('co-claim')||document.getElementById('co-x');if(c){c.focus()}})}
var oh=document.getElementById('oh');
if(oh&&window.Intl){var W=JSON.parse(oh.getAttribute('data-w')||'null');if(W&&W.length===7){
var parts=new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',weekday:'short',hour:'numeric',minute:'numeric',hourCycle:'h23'}).formatToParts(new Date());var o={};parts.forEach(function(q){o[q.type]=q.value});
var D=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];var d=D.indexOf(o.weekday);var m=(parseInt(o.hour,10)%24)*60+parseInt(o.minute,10);
if(d>=0){var f=function(v,end){if(end&&v%1440===0){return 'midnight'}v=((v%1440)+1440)%1440;var hh=Math.floor(v/60),mm=v%60,s=hh<12?'AM':'PM',k=hh%12||12;return k+(mm?':'+(mm<10?'0':'')+mm:'')+' '+s};
var until=null,allDay=false;(W[d]||[]).forEach(function(r){if(m>=r[0]&&m<r[1]){until=r[1];if(r[0]===0&&r[1]>=1440){allDay=true}}});
var y=(d+6)%7;(W[y]||[]).forEach(function(r){if(r[1]>1440&&m<r[1]-1440){until=r[1]-1440}});
var t=null;if(until!==null){t=allDay?'Open now · 24 hours':'Open now · until '+f(until,true)}else{var nx=null;(W[d]||[]).forEach(function(r){if(nx===null&&r[0]>m){nx=r[0]}});if(nx!==null){t='Closed now · opens '+f(nx)}else{for(var k2=1;k2<=7;k2++){var dd=(d+k2)%7;if(W[dd]&&W[dd].length){t='Closed now · opens '+(k2===1?'tomorrow':D[dd])+' '+f(W[dd][0][0]);break}}}}
if(t){oh.textContent=t;oh.className='oh '+(until!==null?'is-open':'is-closed');oh.hidden=false}
[].forEach.call(document.querySelectorAll('.ht tr[data-d]'),function(tr){if((','+tr.getAttribute('data-d')+',').indexOf(','+d+',')>-1){tr.className='today'}});}}}
var els=[].slice.call(document.querySelectorAll('.rv'));
var rm=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
if(rm||!('IntersectionObserver' in window)){els.forEach(function(e){e.classList.add('in')})}else{
var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{rootMargin:'0px 0px -6% 0px',threshold:0.06});
els.forEach(function(e){io.observe(e)})}
}catch(err){[].forEach.call(document.querySelectorAll('.rv'),function(e){e.classList.add('in')})}})();`;

const HEAD_JS = `(function(){var h=document.documentElement;h.classList.add('js');try{if(sessionStorage.getItem('co-min')==='1'){h.classList.add('co-min')}}catch(e){}})();`;

function assembleSite(c: Ctx): string {
  const site = c.biz.site as SiteSpec;
  const title = clean(site.seo && site.seo.title, 90) || `${c.name} — ${c.catLabel}`;
  const desc = clean(site.seo && site.seo.description, 200) || c.sub || c.about.slice(0, 180);
  const url = `${c.base}/s/${encodeURIComponent(c.id)}`;
  const ogImg = c.hero ? absUrl(c.base, c.hero) : "";
  const families = [c.fontH, c.fontB, c.fontA];
  const themeCss = c.theme === "bold" ? BOLD_CSS : c.theme === "warm" ? WARM_CSS : EDITORIAL_CSS;
  const body = c.theme === "bold" ? boldBody(c) : c.theme === "warm" ? warmBody(c) : editorialBody(c);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="robots" content="noindex,nofollow">
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="${c.pal.pr}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Cold Open — concept preview">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
${ogImg ? `<meta property="og:image" content="${esc(ogImg)}"><meta name="twitter:image" content="${esc(ogImg)}">` : ""}
<meta name="twitter:card" content="${ogImg ? "summary_large_image" : "summary"}">
<link rel="icon" href="${faviconSvg(c.initials.slice(0, 1), c.pal.pr, c.pal.onP)}">
${c.hero && !c.video ? `<link rel="preload" as="image" href="${esc(c.hero)}" fetchpriority="high">` : ""}
${fontLinks(families)}
<script>${HEAD_JS}</script>
<style>${tokens(c)}${BASE_CSS}${themeCss}</style>
</head>
<body class="t-${c.theme}">
${banner(c)}
${body}
<script>${SITE_JS}</script>
</body>
</html>`;
}

/* ────────────────────────────── Cold Open utility pages ────────────────────────────── */

const CO_CSS = `
:root{--bg:#0A0A0B;--panel:#121214;--line:#232327;--text:#F4F1EA;--muted:#8A877F;--signal:#FF5B1F;--money:#3DDC84;--warn:#FFC247;color-scheme:dark}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;min-height:100svh;background:var(--bg);color:var(--text);font:400 16px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;display:flex;flex-direction:column;overflow-x:hidden}
a{color:inherit}
p{margin:0;text-wrap:pretty}
h1,h2{margin:0;font-family:"Instrument Serif",Georgia,serif;font-weight:400;letter-spacing:-.02em;text-wrap:balance}
:focus-visible{outline:2px solid var(--signal);outline-offset:3px;border-radius:6px}
.glow{position:fixed;inset:0;pointer-events:none;z-index:0;background:radial-gradient(60% 50% at 50% -10%,rgba(255,91,31,.18),transparent 70%),radial-gradient(40% 40% at 90% 110%,rgba(61,220,132,.07),transparent 70%)}
.grain{position:fixed;inset:0;pointer-events:none;z-index:0;background-image:${GRAIN};opacity:.18;mix-blend-mode:overlay}
.top{position:relative;z-index:1;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:20px clamp(16px,4vw,40px)}
.wm{display:inline-flex;align-items:center;gap:10px;text-decoration:none;font:400 24px/1 "Instrument Serif",Georgia,serif;letter-spacing:-.01em;white-space:nowrap}
@media(max-width:600px){.top .mono{display:none}}
.wm-d{width:10px;height:10px;border-radius:50%;background:var(--signal);box-shadow:0 0 0 4px rgba(255,91,31,.18)}
.mono{font:500 11.5px/1.4 "JetBrains Mono",ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
main{position:relative;z-index:1;flex:1;width:min(1080px,calc(100% - 32px));margin:0 auto;padding:clamp(32px,7vh,96px) 0 64px}
.eyebrow{font:500 12px/1.4 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--signal);margin-bottom:18px}
.h-xl{font-size:clamp(72px,13vw,184px);line-height:.88}
.h-xl em{font-style:italic;color:var(--signal)}
.h-l{font-size:clamp(46px,8vw,104px);line-height:.94}
.lede{font-size:clamp(17px,1.8vw,21px);line-height:1.55;color:#D9D5CC;max-width:56ch;margin-top:26px}
.badge{display:inline-flex;align-items:center;gap:9px;margin-top:30px;height:38px;padding:0 16px 0 12px;border-radius:999px;font:600 13.5px/1 Inter,ui-sans-serif,system-ui,sans-serif;border:1px solid}
.badge .bd{display:grid;place-items:center;width:20px;height:20px;border-radius:50%}
.badge.ok{color:var(--money);border-color:rgba(61,220,132,.4);background:rgba(61,220,132,.08)}
.badge.ok .bd{background:var(--money);color:#06210f}
.badge.test{color:var(--warn);border-color:rgba(255,194,71,.4);background:rgba(255,194,71,.08)}
.badge.test .bd{background:var(--warn);color:#2a1c00}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:50px;padding:0 24px;border-radius:999px;background:var(--text);color:#0A0A0B;text-decoration:none;font:600 15px/1 Inter,ui-sans-serif,system-ui,sans-serif;border:0;cursor:pointer;transition:transform .2s,background .2s}
.btn:hover{transform:translateY(-1px);background:#fff}
.btn-s{background:var(--signal);color:#0A0A0B}
.btn-s:hover{background:#FF7A47}
.btn-o{background:transparent;color:var(--text);box-shadow:inset 0 0 0 1px #3A3A40}
.btn-o:hover{background:transparent;box-shadow:inset 0 0 0 1px var(--muted)}
.row{display:flex;flex-wrap:wrap;gap:12px;margin-top:36px}
.grid{display:grid;gap:20px;margin-top:clamp(48px,7vw,80px);align-items:start}
@media(min-width:860px){.grid{grid-template-columns:5fr 6fr;gap:28px}.grid.one{grid-template-columns:minmax(0,640px)}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:22px;padding:clamp(22px,3vw,32px)}
.pvc{display:block;text-decoration:none;overflow:hidden;padding:0;transition:border-color .25s,transform .25s}
.pvc:hover{border-color:#3A3A40;transform:translateY(-2px)}
.pvc-img{aspect-ratio:16/10;background:linear-gradient(135deg,var(--c1,#2a2a2e),var(--c2,#141416));position:relative;overflow:hidden}
.pvc-img img{width:100%;height:100%;object-fit:cover;display:block}
.pvc-img::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 40%,rgba(0,0,0,.65))}
.pvc-cap{position:absolute;left:18px;right:18px;bottom:16px;z-index:1;font:400 clamp(24px,2.6vw,32px)/1.05 "Instrument Serif",Georgia,serif;color:#fff}
.pvc-m{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:16px 20px;font-size:14px;color:#D9D5CC}
.pvc-m b{color:var(--text);font-weight:600}
.steps{list-style:none;margin:0;padding:0;display:grid;gap:0}
.steps li{display:grid;grid-template-columns:44px 1fr;gap:14px;padding:18px 0;border-top:1px solid var(--line)}
.steps li:first-child{border-top:0;padding-top:4px}
.steps .n{font:500 12px/1.9 "JetBrains Mono",ui-monospace,monospace;color:var(--signal)}
.steps h2{font-size:26px;line-height:1.1;margin-bottom:6px}
.steps p{color:#BDB9B0;font-size:15px;line-height:1.55}
.fine{margin-top:28px;display:flex;flex-wrap:wrap;gap:8px 22px}
.foot{position:relative;z-index:1;padding:24px clamp(16px,4vw,40px);border-top:1px solid var(--line);display:flex;flex-wrap:wrap;justify-content:space-between;gap:12px;font-size:13px;color:var(--muted)}
.foot a{text-decoration:none}
.foot a:hover{color:var(--text)}
.cf{position:fixed;inset:0;pointer-events:none;z-index:2;overflow:hidden}
.cf i{position:absolute;top:-24px;width:7px;height:14px;border-radius:2px;opacity:0;animation:fall var(--t,5s) cubic-bezier(.3,.6,.4,1) var(--dl,0s) 1 forwards}
@keyframes fall{0%{opacity:0;transform:translate3d(0,0,0) rotate(0)}8%{opacity:1}100%{opacity:0;transform:translate3d(var(--dx,0px),105vh,0) rotate(var(--r,540deg))}}
.rise{animation:rise .9s cubic-bezier(.2,.7,.2,1) both}
.rise.d1{animation-delay:.1s}.rise.d2{animation-delay:.2s}.rise.d3{animation-delay:.32s}.rise.d4{animation-delay:.44s}
@keyframes rise{from{opacity:0;transform:translateY(18px)}to{opacity:1;transform:none}}
.warnbox{display:flex;gap:14px;align-items:flex-start;padding:16px 18px;border-radius:16px;background:rgba(255,91,31,.07);border:1px solid rgba(255,91,31,.28);color:#E9D8CF;font-size:14.5px;margin-top:22px}
.warnbox svg{flex:none;margin-top:3px;color:var(--signal)}
.list{margin:18px 0 0;padding:0;list-style:none;display:grid;gap:10px}
.list li{display:flex;gap:12px;color:#CFCBC2;font-size:15px}
.list li::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:var(--muted);margin-top:.62em}
form{margin:0}
.big404{font:italic 400 clamp(140px,30vw,380px)/.8 "Instrument Serif",Georgia,serif;letter-spacing:-.05em;color:transparent;-webkit-text-stroke:1.5px rgba(244,241,234,.55);margin-bottom:12px;user-select:none}
.spinner{width:52px;height:52px;border-radius:50%;border:2px solid var(--line);border-top-color:var(--signal);animation:spin 1s linear infinite;margin-bottom:34px}
@keyframes spin{to{transform:rotate(1turn)}}
@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}.cf{display:none}.rise{opacity:1}}
`;

const CO_FONTS =
  '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&amp;family=Inter:wght@400;500;600;700&amp;family=JetBrains+Mono:wght@400;500&amp;display=swap">';

const CO_FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0A0A0B"/><circle cx="32" cy="32" r="11" fill="#FF5B1F"/></svg>',
  );

function coShell(o: { title: string; body: string; head?: string; foot?: boolean }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${esc(o.title)}</title>
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#0A0A0B">
<link rel="icon" href="${CO_FAVICON}">
${CO_FONTS}
${o.head || ""}
<style>${CO_CSS}</style>
</head>
<body>
<div class="glow" aria-hidden="true"></div><div class="grain" aria-hidden="true"></div>
<header class="top"><a class="wm" href="/"><span class="wm-d" aria-hidden="true"></span>Cold Open</a><span class="mono">The agency that does the work before the sale</span></header>
${o.body}
${o.foot === false ? "" : `<footer class="foot"><span>Cold Open · built at the Startup Speedrun Hackathon</span><a href="/">See how it works →</a></footer>`}
</body>
</html>`;
}

function confetti(colors: string[]): string {
  let out = '<div class="cf" aria-hidden="true">';
  for (let i = 0; i < 34; i++) {
    const r = (n: number) => ((Math.sin((i + 1) * n) + 1) / 2);
    const left = (r(12.9898) * 100).toFixed(1);
    const dl = (r(78.233) * 1.4).toFixed(2);
    const t = (3.8 + r(37.719) * 2.6).toFixed(2);
    const dx = Math.round((r(4.1414) - 0.5) * 180);
    const rot = Math.round(360 + r(9.87) * 540) * (i % 2 ? -1 : 1);
    const col = colors[i % colors.length];
    const w = i % 3 === 0 ? "width:10px;height:10px;border-radius:50%;" : "";
    out += `<i style="left:${left}%;--dl:${dl}s;--t:${t}s;--dx:${dx}px;--r:${rot}deg;background:${col};${w}"></i>`;
  }
  return out + "</div>";
}

function fmtMoney(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "";
  return "$" + (cents / 100).toFixed(2);
}

function fmtDate(ms: number | null): string {
  if (!ms || !Number.isFinite(ms)) return "";
  try {
    return new Date(ms).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "America/Los_Angeles",
    });
  } catch {
    return "";
  }
}

/** Thank-you page after Stripe checkout. */
export function renderClaimed(biz: Business | null, opts: { verified: boolean; publicUrl: string }): string {
  const base = normBase(opts && opts.publicUrl);
  const verified = !!(opts && opts.verified);
  const name = biz ? clean(biz.name, 80) : "";
  const id = biz ? String(biz.id || "") : "";
  const siteHref = id ? `/s/${encodeURIComponent(id)}` : "";
  const hero = biz ? safeMediaSrc(biz.heroImage) : null;
  const headline = biz && biz.site ? clean(biz.site.headline, 90) : "";
  const pr = biz && biz.brand ? hex(biz.brand.palette && biz.brand.palette.primary, "#2a2a2e") : "#2a2a2e";
  const ac = biz && biz.brand ? hex(biz.brand.palette && biz.brand.palette.accent, "#141416") : "#141416";
  const amount = biz ? fmtMoney(num(biz.amountCents)) : "";
  const date = biz ? fmtDate(num(biz.paidAt)) : "";

  const badge = verified
    ? `<p class="badge ok rise d3"><span class="bd">${I_CHECK}</span>Payment verified by Stripe</p>`
    : `<p class="badge test rise d3"><span class="bd">${I_CHECK}</span>Payment received (test mode)</p>`;

  const lede = biz
    ? `The site we built for <b>${esc(name)}</b> is claimed. Next we make it official — your real details, your domain, and no preview banner.`
    : `Thanks — your payment went through. We couldn't match it to a specific preview automatically, so reply to your Stripe receipt with your shop's name and we'll connect it.`;

  const card = biz
    ? `<a class="panel pvc rise d4" href="${esc(siteHref)}" style="--c1:${pr};--c2:${ac}"><div class="pvc-img">${hero ? `<img src="${esc(hero)}" alt="" decoding="async">` : ""}<p class="pvc-cap">${esc(headline || name)}</p></div><div class="pvc-m"><span><b>${esc(name)}</b></span><span>View your site →</span></div></a>`
    : "";

  const steps = `<div class="panel rise d4"><p class="eyebrow" style="margin-bottom:14px">What happens next</p><ol class="steps">
<li><span class="n">01</span><div><h2>We confirm the details</h2><p>Within one business day we reach out to the email on your receipt to confirm menu, hours and photos. Anything marked “owner to confirm” gets your real version.</p></div></li>
<li><span class="n">02</span><div><h2>We make it official</h2><p>The preview banner comes off, we connect your domain (or help you pick one), and your listing links point to the new site.</p></div></li>
<li><span class="n">03</span><div><h2>It stays yours</h2><p>You get the full site files and the hosting handoff. No lock-in — take it anywhere.</p></div></li>
</ol></div>`;

  const fine = [
    amount ? `<span class="mono">${esc(amount)} paid</span>` : "",
    date ? `<span class="mono">${esc(date)}</span>` : "",
    id ? `<span class="mono">Ref ${esc(id)}</span>` : "",
  ]
    .filter(Boolean)
    .join("");

  const body = `<main>
<p class="eyebrow rise">${biz ? esc(name) : "Cold Open"} · Launch Pack</p>
<h1 class="h-xl rise d1">It’s <em>yours.</em></h1>
<p class="lede rise d2">${lede}</p>
${badge}
<div class="grid${card ? "" : " one"}">${card}${steps}</div>
${fine ? `<p class="fine">${fine}</p>` : ""}
<div class="row">${siteHref ? `<a class="btn" href="${esc(siteHref)}">View your site</a>` : ""}<a class="btn btn-o" href="${esc(base)}/">See how it was made</a></div>
</main>${confetti(["#FF5B1F", "#3DDC84", "#F4F1EA", "#FFC247", pr])}`;
  return coShell({ title: biz ? `It’s yours — ${name}` : "It’s yours — Cold Open", body });
}

/** Confirmation page before an owner removes a preview. */
export function renderRemoveConfirm(biz: Business): string {
  const name = clean(biz && biz.name, 80) || "this business";
  const id = String((biz && biz.id) || "");
  const siteHref = `/s/${encodeURIComponent(id)}`;
  const hero = safeMediaSrc(biz && biz.heroImage);
  const headline = biz && biz.site ? clean(biz.site.headline, 90) : "";
  const pr = biz && biz.brand ? hex(biz.brand.palette && biz.brand.palette.primary, "#2a2a2e") : "#2a2a2e";
  const ac = biz && biz.brand ? hex(biz.brand.palette && biz.brand.palette.accent, "#141416") : "#141416";
  const card = `<a class="panel pvc rise d3" href="${esc(siteHref)}" style="--c1:${pr};--c2:${ac}"><div class="pvc-img">${hero ? `<img src="${esc(hero)}" alt="" decoding="async">` : ""}<p class="pvc-cap">${esc(headline || name)}</p></div><div class="pvc-m"><span><b>${esc(name)}</b></span><span class="mono">Concept preview</span></div></a>`;
  const body = `<main>
<p class="eyebrow rise">Preview for ${esc(name)}</p>
<h1 class="h-l rise d1">Take this preview down?</h1>
<div class="grid" style="margin-top:clamp(32px,5vw,56px)">
<div class="rise d2">
<p class="lede" style="margin-top:0">Cold Open builds concept websites for local businesses before anyone asks — it's how we show what we can do. We made this one for ${esc(name)} from public information, and it has always been labeled as unofficial.</p>
<ul class="list">
<li>Removing it takes the page offline right away, for everyone with the link.</li>
<li>No account, no reason, no email needed.</li>
<li>This can't be undone from here.</li>
</ul>
<form method="post" action="${esc(siteHref)}/remove" class="row">
<button class="btn btn-s" type="submit">Yes, remove the preview</button>
<a class="btn btn-o" href="${esc(siteHref)}">Keep it up</a>
</form>
</div>
${card}
</div>
</main>`;
  return coShell({ title: `Remove preview — ${name}`, body });
}

/** Shown after removal, and whenever a removed preview is requested. */
export function renderRemoved(name?: string): string {
  const n = clean(name || "", 80);
  const body = `<main style="display:flex;flex-direction:column;justify-content:center">
<p class="eyebrow rise">${n ? `Preview for ${esc(n)}` : "Preview removed"}</p>
<h1 class="h-xl rise d1">Removed.</h1>
<p class="lede rise d2" style="font-family:'Instrument Serif',Georgia,serif;font-size:clamp(28px,3.4vw,44px);line-height:1.15;color:var(--text)">Sorry for the intrusion.</p>
<p class="lede rise d3">${n ? `The concept preview we made for ${esc(n)} is offline and won't be shown again.` : "This concept preview is offline and won't be shown again."} Thanks for letting us know.</p>
<div class="row rise d4"><a class="btn btn-o" href="/">What is Cold Open?</a></div>
</main>`;
  return coShell({ title: "Removed — Cold Open", body });
}

/** Styled 404. */
export function renderNotFound(): string {
  const body = `<main style="display:flex;flex-direction:column;justify-content:center">
<p class="big404 rise" aria-hidden="true">404</p>
<h1 class="h-l rise d1">No preview here.</h1>
<p class="lede rise d2">This link doesn't match any preview. It may have been removed by the owner, or it never existed.</p>
<div class="row rise d3"><a class="btn" href="/">Go to Cold Open</a></div>
</main>`;
  return coShell({ title: "Not found — Cold Open", body });
}

const STAGE_LABEL: Record<string, string> = {
  scouted: "Queued — waiting for the agents",
  extracting: "Archivist is reading the brand",
  building: "Builder is composing the site",
  critiquing: "Critic is scoring the draft",
  directing: "Director is making the hero image",
  error: "The last build hit a snag — the team will retry",
};

/** Shown at /s/:id while the pipeline hasn't produced a site yet. Auto-refreshes. */
function renderPending(biz: Business): string {
  const name = clean(biz.name, 80) || "this business";
  const stage = STAGE_LABEL[biz.status] || "Getting ready";
  const refresh = biz.status === "error" ? "" : '<meta http-equiv="refresh" content="5">';
  const body = `<main style="display:flex;flex-direction:column;justify-content:center">
${biz.status === "error" ? "" : '<div class="spinner rise" aria-hidden="true"></div>'}
<p class="eyebrow rise">Concept preview · ${esc(name)}</p>
<h1 class="h-l rise d1">Being built right now.</h1>
<p class="lede rise d2">${esc(stage)}. This page refreshes on its own — the site appears here the moment it clears the taste gate.</p>
<p class="fine rise d3"><span class="mono">Status · ${esc(biz.status)}</span></p>
</main>`;
  return coShell({ title: `Building — ${name}`, body, head: refresh });
}

/** Render a generated concept site. Never throws. */
export function renderSite(biz: Business, opts: { publicUrl: string }): string {
  const base = normBase(opts && opts.publicUrl);
  try {
    if (!biz) return renderNotFound();
    if (biz.status === "removed") return renderRemoved(biz.name);
    if (!biz.site || !biz.brand) return renderPending(biz);
    const c = buildCtx(biz, biz.brand, biz.site, base);
    return assembleSite(c);
  } catch (err) {
    console.error("renderSite failed", biz && biz.id, err);
    // Last-resort fallback: still honest, still labeled, still removable.
    const name = clean(biz && biz.name, 80) || "this business";
    const id = encodeURIComponent(String((biz && biz.id) || ""));
    return coShell({
      title: name,
      body: `<main><p class="eyebrow">Unofficial concept preview for ${esc(name)} by Cold Open — not the official site.</p><h1 class="h-l">${esc(name)}</h1><p class="lede">This preview couldn't be displayed right now. Please try again in a moment.</p><div class="row"><a class="btn btn-s" href="/s/${id}/claim">Claim it · $49</a><a class="btn btn-o" href="/s/${id}/remove">Remove this preview</a></div></main>`,
    });
  }
}
