#!/usr/bin/env python3
"""
Cold Open — pitch deck builder (10 slides, 16:9, python-pptx).

Re-runnable. Every run:
  1. pulls live numbers from  {COLDOPEN_URL}/api/state  and  /api/config  (10 s timeout each);
     when the API is unreachable every live figure is rendered as a clearly-labelled
     "live at demo" placeholder instead. Nothing is ever invented.
  2. picks up images when they exist:
        docs/screenshots/*.png   -> demo / insight slides
        docs/hero.png            -> closing slide backdrop
        docs/architecture.svg    -> rasterised with headless Chrome into deck/assets/architecture.png
     and, when the live app answers but no screenshots exist yet, captures its own
     screenshots of the live Mission Control + a live preview site into deck/assets/.
  3. downloads a QR code for the live URL into deck/assets/qr.png.
  4. writes deck/ColdOpen.pptx (speaker notes on every slide, ~18 s each = 3 min).

Usage:
  python3 deck/build_deck.py              # live data if reachable
  python3 deck/build_deck.py --offline    # skip network, placeholders only
  COLDOPEN_URL=https://... python3 deck/build_deck.py
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

from lxml import etree
import numpy as np
from PIL import Image
from pptx import Presentation
from pptx.chart.data import CategoryChartData
from pptx.dml.color import RGBColor
from pptx.enum.chart import XL_CHART_TYPE, XL_LABEL_POSITION, XL_MARKER_STYLE
from pptx.enum.dml import MSO_LINE_DASH_STYLE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt

try:
    from zoneinfo import ZoneInfo
except ImportError:  # pragma: no cover
    ZoneInfo = None

# --------------------------------------------------------------------------------------
# Paths & constants
# --------------------------------------------------------------------------------------
DECK_DIR = Path(__file__).resolve().parent
ROOT = DECK_DIR.parent
ASSETS = DECK_DIR / "assets"
DOCS = ROOT / "docs"
OUT = DECK_DIR / "ColdOpen.pptx"

LIVE_URL = os.environ.get("COLDOPEN_URL", "https://coldopen.vnarasingamoorthy.workers.dev").rstrip("/")
LIVE_HOST = urllib.parse.urlparse(LIVE_URL).netloc
REPO = "github.com/vnmoorthy/coldopen"
QR_URL = (
    "https://api.qrserver.com/v1/create-qr-code/?size=400x400&data="
    + urllib.parse.quote(LIVE_URL, safe="")
)
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) ColdOpenDeck/1.0"

# Palette (matches Mission Control)
BG = "0A0A0B"
PANEL = "121214"
PANEL2 = "18181B"
LINE = "232327"
LINE2 = "34343A"
TEXT = "F4F1EA"
MUTED = "8A877F"
DIM = "5E5C57"
SIGNAL = "FF5B1F"
MONEY = "3DDC84"
WARN = "FFC247"
ERROR = "FF4D4D"
# Agent identity colours (same as public/styles.css)
AGENT = {"Scout": "FF5B1F", "Archivist": "B79CFF", "Builder": "5AA9FF", "Critic": "FFC247",
         "Director": "FF6FAE", "Closer": "3DDC84", "CFO": "7CE0D3"}

SERIF = "Georgia"  # Instrument Serif-style display fallback that ships with Office + macOS
SANS = "Arial"

SLIDE_W, SLIDE_H = 13.333, 7.5
ML = 0.75  # left/right margin (in)
CW = SLIDE_W - 2 * ML  # content width
TOTAL_SLIDES = 10

SOURCES = {
    "sba": "https://advocacy.sba.gov/2026/02/03/frequently-asked-questions-about-small-business-2026/",
    "clutch_sites": "https://clutch.co/resources/state-of-small-business-websites-2025",
    "clutch_price": "https://clutch.co/web-designers/pricing",
    "stripe": "https://stripe.com/pricing",
}

DEFAULT_SLOP = [
    "elevate", "unlock", "seamless", "nestled", "culinary journey",
    "look no further", "hidden gem", "in today's fast-paced world",
]

STAGES = ["scout", "archivist", "builder", "critic", "director", "closer"]


def I(v: float) -> Emu:
    return Inches(v)


# --------------------------------------------------------------------------------------
# Formatting helpers
# --------------------------------------------------------------------------------------
def fmt_money(cents: float | None, *, precise: bool = False) -> str:
    if cents is None:
        return "—"
    dollars = cents / 100.0
    if precise or (dollars < 100 and abs(dollars - round(dollars)) > 1e-9):
        return f"${dollars:,.2f}"
    return f"${dollars:,.0f}"


def fmt_small_cost(cents: float | None) -> str:
    """Model spend per site — often a few cents or less."""
    if cents is None:
        return "—"
    if cents < 1:
        return f"{cents:.2f}¢"
    if cents < 100:
        return f"{cents:.1f}¢".replace(".0¢", "¢")
    return f"${cents / 100:,.2f}"


def fmt_ms(ms: float | None) -> str:
    if not ms:
        return "—"
    s = ms / 1000.0
    if s < 60:
        return f"{s:.0f}s" if s >= 10 else f"{s:.1f}s"
    m, sec = divmod(int(round(s)), 60)
    return f"{m}m {sec:02d}s"


def say_ms(ms: float | None) -> str:
    if not ms:
        return ""
    s = int(round(ms / 1000.0))
    if s < 60:
        return f"{s} seconds"
    m, sec = divmod(s, 60)
    return f"{m} minute{'s' if m != 1 else ''} {sec} seconds" if sec else f"{m} minute{'s' if m != 1 else ''}"


def say_money(cents: float | None) -> str:
    if cents is None:
        return ""
    if cents < 100:
        c = round(cents, 1)
        return f"{c:g} cent{'s' if c != 1 else ''}"
    return fmt_money(cents)


def clean_hex(v, default: str) -> str:
    if not isinstance(v, str):
        return default
    m = re.fullmatch(r"#?([0-9a-fA-F]{6}|[0-9a-fA-F]{3})", v.strip())
    if not m:
        return default
    h = m.group(1)
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return h.upper()


def luminance(hex6: str) -> float:
    r, g, b = (int(hex6[i:i + 2], 16) / 255 for i in (0, 2, 4))

    def ch(c):
        return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4

    return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)


def trunc(s: str, n: int) -> str:
    s = re.sub(r"\s+", " ", (s or "")).strip()
    return s if len(s) <= n else s[: n - 1].rstrip(" ,.;:") + "…"


# --------------------------------------------------------------------------------------
# Live data
# --------------------------------------------------------------------------------------
def fetch_json(url: str, timeout: float = 10.0):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
        return json.loads(raw.decode("utf-8"))
    except Exception as e:  # noqa: BLE001
        print(f"  ! {url} unavailable ({type(e).__name__}: {str(e)[:80]})")
        return None


def fetch_bytes(url: str, timeout: float = 10.0) -> bytes | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read()
    except Exception as e:  # noqa: BLE001
        print(f"  ! {url} unavailable ({type(e).__name__})")
        return None


def load_live(offline: bool, state_file: str | None = None, config_file: str | None = None) -> dict:
    now = dt.datetime.now(ZoneInfo("America/Los_Angeles")) if ZoneInfo else dt.datetime.now()
    asof = now.strftime("%-I:%M %p PT · %b %-d, %Y")
    L = {"live": False, "asof": asof, "config": None}
    if offline:
        print("  offline mode: live numbers render as 'live at demo'")
        return L
    if state_file:  # a saved /api/state snapshot (e.g. captured right after the demo)
        state = json.loads(Path(state_file).read_text())
        config = json.loads(Path(config_file).read_text()) if config_file else None
    else:
        state = fetch_json(f"{LIVE_URL}/api/state")
        config = fetch_json(f"{LIVE_URL}/api/config")
    L["config"] = config if isinstance(config, dict) else None
    if not (isinstance(state, dict) and isinstance(state.get("stats"), dict)):
        return L

    st = state["stats"]
    bizs = [b for b in state.get("businesses") or [] if isinstance(b, dict) and b.get("status") != "removed"]
    L["live"] = True
    L["source"] = "file" if state_file else "api"
    L["stats"] = st
    L["businesses"] = bizs

    def num(k):
        v = st.get(k)
        return v if isinstance(v, (int, float)) else 0

    for k in ("scouted", "built", "tastePassed", "contacted", "replied", "paid", "revenueCents", "spendCents"):
        L[k] = num(k)
    L["avgBuildMs"] = st.get("avgBuildMs")
    L["bestBuildMs"] = st.get("bestBuildMs")

    scored = [b for b in bizs if isinstance(b.get("scores"), list) and b["scores"]]
    L["scored"] = scored
    if scored:
        def delta(b):
            s = b["scores"]
            return (s[-1].get("score", 0) - s[0].get("score", 0), len(s), s[-1].get("score", 0))

        best = max(scored, key=delta)
        L["best"] = best
        L["bestDelta"] = delta(best)[0]
        L["avgFirst"] = statistics.mean(b["scores"][0].get("score", 0) for b in scored)
        L["avgFinal"] = statistics.mean(b["scores"][-1].get("score", 0) for b in scored)
        L["sentBack"] = sum(1 for b in scored if len(b["scores"]) > 1)
        hits = []
        for b in scored:
            for s in b["scores"]:
                for h in s.get("slopHits") or []:
                    h = str(h).strip().strip('"').lower()
                    if h and h not in hits:
                        hits.append(h)
        L["slopHits"] = hits
        providers = sorted({str(s.get("provider")) for b in scored for s in b["scores"] if s.get("provider")})
        L["providers"] = providers

    built = L["built"]
    L["costPerSite"] = (L["spendCents"] / built) if built else None

    showcase = [b for b in bizs if b.get("site") and b.get("brand")]
    showcase.sort(key=lambda b: (
        b.get("status") == "paid",
        (b.get("scores") or [{}])[-1].get("score", 0),
        bool(b.get("heroImage")),
    ), reverse=True)
    L["showcase"] = showcase[0] if showcase else None
    return L


def paylink_is_test(L: dict) -> bool:
    link = ((L.get("config") or {}).get("paymentLink") or "")
    return "/test_" in link or "buy.stripe.com/test" in link


# --------------------------------------------------------------------------------------
# Assets
# --------------------------------------------------------------------------------------
def make_backgrounds():
    """Cinematic dark backgrounds with a soft glow + fine grain (gradients shipped as images)."""
    ASSETS.mkdir(parents=True, exist_ok=True)
    W, H = 1920, 1080
    base = np.array([0x0A, 0x0A, 0x0B], dtype=np.float32)
    variants = {
        "bg_hero.jpg": [((1540, 900), 980, (255, 91, 31), 0.30), ((250, -120), 760, (255, 91, 31), 0.06)],
        "bg_plain.jpg": [((1850, -60), 820, (255, 91, 31), 0.075)],
        "bg_money.jpg": [((1800, 1120), 900, (61, 220, 132), 0.09), ((80, -80), 640, (255, 91, 31), 0.045)],
    }
    rng = np.random.default_rng(7)
    grain = rng.normal(0, 1.6, (H, W, 1)).astype(np.float32)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    for name, glows in variants.items():
        img = np.broadcast_to(base, (H, W, 3)).copy()
        for (cx, cy), r, col, strength in glows:
            d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / r
            a = (np.clip(1 - d, 0, 1) ** 2.2 * strength)[..., None]
            img = img * (1 - a) + np.array(col, dtype=np.float32) * a
        img = np.clip(img + grain, 0, 255).astype(np.uint8)
        Image.fromarray(img, "RGB").save(ASSETS / name, quality=90, optimize=True)


def download_qr() -> Path | None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    p = ASSETS / "qr.png"
    data = fetch_bytes(QR_URL, timeout=10)
    if data and data[:8] == b"\x89PNG\r\n\x1a\n":
        p.write_bytes(data)
        print("  qr: downloaded")
    elif p.exists():
        print("  qr: using cached copy")
    else:
        return None
    return p


def chrome_capture(target: str, out: Path, w: int, h: int, *, scale: int = 2, budget_ms: int = 9000,
                   timeout_s: float = 75) -> bool:
    """Headless-Chrome screenshot. Chrome sometimes writes the PNG and then never exits, so poll + kill."""
    if not Path(CHROME).exists():
        return False
    out.unlink(missing_ok=True)
    tmp = tempfile.mkdtemp(prefix="coldopen-chrome-")
    cmd = [
        CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
        "--no-default-browser-check", "--disable-extensions", f"--user-data-dir={tmp}",
        f"--window-size={w},{h}", f"--force-device-scale-factor={scale}", f"--virtual-time-budget={budget_ms}",
        "--default-background-color=0A0A0BFF", f"--screenshot={out}", target,
    ]
    proc = None
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        deadline = time.time() + timeout_s
        last, stable = -1, 0
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            if out.exists():
                size = out.stat().st_size
                stable = stable + 1 if (size == last and size > 0) else 0
                last = size
                if stable >= 2:
                    break
            time.sleep(0.5)
    except Exception:  # noqa: BLE001
        return False
    finally:
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(5)
            except Exception:  # noqa: BLE001
                proc.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    return out.exists() and out.stat().st_size > 5000 and not image_is_blank(out)


def image_is_blank(p: Path) -> bool:
    try:
        im = Image.open(p).convert("L").resize((64, 36))
        px = list(im.getdata())
        return statistics.pstdev(px) < 3.0
    except Exception:  # noqa: BLE001
        return True


def svg_to_png(svg: Path, out: Path) -> bool:
    txt = svg.read_text(encoding="utf-8", errors="ignore")
    w = h = None
    m = re.search(r'viewBox\s*=\s*"[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)"', txt)
    if m:
        w, h = float(m.group(1)), float(m.group(2))
    else:
        mw = re.search(r'<svg[^>]*\swidth="([\d.]+)', txt)
        mh = re.search(r'<svg[^>]*\sheight="([\d.]+)', txt)
        if mw and mh:
            w, h = float(mw.group(1)), float(mh.group(1))
    w, h = int(w or 1600), int(h or 900)
    html = ASSETS / "_svgwrap.html"
    html.write_text(
        f"<!doctype html><html><body style='margin:0;background:#0A0A0B'>"
        f"<img src='{svg.resolve().as_uri()}' style='display:block;width:{w}px;height:{h}px'></body></html>",
        encoding="utf-8",
    )
    ok = chrome_capture(html.resolve().as_uri(), out, w, h, scale=2, budget_ms=3000)
    html.unlink(missing_ok=True)
    return ok


def gather_images(L: dict) -> dict:
    imgs: dict[str, Path | None] = {"mission": None, "extra": [], "site": None, "arch": None, "hero": None,
                                    "biz_hero": None}
    shots = sorted((DOCS / "screenshots").glob("*.png")) if (DOCS / "screenshots").is_dir() else []

    def pick(keys, pool):
        for s in pool:
            if any(k in s.stem.lower() for k in keys):
                return s
        return None

    mission = pick(["mission", "dashboard", "control", "home", "index", "overview", "app"], shots)
    site = pick(["site", "preview", "concept"], shots)
    if not mission and shots:
        mission = next((s for s in shots if s != site), None)
    imgs["mission"] = mission
    imgs["site"] = site
    imgs["extra"] = [s for s in shots if s not in (mission, site)][:2]

    # Self-captured screenshots of the live product (only when the live API itself answered).
    if L.get("live") and L.get("source") == "api":
        if not imgs["mission"]:
            out = ASSETS / "live_mission.png"
            if chrome_capture(LIVE_URL + "/", out, 1600, 900):
                imgs["mission"] = out
                print("  captured live Mission Control screenshot")
        sc = L.get("showcase")
        if not imgs["site"] and sc and sc.get("id"):
            out = ASSETS / "live_site.png"
            if chrome_capture(f"{LIVE_URL}/s/{urllib.parse.quote(sc['id'])}", out, 1280, 900):
                imgs["site"] = out
                print(f"  captured live preview site for {sc.get('name')}")
        if sc and sc.get("heroImage"):
            data = fetch_bytes(LIVE_URL + sc["heroImage"], timeout=10)
            if data:
                out = ASSETS / "live_biz_hero.img"
                out.write_bytes(data)
                try:
                    im = Image.open(out)
                    im.load()
                    png = ASSETS / "live_biz_hero.png"
                    im.convert("RGB").save(png)
                    imgs["biz_hero"] = png
                except Exception:  # noqa: BLE001
                    pass
                out.unlink(missing_ok=True)

    arch_png = DOCS / "architecture.png"
    arch_svg = DOCS / "architecture.svg"
    if arch_svg.exists():
        out = ASSETS / "architecture.png"
        if svg_to_png(arch_svg, out):
            imgs["arch"] = out
            print("  architecture.svg rasterised")
    if not imgs["arch"] and arch_png.exists():
        imgs["arch"] = arch_png
    if (DOCS / "hero.png").exists():
        imgs["hero"] = DOCS / "hero.png"
    return imgs


def read_critic_info() -> dict:
    """Pull the Critic's real banned-phrase list and rubric from src/pipeline/critic.ts when present."""
    info = {"slop": list(DEFAULT_SLOP), "count": None, "rubric": None, "penalty": None}
    p = ROOT / "src" / "pipeline" / "critic.ts"
    if not p.exists():
        return info
    src = p.read_text(encoding="utf-8", errors="ignore")
    labels = re.findall(r"""label:\s*["'`]([^"'`\n]{2,40})["'`]""", src)
    if not labels:
        m = re.search(r"(?:BANNED|SLOP|banned|slop)\w*\s*(?::[^=\n]*)?=\s*\[(.*?)\];", src, re.S)
        if m:
            labels = re.findall(r"""["'`]([^"'`\n]{2,40})["'`]""", m.group(1))
    labels = [x.strip() for x in labels if x.strip()]
    if labels:
        info["slop"], info["count"] = labels, len(labels)
    m = re.search(r"rubric\s*\(([^)]{10,160})\)", src, re.I)
    if m:
        info["rubric"] = re.sub(r"\s+", " ", m.group(1)).strip()
    m = re.search(r"(\d+)\s*points?\s*per\s*banned", src, re.I)
    if m:
        info["penalty"] = int(m.group(1))
    return info


# --------------------------------------------------------------------------------------
# python-pptx drawing helpers
# --------------------------------------------------------------------------------------
def rgb(h: str) -> RGBColor:
    return RGBColor.from_string(h)


def _strip_style(shape):
    st = shape._element.find(qn("p:style"))
    if st is not None:
        shape._element.remove(st)


def _set_alpha_on(parent_fill_el, alpha: float):
    clr = parent_fill_el[0]
    for old in clr.findall(qn("a:alpha")):
        clr.remove(old)
    a = etree.SubElement(clr, qn("a:alpha"))
    a.set("val", str(int(alpha * 100000)))


def box(slide, x, y, w, h, *, fill=None, line=None, lw=0.75, radius=None, alpha=None, shape=None, dash=False,
        line_alpha=None):
    kind = shape or (MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE)
    s = slide.shapes.add_shape(kind, I(x), I(y), I(w), I(h))
    _strip_style(s)
    if radius and kind == MSO_SHAPE.ROUNDED_RECTANGLE:
        s.adjustments[0] = max(0.0, min(0.5, radius / min(w, h)))
    if fill:
        s.fill.solid()
        s.fill.fore_color.rgb = rgb(fill)
        if alpha is not None:
            _set_alpha_on(s._element.spPr.find(qn("a:solidFill")), alpha)
    else:
        s.fill.background()
    if line:
        s.line.color.rgb = rgb(line)
        s.line.width = Pt(lw)
        if dash:
            s.line.dash_style = MSO_LINE_DASH_STYLE.DASH
        if line_alpha is not None:
            ln = s._element.spPr.find(qn("a:ln"))
            _set_alpha_on(ln.find(qn("a:solidFill")), line_alpha)
    else:
        s.line.fill.background()
    s.text_frame.text = ""
    return s


def line(slide, x1, y1, x2, y2, *, color=LINE2, w=1.0, dash=False, arrow=False, head=False):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, I(x1), I(y1), I(x2), I(y2))
    _strip_style(c)
    c.line.color.rgb = rgb(color)
    c.line.width = Pt(w)
    if dash:
        c.line.dash_style = MSO_LINE_DASH_STYLE.DASH
    ln = c.line._get_or_add_ln()
    if head:
        he = etree.SubElement(ln, qn("a:headEnd"))
        he.set("type", "triangle"), he.set("w", "med"), he.set("len", "med")
    if arrow:
        te = etree.SubElement(ln, qn("a:tailEnd"))
        te.set("type", "triangle"), te.set("w", "med"), te.set("len", "med")
    return c


def text(slide, x, y, w, h, paras, *, font=SANS, size=16, color=TEXT, bold=False, italic=False, align="l",
         anchor="t", spc=None, ls=None, after=0.0, before=0.0, wrap=True, caps=False):
    """paras: str | list[para]; para: str | list[run]; run: str | (str, {overrides})."""
    tb = slide.shapes.add_textbox(I(x), I(y), I(w), I(h))
    tf = tb.text_frame
    tf.word_wrap = wrap
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.auto_size = None
    tf.vertical_anchor = {"t": MSO_ANCHOR.TOP, "m": MSO_ANCHOR.MIDDLE, "b": MSO_ANCHOR.BOTTOM}[anchor]
    if isinstance(paras, str):
        paras = [paras]
    for pi, para in enumerate(paras):
        p = tf.paragraphs[0] if pi == 0 else tf.add_paragraph()
        p.alignment = {"l": PP_ALIGN.LEFT, "c": PP_ALIGN.CENTER, "r": PP_ALIGN.RIGHT}[align]
        popts = {}
        if isinstance(para, tuple) and isinstance(para[1], dict) and not isinstance(para[0], tuple):
            para, popts = para
        runs = [para] if isinstance(para, str) else para
        p_after = popts.get("after", after)
        p_before = popts.get("before", before)
        if p_after:
            p.space_after = Pt(p_after)
        if p_before:
            p.space_before = Pt(p_before)
        p_ls = popts.get("ls", ls)
        if p_ls:
            # < 4 → multiple of single spacing; otherwise an exact leading in points
            p.line_spacing = p_ls if p_ls < 4 else Pt(p_ls)
        for run in runs:
            if isinstance(run, tuple):
                t, o = run
            else:
                t, o = run, {}
            o = {**popts.get("run", {}), **o}
            r = p.add_run()
            r.text = t.upper() if o.get("caps", caps) else t
            f = r.font
            f.name = o.get("font", font)
            f.size = Pt(o.get("size", size))
            f.bold = o.get("bold", bold)
            f.italic = o.get("italic", italic)
            f.color.rgb = rgb(o.get("color", color))
            rPr = r._r.get_or_add_rPr()
            sp = o.get("spc", spc)
            if sp:
                rPr.set("spc", str(int(sp)))
            if o.get("strike"):
                rPr.set("strike", "sngStrike")
            # make east-asian/complex fallbacks match
            for tag in ("a:ea", "a:cs"):
                el = rPr.find(qn(tag))
                if el is None:
                    el = etree.SubElement(rPr, qn(tag))
                el.set("typeface", o.get("font", font))
    return tb


def kicker(slide, label, *, color=SIGNAL, x=ML, y=0.62, w=9.0, dot=True):
    runs = []
    if dot:
        runs.append(("●  ", {"color": color, "size": 9}))
    runs.append((label, {}))
    text(slide, x, y, w, 0.3, [runs], size=11, bold=True, color=color, spc=280, caps=True)


def title(slide, runs, *, y=0.98, size=48, w=CW, h=1.0, x=ML, color=TEXT):
    if isinstance(runs, str):
        runs = [runs]
    text(slide, x, y, w, h, [runs], font=SERIF, size=size, color=color, ls=0.95)


def footer(slide, n, *, note=None):
    text(slide, ML, 6.98, 3.0, 0.25, [[("COLD OPEN", {"bold": True})]], size=9, color=DIM, spc=300)
    if note:
        text(slide, ML + 2.2, 6.98, CW - 3.4, 0.25, note, size=8.5, color=DIM, align="c")
    text(slide, SLIDE_W - ML - 1.2, 6.98, 1.2, 0.25, f"{n:02d} / {TOTAL_SLIDES:02d}", size=9, color=DIM,
         align="r", spc=200)


def background(slide, name="bg_plain.jpg"):
    p = ASSETS / name
    if p.exists():
        pic = slide.shapes.add_picture(str(p), 0, 0, I(SLIDE_W), I(SLIDE_H))
        pic.name = "Background"
    else:
        bg = slide.background.fill
        bg.solid()
        bg.fore_color.rgb = rgb(BG)


def image_cover(slide, path, x, y, w, h, *, anchor="top", border=LINE2):
    im = Image.open(path)
    iw, ih = im.size
    pic = slide.shapes.add_picture(str(path), I(x), I(y), I(w), I(h))
    target, src = w / h, iw / ih
    if src > target:
        c = (1 - target / src) / 2
        pic.crop_left = pic.crop_right = c
    elif src < target:
        c = 1 - src / target
        if anchor == "top":
            pic.crop_bottom = c
        else:
            pic.crop_top = pic.crop_bottom = c / 2
    if border:
        pic.line.color.rgb = rgb(border)
        pic.line.width = Pt(0.75)
    return pic


def image_contain(slide, path, x, y, w, h):
    im = Image.open(path)
    iw, ih = im.size
    s = min(w / iw, h / ih)
    dw, dh = iw * s, ih * s
    return slide.shapes.add_picture(str(path), I(x + (w - dw) / 2), I(y + (h - dh) / 2), I(dw), I(dh))


def circle(slide, cx, cy, r, **kw):
    return box(slide, cx - r, cy - r, 2 * r, 2 * r, shape=MSO_SHAPE.OVAL, **kw)


def monogram(slide, cx, cy, r, letters, color, *, filled=False, size=12):
    circle(slide, cx, cy, r, fill=color if filled else PANEL2, line=color, lw=1.25)
    text(slide, cx - r, cy - r, 2 * r, 2 * r, [[(letters, {})]], size=size, bold=True,
         color=BG if filled else color, align="c", anchor="m", spc=100)


def pill(slide, x, y, label, *, color=TEXT, fill=PANEL2, line_c=LINE2, size=11, h=0.34, pad=0.18,
         char_w=None, bold=False, strike=False, dot=None, font=SANS):
    cw = char_w or (size / 72.0) * 0.53
    extra = 0.2 if dot else 0
    w = pad * 2 + len(label) * cw + extra
    box(slide, x, y, w, h, fill=fill, line=line_c, lw=0.75, radius=h / 2)
    if dot:
        circle(slide, x + pad + 0.05, y + h / 2, 0.045, fill=dot)
    text(slide, x + pad + extra, y, w - pad * 2 - extra + 0.05, h, [[(label, {"strike": strike})]], size=size,
         color=color, anchor="m", bold=bold, wrap=False, font=font)
    return w


def notes(slide, body: str):
    slide.notes_slide.notes_text_frame.text = re.sub(r"\s+", " ", body).strip()


def style_chart_frame(chart):
    """Transparent chart + plot area so the dark slide shows through."""
    cs = chart._chartSpace
    for parent in (cs, cs.find(qn("c:chart")).find(qn("c:plotArea"))):
        spPr = parent.find(qn("c:spPr"))
        if spPr is None:
            spPr = etree.SubElement(parent, qn("c:spPr"))
            if parent is cs:
                # c:spPr must precede c:txPr / c:externalData etc. in chartSpace
                txPr = cs.find(qn("c:txPr"))
                if txPr is not None:
                    txPr.addprevious(spPr)
        for c in list(spPr):
            spPr.remove(c)
        etree.SubElement(spPr, qn("a:noFill"))
        ln = etree.SubElement(spPr, qn("a:ln"))
        etree.SubElement(ln, qn("a:noFill"))


# --------------------------------------------------------------------------------------
# Slides
# --------------------------------------------------------------------------------------
def s01_title(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s, "bg_hero.jpg")
    kicker(s, "Startup Speedrun Hackathon  ·  Cloudflare HQ  ·  Sep 28, 2026", y=0.7, w=8.0)

    text(s, ML - 0.06, 1.28, 6.6, 3.7, [
        ([("Cold", {})], {"ls": 124}),
        ([("Open", {}), (".", {"color": SIGNAL})], {"ls": 124}),
    ], font=SERIF, size=138, color=TEXT)

    text(s, ML, 4.95, 6.4, 1.0, [[("The agency that does the work ", {}), ("before", {"italic": True, "color": SIGNAL}),
                                   (" the sale.", {})]], font=SERIF, size=30, color=TEXT, ls=1.05)
    text(s, ML, 6.2, 6.4, 0.6, [
        "Autonomous agents scout real storefronts, build each one a site, gate it on taste,",
        "and attach a checkout — built in 8 hours at 101 Townsend St, San Francisco.",
    ], size=12.5, color=MUTED, ls=1.15)

    # Radar of the block — HQ at centre, rings at 150/300/450 m, live businesses plotted by real lat/lon.
    cx, cy, R = 9.95, 3.72, 2.55
    for i, frac in enumerate((1.0, 2 / 3, 1 / 3)):
        circle(s, cx, cy, R * frac, line=LINE2 if i else "3A3A40", lw=0.75, dash=i > 0)
    line(s, cx - R - 0.25, cy, cx + R + 0.25, cy, color=LINE, w=0.5)
    line(s, cx, cy - R - 0.25, cx, cy + R + 0.25, color=LINE, w=0.5)
    text(s, cx + R * 0.71 + 0.06, cy - R * 0.71 - 0.28, 1.2, 0.25, "450 m", size=9, color=DIM, spc=150)
    text(s, cx + R * 0.33 * 0.71 + 0.06, cy - R * 0.33 * 0.71 - 0.24, 1.2, 0.25, "150 m", size=9, color=DIM,
         spc=150)

    plotted = 0
    hq_lat, hq_lon = 37.7786, -122.3893
    cfg = L.get("config") or {}
    if isinstance(cfg.get("hq"), dict):
        hq_lat = float(cfg["hq"].get("lat", hq_lat))
        hq_lon = float(cfg["hq"].get("lon", hq_lon))
    for b in L.get("businesses") or []:
        lat, lon = b.get("lat"), b.get("lon")
        if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
            continue
        dx = (lon - hq_lon) * math.cos(math.radians(hq_lat)) * 111_320
        dy = (lat - hq_lat) * 110_540
        d = math.hypot(dx, dy)
        if d > 520:
            continue
        px, py = cx + dx / 450 * R, cy - dy / 450 * R
        stt = b.get("status")
        col = MONEY if stt == "paid" else (TEXT if stt in ("ready", "contacted", "replied") else MUTED)
        circle(s, px, py, 0.055 if stt in ("paid", "ready", "contacted", "replied") else 0.04, fill=col)
        plotted += 1
    # HQ pin
    circle(s, cx, cy, 0.22, fill=SIGNAL, alpha=0.18)
    circle(s, cx, cy, 0.085, fill=SIGNAL)
    text(s, cx + 0.2, cy + 0.12, 2.2, 0.3, "CLOUDFLARE HQ", size=9, bold=True, color=SIGNAL, spc=200)
    cap = (f"{plotted} real businesses scouted from OpenStreetMap · live" if plotted
           else "Scouting radius around 101 Townsend St · pins plot live from /api/state")
    text(s, cx - R, cy + R + 0.32, 2 * R, 0.3, cap, size=10, color=MUTED, align="c")

    footer(s, 1)
    notes(s, """Hi, I'm Moorthy, and this is Cold Open — the agency that does the work before the sale.
    In eight hours, here at Cloudflare HQ, we built a team of AI agents that walks this block, finds real small
    businesses, and builds each one a website before anyone asks.""")


def s02_problem(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s)
    kicker(s, "The problem")
    title(s, [("The sale comes ", {}), ("before", {"italic": True, "color": SIGNAL}), (" the work.", {})], size=52)

    cols = [
        ("36.2M", "small businesses in the U.S.", "SBA Office of Advocacy, FAQ 2026", TEXT),
        ("1 in 6", "still have no website at all", "Clutch small-business website survey, 2025 (17%, n=406)", TEXT),
        ("$100+", "an hour — the typical web-design agency rate", "Clutch web design pricing guide ($100–$149/hr)",
         SIGNAL),
    ]
    gap = 0.4
    cwid = (CW - 2 * gap) / 3
    y0 = 2.3
    for i, (big, label, src, col) in enumerate(cols):
        x = ML + i * (cwid + gap)
        box(s, x, y0, cwid, 2.8, fill=PANEL, line=LINE, radius=0.12)
        text(s, x + 0.35, y0 + 0.22, cwid - 0.6, 1.1, big, font=SERIF, size=72, color=col)
        text(s, x + 0.35, y0 + 1.36, cwid - 0.6, 0.62, label, size=16, color=TEXT, ls=1.1)
        text(s, x + 0.35, y0 + 2.08, cwid - 0.6, 0.5, src, size=10, color=MUTED, ls=1.1)

    text(s, ML, 5.4, CW, 0.9, [[
        ("Agencies sell with decks and promises. The owner has to say yes — and pay — ", {}),
        ("before they see a single pixel.", {"italic": True}),
    ]], font=SERIF, size=24, color=TEXT, ls=1.1)

    text(s, ML, 6.42, CW, 0.4, [
        "Sources: " + SOURCES["sba"] + "  ·  " + SOURCES["clutch_sites"] + "  ·  " + SOURCES["clutch_price"],
    ], size=8, color=DIM)
    footer(s, 2)
    notes(s, """There are over thirty-six million small businesses in the US. One in six still has no website,
    and agencies bill a hundred-plus dollars an hour. Worst part: the owner has to say yes, and pay, before seeing a
    single pixel. The sale comes before the work.""")


def _flow_row(s, x, y, labels, *, active, size=12.5):
    cx = x
    for i, lab in enumerate(labels):
        col = TEXT if active else MUTED
        fill = SIGNAL if (active and i == len(labels) - 1) else (PANEL2 if active else PANEL)
        lc = SIGNAL if active else LINE2
        tc = BG if (active and i == len(labels) - 1) else col
        w = pill(s, cx, y, lab, color=tc, fill=fill, line_c=lc, size=size, h=0.46, pad=0.18,
                 bold=active and i == len(labels) - 1)
        cx += w
        if i < len(labels) - 1:
            line(s, cx + 0.06, y + 0.23, cx + 0.3, y + 0.23, color=SIGNAL if active else DIM, w=1.25, arrow=True)
            cx += 0.36
    return cx


def _site_mock(s, x, y, w, h, L, imgs):
    """A native, editable rendition of a Cold Open preview site (real brand data when live)."""
    sc = L.get("showcase")
    brand = (sc or {}).get("brand") or {}
    site = (sc or {}).get("site") or {}
    pal = brand.get("palette") or {}
    bgc = clean_hex(pal.get("background"), "F6F1E7")
    txc = clean_hex(pal.get("text"), "1B1A17")
    if abs(luminance(bgc) - luminance(txc)) < 0.35:
        txc = "111111" if luminance(bgc) > 0.4 else "F6F1E7"
    prim = clean_hex(pal.get("primary"), "B4532A")
    name = (sc or {}).get("name") or "A neighborhood café"
    headline = trunc(site.get("headline") or "Coffee worth crossing the street for.", 60)
    sub = trunc(site.get("subheadline") or "Espresso, pastries and a seat by the window — two blocks from the ballpark.",
                110)
    cta = trunc(site.get("ctaLabel") or "Visit us", 18)
    highlights = [trunc(hh.get("title", ""), 30) for hh in (site.get("highlights") or [])][:3] or [
        "Made here daily", "Two blocks from HQ", "Owner to confirm"]
    bid = (sc or {}).get("id") or "your-business"

    # browser chrome
    box(s, x, y, w, h, fill="1A1A1D", line=LINE2, radius=0.14)
    for i, c in enumerate(("FF5F57", "FEBC2E", "28C840")):
        circle(s, x + 0.25 + i * 0.2, y + 0.24, 0.05, fill=c)
    box(s, x + 0.95, y + 0.12, w - 1.2, 0.25, fill="0F0F11", line=LINE, radius=0.12)
    text(s, x + 1.1, y + 0.12, w - 1.5, 0.25, f"{LIVE_HOST}/s/{trunc(bid, 28)}", size=8.5, color=MUTED, anchor="m",
         wrap=False)
    vy = y + 0.5
    vw = w - 0.2
    vx = x + 0.1
    vh = h - 0.6
    # page body
    box(s, vx, vy, vw, vh, fill=bgc)
    # honesty banner
    box(s, vx, vy, vw, 0.42, fill="111113")
    text(s, vx + 0.15, vy, vw - 2.3, 0.42, [[("Unofficial concept preview", {"bold": True}),
                                             (f" for {trunc(name, 24)} — not the official site", {})]],
         size=7.5, color=TEXT, anchor="m")
    box(s, vx + vw - 2.05, vy + 0.08, 1.05, 0.26, fill=MONEY, radius=0.13)
    text(s, vx + vw - 2.05, vy + 0.08, 1.05, 0.26, "Claim it · $49", size=7.5, bold=True, color=BG, align="c",
         anchor="m")
    box(s, vx + vw - 0.93, vy + 0.08, 0.8, 0.26, line="6A6862", radius=0.13)
    text(s, vx + vw - 0.93, vy + 0.08, 0.8, 0.26, "Remove", size=7.5, color=TEXT, align="c", anchor="m")

    body_y = vy + 0.42
    hero_h = 1.55
    if imgs.get("biz_hero"):
        image_cover(s, imgs["biz_hero"], vx, body_y, vw, hero_h, anchor="center", border=None)
        box(s, vx, body_y, vw, hero_h, fill="000000", alpha=0.45)
        htx = "FFFFFF"
    else:
        box(s, vx, body_y, vw, hero_h, fill=prim, alpha=0.16)
        htx = txc
    text(s, vx + 0.3, body_y + 0.2, vw - 0.6, 0.3, trunc(name, 40).upper(), size=8, bold=True, color=htx, spc=250)
    text(s, vx + 0.3, body_y + 0.48, vw - 0.6, 0.75, headline, font=SERIF, size=19, color=htx, ls=0.95)
    by = body_y + hero_h + 0.18
    text(s, vx + 0.3, by, vw - 0.6, 0.55, sub, size=9, color=txc, ls=1.15)
    box(s, vx + 0.3, by + 0.62, 1.2, 0.32, fill=prim, radius=0.16)
    text(s, vx + 0.3, by + 0.62, 1.2, 0.32, cta, size=8.5, bold=True,
         color="FFFFFF" if luminance(prim) < 0.5 else "111111", align="c", anchor="m")
    hy = by + 1.12
    hw = (vw - 0.6 - 0.3) / 3
    for i, hl in enumerate(highlights):
        hx = vx + 0.3 + i * (hw + 0.15)
        if hy + 0.5 < vy + vh:
            box(s, hx, hy, hw, 0.5, line=txc, lw=0.5, radius=0.06, line_alpha=0.25)
            text(s, hx + 0.1, hy, hw - 0.2, 0.5, hl, size=8, color=txc, anchor="m", bold=True)
    return sc is not None


def s03_insight(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s)
    kicker(s, "The insight")
    title(s, [("Flip it. The work ", {}), ("is", {"italic": True, "color": SIGNAL}), (" the pitch.", {})], size=52)

    x0, y0 = ML, 2.6
    text(s, x0, y0, 6.5, 0.3, "A typical agency", size=10.5, bold=True, color=MUTED, spc=250, caps=True)
    _flow_row(s, x0, y0 + 0.38, ["Pitch", "Contract", "Deposit", "Wait weeks", "Reveal"], active=False)
    text(s, x0, y0 + 1.25, 6.5, 0.3, "Cold Open", size=10.5, bold=True, color=SIGNAL, spc=250, caps=True)
    _flow_row(s, x0, y0 + 1.63, ["Build it", "Critique it", "Show it", "Claim · $49"], active=True)

    cps = L.get("costPerSite")
    if cps is not None:
        tail = [("Agents make the work nearly free — ", {}), (fmt_small_cost(cps), {"color": MONEY, "bold": True}),
                (" of model spend per site today — so we can afford to do it for everyone, first.", {})]
    else:
        tail = [("Agents make the work nearly free, so we can afford to do it for every storefront — ", {}),
                ("first", {"italic": True}), (". Live cost per site: ", {}),
                ("live at demo", {"color": WARN})]
    text(s, x0, 5.2, 6.4, 1.0, [tail], size=15, color=TEXT, ls=1.2)

    # Right: the work itself
    rx, ry, rw, rh = 7.55, 2.0, SLIDE_W - ML - 7.55, 4.45
    if imgs.get("site"):
        box(s, rx, ry, rw, rh, fill="1A1A1D", line=LINE2, radius=0.14)
        for i, c in enumerate(("FF5F57", "FEBC2E", "28C840")):
            circle(s, rx + 0.25 + i * 0.2, ry + 0.24, 0.05, fill=c)
        image_cover(s, imgs["site"], rx + 0.1, ry + 0.5, rw - 0.2, rh - 0.6, border=None)
        real = True
        cap = "A real preview site, generated by the agents"
    else:
        real = _site_mock(s, rx, ry, rw, rh, L, imgs)
        sc = L.get("showcase")
        cap = (f"Built by the agents for {trunc(sc.get('name', ''), 30)} — real brand data, live"
               if real else "Illustration of a preview site · real previews render live in the demo")
    text(s, rx, ry + rh + 0.12, rw, 0.3, cap, size=9.5, color=MUTED, align="c")
    footer(s, 3)
    cost_line = (f"about {say_money(cps)} of model spend per site today" if cps is not None
                 else "and our CFO agent prices every site live")
    notes(s, f"""So we flipped it. With agents, doing the work first is nearly free — {cost_line}. We build the
    finished site, then show it to the owner. The work is the pitch. Love it? Claim it for forty-nine dollars.
    If not, one click removes it.""")


def _mission_schematic(s, x, y, w, h):
    """Editable schematic of Mission Control used until a real screenshot exists."""
    box(s, x, y, w, h, fill="0E0E10", line=LINE2, radius=0.12)
    # top bar
    text(s, x + 0.25, y + 0.14, 2.5, 0.3, [[("Cold Open", {"font": SERIF, "size": 15}),
                                            ("   mission control", {"size": 8, "color": MUTED})]], size=12)
    for i, lab in enumerate(("Scout the block", "Run the block", "Live challenge")):
        bw = 1.05
        bx = x + w - 0.25 - (3 - i) * (bw + 0.1) + 0.1
        box(s, bx, y + 0.15, bw, 0.28, fill=SIGNAL if i == 2 else PANEL2, line=SIGNAL if i == 2 else LINE2,
            radius=0.14)
        text(s, bx, y + 0.15, bw, 0.28, lab, size=7, bold=i == 2, color=BG if i == 2 else TEXT, align="c",
             anchor="m")
    # stats ribbon
    labels = ["Scouted", "Built", "Taste", "Contacted", "Replied", "Paid", "Revenue", "Spend"]
    rw = (w - 0.5) / len(labels)
    for i, lab in enumerate(labels):
        rx = x + 0.25 + i * rw
        box(s, rx, y + 0.58, rw - 0.06, 0.44, fill=PANEL, line=LINE, radius=0.05)
        text(s, rx + 0.08, y + 0.6, rw - 0.2, 0.2, lab.upper(), size=5.5, color=MUTED, spc=100)
        text(s, rx + 0.08, y + 0.78, rw - 0.2, 0.2, "·", size=8, color=MONEY if lab == "Revenue" else TEXT)
    # columns
    cy0 = y + 1.16
    ch = h - (cy0 - y) - 0.22
    mw, gw = (w - 0.5) * 0.31, (w - 0.5) * 0.41
    chw = (w - 0.5) - mw - gw - 0.2
    mx = x + 0.25
    box(s, mx, cy0, mw, ch, fill="101013", line=LINE, radius=0.06)
    ccx, ccy = mx + mw / 2, cy0 + ch / 2
    rmax = min(mw, ch) * 0.44
    for fr in (1.0, 0.66, 0.33):
        circle(s, ccx, ccy, rmax * fr, line=LINE2, lw=0.5, dash=True)
    circle(s, ccx, ccy, 0.06, fill=SIGNAL)
    text(s, mx + 0.1, cy0 + ch - 0.28, mw - 0.2, 0.22, "MAP · OPENSTREETMAP", size=6, color=MUTED, spc=150)
    gx = mx + mw + 0.1
    cw_, chh = (gw - 0.1) / 2, (ch - 0.2) / 3
    for r in range(3):
        for c in range(2):
            cx_ = gx + c * (cw_ + 0.1)
            cyy = cy0 + r * (chh + 0.1)
            box(s, cx_, cyy, cw_, chh, fill=PANEL, line=LINE, radius=0.05)
            box(s, cx_ + 0.06, cyy + 0.06, cw_ - 0.12, chh * 0.45, fill="1E1E22")
            circle(s, cx_ + cw_ - 0.22, cyy + chh * 0.45 + 0.22, 0.12, line=MONEY, lw=1.25)
            box(s, cx_ + 0.08, cyy + chh * 0.45 + 0.14, cw_ * 0.45, 0.07, fill=LINE2)
            box(s, cx_ + 0.08, cyy + chh * 0.45 + 0.28, cw_ * 0.3, 0.06, fill=LINE)
    hx = gx + gw + 0.1
    box(s, hx, cy0, chw, ch, fill="101013", line=LINE, radius=0.06)
    agents = [(n[:2], c) for n, c in AGENT.items()]
    step = (ch - 0.25) / len(agents)
    for i, (m, col) in enumerate(agents):
        yy = cy0 + 0.15 + i * step
        circle(s, hx + 0.2, yy + 0.1, 0.09, fill=PANEL2, line=col, lw=0.75)
        box(s, hx + 0.36, yy + 0.04, (chw - 0.5) * (0.9 if i % 2 else 0.65), 0.05, fill=LINE2)
        box(s, hx + 0.36, yy + 0.13, (chw - 0.5) * (0.5 if i % 2 else 0.8), 0.04, fill=LINE)


def s04_demo(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s)
    kicker(s, "The demo")
    title(s, "Mission Control: one block, live.", size=44)

    fx, fy, fw = ML, 2.0, 7.95
    fh = fw * 9 / 16
    if imgs.get("mission"):
        image_cover(s, imgs["mission"], fx, fy, fw, fh)
        cap = "Live Mission Control" + (" · " + L["asof"] if L.get("live") else "")
    else:
        _mission_schematic(s, fx, fy, fw, fh)
        cap = "Schematic — the live dashboard is shown in the demo"
    text(s, fx, fy + fh + 0.1, fw, 0.3, cap, size=9.5, color=MUTED)

    rx = fx + fw + 0.45
    rw = SLIDE_W - ML - rx
    items = [
        ("Map", "Real businesses around 101 Townsend St, scouted live from OpenStreetMap."),
        ("Site cards", "Every generated site with its hero, taste score, status and claim link."),
        ("Agent channel", "Every decision, streamed over WebSocket as it happens."),
        ("Live challenge", "Name any business — a speedrun split timer races the whole pipeline."),
    ]
    iy = fy - 0.02
    for i, (h, d) in enumerate(items):
        text(s, rx, iy, 0.5, 0.3, f"{i + 1:02d}", font=SERIF, size=16, color=SIGNAL, italic=True)
        text(s, rx + 0.48, iy, rw - 0.48, 0.3, h, size=15, bold=True, color=TEXT)
        text(s, rx + 0.48, iy + 0.33, rw - 0.48, 0.62, d, size=11.5, color=MUTED, ls=1.15)
        iy += 1.04
    best = L.get("bestBuildMs")
    box(s, rx, iy + 0.05, rw, 0.62, fill=PANEL, line=LINE, radius=0.1)
    text(s, rx + 0.2, iy + 0.05, 1.9, 0.62, "Fastest build today", size=10.5, color=MUTED, anchor="m")
    text(s, rx + 1.9, iy + 0.05, rw - 2.1, 0.62, fmt_ms(best) if best else "live at demo", font=SERIF,
         size=22 if best else 13, color=MONEY if best else WARN, align="r", anchor="m")
    footer(s, 4)
    speed = (f"Our fastest end-to-end build today: {say_ms(best)}." if best
             else "And the live challenge races the whole pipeline against the clock.")
    notes(s, f"""This is Mission Control. On the left, a map of real businesses around 101 Townsend, straight from
    OpenStreetMap. In the middle, every site the agents built, with its taste score. On the right, the agents
    talking to each other, live over WebSocket. {speed}""")


def s05_agents(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s)
    kicker(s, "The team")
    title(s, [("Six agents do the work. ", {}), ("One counts the money.", {"italic": True, "color": MONEY})],
          size=40, h=0.8)

    agents = [
        ("Sc", "Scout", "Finds independent businesses on the block; skips chains.", "OpenStreetMap"),
        ("Ar", "Archivist", "Reads their real website: colors, voice, offerings.", "Brand extraction"),
        ("Bu", "Builder", "Composes a full site from the brand kit.", "SiteSpec + theme"),
        ("Cr", "Critic", "Scores taste, bans slop, sends notes back.", "Gate ≥ 85"),
        ("Di", "Director", "Directs the hero visual, optional video ad.", "FLUX · Higgsfield"),
        ("Cl", "Closer", "Writes an honest pitch with a checkout link.", "Stripe"),
    ]
    gap = 0.3
    nw = (CW - 5 * gap) / 6
    ny, nh = 2.35, 2.75
    for i, (m, name, job, tool) in enumerate(agents):
        col = AGENT[name]
        x = ML + i * (nw + gap)
        is_critic = name == "Critic"
        box(s, x, ny, nw, nh, fill=PANEL, line=col if is_critic else LINE, lw=1.25 if is_critic else 0.75,
            radius=0.12)
        monogram(s, x + 0.25 + 0.3, ny + 0.55, 0.3, m, col, filled=is_critic, size=12)
        text(s, x + 0.25, ny + 1.02, nw - 0.4, 0.42, name, font=SERIF, size=21, color=TEXT)
        text(s, x + 0.25, ny + 1.46, nw - 0.4, 0.8, job, size=11, color=MUTED, ls=1.12)
        text(s, x + 0.25, ny + nh - 0.42, nw - 0.35, 0.25, tool, size=8.5, bold=True, color=col, spc=120,
             caps=True)
        if i < 5:
            ax = x + nw
            if agents[i + 1][1] == "Critic":
                # Builder <-> Critic loop
                line(s, ax + 0.03, ny + 0.45, ax + gap - 0.03, ny + 0.45, color=AGENT["Critic"], w=1.5, arrow=True)
                line(s, ax + 0.03, ny + 0.68, ax + gap - 0.03, ny + 0.68, color=AGENT["Critic"], w=1.5, head=True)
            else:
                line(s, ax + 0.03, ny + 0.55, ax + gap - 0.03, ny + 0.55, color=DIM, w=1.25, arrow=True)
    # loop label above Builder<->Critic
    bx = ML + 2 * (nw + gap)
    text(s, bx + nw - 0.6, ny - 0.36, 1.5, 0.28, "↻ until score ≥ 85", size=10, bold=True, color=AGENT["Critic"],
         align="c")

    # CFO strip
    cy = 5.45
    box(s, ML, cy, CW, 0.95, fill=PANEL, line=LINE, radius=0.12)
    monogram(s, ML + 0.55, cy + 0.475, 0.28, "CF", AGENT["CFO"], size=11)
    text(s, ML + 1.05, cy + 0.12, 7.6, 0.35, "CFO", font=SERIF, size=18, color=TEXT)
    text(s, ML + 1.05, cy + 0.48, 7.8, 0.35, "Prices every model call and image, and tracks spend against revenue in real time.",
         size=11.5, color=MUTED)
    if L.get("live"):
        rev, spend = L.get("revenueCents", 0), L.get("spendCents", 0)
        text(s, ML + CW - 3.9, cy, 3.65, 0.95, [[("spend ", {"color": MUTED, "size": 11}),
                                                  (fmt_small_cost(spend), {"color": TEXT}),
                                                  ("   revenue ", {"color": MUTED, "size": 11}),
                                                  (fmt_money(rev), {"color": MONEY})]],
             font=SERIF, size=20, align="r", anchor="m")
    else:
        text(s, ML + CW - 3.9, cy, 3.65, 0.95, "spend vs revenue · live at demo", size=11, color=WARN, align="r",
             anchor="m")
    footer(s, 5)
    notes(s, """Six agents do the work. Scout finds the business. Archivist reads its real website — colors,
    voice, what they actually sell. Builder composes the site; Critic tears it apart. Director makes the hero image,
    Closer writes an honest pitch with a Stripe link. And the CFO watches every cent.""")


def s06_taste(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s)
    kicker(s, "The taste gate")
    title(s, [("Nothing ships under ", {}), ("85", {"italic": True, "color": SIGNAL}), (".", {})], size=52)

    px, py, pw, ph = ML, 2.2, 7.35, 4.35
    box(s, px, py, pw, ph, fill=PANEL, line=LINE, radius=0.12)
    best = L.get("best")
    scored = L.get("scored") or []
    chart_note = None
    if best and len(best["scores"]) >= 2:
        sc = best["scores"]
        cats = [f"v{v.get('version', i + 1)}" for i, v in enumerate(sc)]
        cd = CategoryChartData()
        cd.categories = cats
        cd.add_series("Critic score", [float(v.get("score", 0)) for v in sc])
        cd.add_series("Gate", [85.0] * len(sc))
        head = f"Self-improvement · {trunc(best.get('name', ''), 34)}"
        chart_note = f"v1 → v{len(sc)}, scored by {sc[-1].get('provider', 'the Critic')}"
        _score_chart(s, cd, px, py, pw, ph, head, kind="line")
    elif scored:
        top = sorted(scored, key=lambda b: b["scores"][-1].get("score", 0), reverse=True)[:8]
        cd = CategoryChartData()
        cd.categories = [trunc(b.get("name", ""), 14) for b in top]
        cd.add_series("Final score", [float(b["scores"][-1].get("score", 0)) for b in top])
        cd.add_series("Gate", [85.0] * len(top))
        _score_chart(s, cd, px, py, pw, ph, f"Final critic scores · {len(scored)} sites", kind="bar")
        chart_note = "Every site passed through the gate"
    else:
        _loop_diagram(s, px, py, pw, ph)

    # Right column
    rx = px + pw + 0.45
    rw = SLIDE_W - ML - rx
    delta = L.get("bestDelta")
    if best and delta is not None and len(best["scores"]) >= 2:
        big, sub = f"+{delta:.0f}", (f"points from v1 to v{len(best['scores'])} — the Critic's notes, applied by "
                                     f"the Builder")
    elif scored:
        big, sub = f"{L['avgFinal']:.0f}", f"average final score across {len(scored)} sites"
    else:
        big, sub = "v1 → vN", "Live score history renders here from today's builds (live at demo)."
    text(s, rx, py - 0.14, rw, 1.1, big, font=SERIF, size=66 if len(big) < 6 else 54, color=MONEY)
    text(s, rx, py + 1.0, rw, 0.5, sub, size=12, color=MUTED, ls=1.15)

    crit = read_critic_info()
    hits = L.get("slopHits") or []
    if hits:
        head = f"Banned slop · {len(hits)} caught today"
    else:
        head = "Banned slop" + (f" · {crit['count']} phrases" if crit["count"] else "")
    text(s, rx, py + 1.66, rw, 0.3, head, size=10, bold=True, color=SIGNAL, spc=250, caps=True)
    slop = hits + [w for w in crit["slop"] if w not in hits]
    chip_top = py + 2.02
    cx, cy = rx, chip_top
    for w in slop:
        w = trunc(w, 32)
        est = 0.36 + len(w) * (10.5 / 72) * 0.53
        if cx + est > rx + rw:
            cx = rx
            cy += 0.44
        if cy > chip_top + 0.44:
            cy -= 0.44
            break
        cx += pill(s, cx, cy, w, color=MUTED, fill=PANEL2, line_c=LINE2, size=10.5, h=0.34, pad=0.18,
                   strike=True) + 0.1
    ty = cy + 0.34 + 0.3
    if crit["rubric"]:
        rub = crit["rubric"].replace(", ", " · ")
        pen = f" · −{crit['penalty']} per banned phrase" if crit["penalty"] else ""
        text(s, rx, ty, rw, 0.55, [[("Rubric  ", {"bold": True, "color": TEXT}), (rub + pen, {})]], size=10.5,
             color=MUTED, ls=1.15)
        ty += 0.58
    text(s, rx, ty, rw, 0.55, [[("Taste Labs-ready  ", {"bold": True, "color": TEXT}),
                                ("TASTE_API_KEY plugs brand-aware scoring into the same gate.", {})]],
         size=10.5, color=MUTED, ls=1.15)
    if chart_note:
        text(s, px + 0.3, py + ph - 0.38, pw - 0.6, 0.25, chart_note, size=9, color=DIM)
    footer(s, 6)
    if best and len(best["scores"]) >= 2:
        sc = best["scores"]
        live_line = (f"You can watch it improve: {best.get('name')} went from {sc[0].get('score', 0):.0f} to "
                     f"{sc[-1].get('score', 0):.0f} in {len(sc)} versions.")
    elif scored:
        live_line = f"Across {len(scored)} sites today, the average final score is {L['avgFinal']:.0f}."
    else:
        live_line = "You can literally watch each site improve, version by version."
    notes(s, f"""The Critic is a taste gate: nothing ships under eighty-five. It penalizes AI slop — words like
    'elevate' and 'nestled' — and sends notes back to the Builder, which tries again. {live_line} And it's ready
    for Taste Labs scoring.""")


def _score_chart(s, cd, px, py, pw, ph, head, *, kind):
    text(s, px + 0.3, py + 0.22, pw - 0.6, 0.3, head, size=10.5, bold=True, color=MUTED, spc=150, caps=True)
    ctype = XL_CHART_TYPE.LINE_MARKERS if kind == "line" else XL_CHART_TYPE.COLUMN_CLUSTERED
    gf = s.shapes.add_chart(ctype, I(px + 0.15), I(py + 0.6), I(pw - 0.35), I(ph - 1.05), cd)
    ch = gf.chart
    style_chart_frame(ch)
    ch.has_legend = False
    ch.font.name = SANS
    ch.font.size = Pt(11)
    ch.font.color.rgb = rgb(MUTED)
    va = ch.value_axis
    va.minimum_scale = 0
    va.maximum_scale = 100
    va.major_unit = 25
    va.has_major_gridlines = True
    va.major_gridlines.format.line.color.rgb = rgb(LINE)
    va.major_gridlines.format.line.width = Pt(0.5)
    va.format.line.fill.background()
    va.tick_labels.font.color.rgb = rgb(DIM)
    va.tick_labels.font.size = Pt(10)
    ca = ch.category_axis
    ca.format.line.color.rgb = rgb(LINE2)
    ca.tick_labels.font.color.rgb = rgb(MUTED)
    ca.tick_labels.font.size = Pt(11 if kind == "line" else 9)
    ca.has_major_gridlines = False
    if kind == "line":
        plot = ch.plots[0]
        main, gate = plot.series[0], plot.series[1]
        main.smooth = False
        main.format.line.color.rgb = rgb(SIGNAL)
        main.format.line.width = Pt(3.25)
        main.marker.style = XL_MARKER_STYLE.CIRCLE
        main.marker.size = 11
        main.marker.format.fill.solid()
        main.marker.format.fill.fore_color.rgb = rgb(SIGNAL)
        main.marker.format.line.color.rgb = rgb(BG)
        dl = main.data_labels
        dl.show_value = True
        dl.position = XL_LABEL_POSITION.ABOVE
        dl.font.size = Pt(14)
        dl.font.bold = True
        dl.font.name = SERIF
        dl.font.color.rgb = rgb(TEXT)
        dl.number_format = "0"
        dl.number_format_is_linked = False
        gate.smooth = False
        gate.format.line.color.rgb = rgb(MONEY)
        gate.format.line.width = Pt(1.5)
        gate.format.line.dash_style = MSO_LINE_DASH_STYLE.DASH
        gate.marker.style = XL_MARKER_STYLE.NONE
    else:
        # bars + gate drawn as a dashed line series overlay is not possible in one plot; colour bars by pass/fail
        plot = ch.plots[0]
        plot.gap_width = 70
        plot.overlap = 0
        bars = plot.series[0]
        bars.format.fill.solid()
        bars.format.fill.fore_color.rgb = rgb(SIGNAL)
        for idx, v in enumerate(bars.values):
            pt = bars.points[idx]
            pt.format.fill.solid()
            pt.format.fill.fore_color.rgb = rgb(MONEY if v >= 85 else SIGNAL)
        gate = plot.series[1]
        gate.format.fill.solid()
        gate.format.fill.fore_color.rgb = rgb(LINE2)
        dl = bars.data_labels
        dl.show_value = True
        dl.position = XL_LABEL_POSITION.OUTSIDE_END
        dl.font.size = Pt(11)
        dl.font.color.rgb = rgb(TEXT)
        dl.number_format = "0"
        dl.number_format_is_linked = False
    text(s, px + pw - 1.9, py + 0.22, 1.6, 0.3, [[("- - ", {"color": MONEY, "bold": True}),
                                                  ("gate 85", {})]], size=10, color=MUTED, align="r")


def _loop_diagram(s, px, py, pw, ph):
    """Fallback when no live scores exist: the loop itself, no numbers."""
    text(s, px + 0.3, py + 0.22, pw - 0.6, 0.3, "The self-improvement loop", size=10.5, bold=True, color=MUTED,
         spc=150, caps=True)
    ny = py + 1.05
    xs = [px + 0.55, px + 2.65, px + 4.75]
    labels = [("v1", "first draft"), ("v2", "critic notes applied"), ("v3", "ships at ≥ 85")]
    for i, (x, (v, sub)) in enumerate(zip(xs, labels)):
        last = i == 2
        box(s, x, ny, 1.75, 1.3, fill=PANEL2, line=MONEY if last else LINE2, lw=1.25 if last else 0.75,
            radius=0.12)
        text(s, x, ny + 0.12, 1.75, 0.6, v, font=SERIF, size=30, color=MONEY if last else TEXT, align="c")
        text(s, x + 0.1, ny + 0.78, 1.55, 0.4, sub, size=10, color=MUTED, align="c")
        if i < 2:
            line(s, x + 1.8, ny + 0.65, xs[i + 1] - 0.05, ny + 0.65, color=SIGNAL, w=1.5, arrow=True)
    text(s, px + 0.55, ny + 1.65, pw - 1.1, 1.2, [
        [("Critic: ", {"bold": True, "color": SIGNAL}),
         ("score < 85 → notes that quote the exact offending text → Builder rebuilds, up to 3 versions.", {})],
        [("Every version is recorded, so the improvement is visible — v1 → vN.", {})],
    ], size=11.5, color=MUTED, ls=1.2, after=4)


def _badges(L):
    cfg = L.get("config") if isinstance(L.get("config"), dict) else {}
    integ = cfg.get("integrations") or {}
    have = bool(integ)
    rows = [
        ("Cloudflare Workers", "router + static assets", True),
        ("Agents SDK · Durable Objects", "HQ state, SQLite, WebSocket", True),
        ("Workers AI", "Llama 3.3 70B · gpt-oss-120b · FLUX", integ.get("workersAI", True)),
        ("Workers KV", "hero images + media", True),
        ("Stripe", "Payment Links · Checkout · webhooks", bool(integ.get("stripeWebhook") or integ.get("stripeApi")) or have),
        ("Brainbase", "managed-agent second opinion (/v2/threads)", integ.get("brainbase")),
        ("LLM brain", "Claude · OpenAI · Workers AI (auto-routed)", bool(integ.get("claude") or integ.get("openai") or integ.get("workersAI"))),
    ]
    return rows, have


def s07_arch(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s)
    rows, have_cfg = _badges(L)
    notes_txt = """It's all on Cloudflare. A Worker routes everything to one Durable Object built on the Agents SDK —
    SQLite state and a WebSocket broadcast. KV stores the media, and the brain is routed automatically: Claude, OpenAI
    or Workers AI, whichever key is present. Stripe handles checkout with signature-verified webhooks, and a Brainbase
    managed agent gives every finished site an independent second opinion."""
    if imgs.get("arch"):
        # Title across the top, stack list left, the full diagram right.
        kicker(s, "Architecture")
        title(s, [("One Worker. One Durable Object. ", {}), ("Zero servers.", {"italic": True, "color": SIGNAL})],
              size=36, h=0.7)
        top, bottom = 1.95, 6.72
        im = Image.open(imgs["arch"])
        ar = im.size[0] / im.size[1]
        fh = bottom - top
        fw = fh * ar
        lw = 3.3
        if fw > CW - lw - 0.4:
            fw = CW - lw - 0.4
            fh = fw / ar
        fx = SLIDE_W - ML - fw
        fy = top + (bottom - top - fh) / 2
        box(s, fx - 0.06, fy - 0.06, fw + 0.12, fh + 0.12, fill=BG, line=LINE2, radius=0.08)
        s.shapes.add_picture(str(imgs["arch"]), I(fx), I(fy), I(fw), I(fh))
        lw = fx - 0.4 - ML
        n = len(rows)
        rh, rg = 0.6, 0.14
        ly = fy + (fh - (n * rh + (n - 1) * rg) - (0.35 if have_cfg else 0)) / 2
        for lab, sub, on in rows:
            dotc = MONEY if (on and have_cfg) else (SIGNAL if not have_cfg else DIM)
            box(s, ML, ly, lw, rh, fill=PANEL, line=LINE, radius=0.1)
            circle(s, ML + 0.24, ly + rh / 2, 0.055, fill=dotc)
            text(s, ML + 0.44, ly + 0.07, lw - 0.55, 0.26, lab, size=11.5, bold=True, color=TEXT)
            text(s, ML + 0.44, ly + 0.33, lw - 0.55, 0.22, sub, size=9, color=MUTED)
            ly += rh + rg
        if have_cfg:
            text(s, ML, ly + 0.02, lw, 0.25, "● green = configured on the live deploy", size=8.5, color=MONEY)
        footer(s, 7)
        notes(s, notes_txt)
        return

    kicker(s, "Architecture")
    title(s, [("One Worker. One Durable Object. ", {}), ("Zero servers.", {"italic": True, "color": SIGNAL})],
          size=38, h=0.8)
    ax, ay, aw, ah = ML, 1.95, CW, 3.95
    _arch_native(s, ax, ay, aw, ah)
    bx, by = ML, 6.18
    for lab, sub, on in rows:
        dotc = MONEY if (on and have_cfg) else (SIGNAL if not have_cfg else DIM)
        bx += pill(s, bx, by, lab, color=TEXT, fill=PANEL2, line_c=LINE2, size=10.5, h=0.36, pad=0.16,
                   dot=dotc) + 0.12
    footer(s, 7)
    notes(s, notes_txt)


def _node(s, x, y, w, h, head, sub, *, col=TEXT, border=LINE2, fill=PANEL2, head_size=13):
    box(s, x, y, w, h, fill=fill, line=border, radius=0.08)
    text(s, x + 0.14, y + 0.09, w - 0.28, 0.28, head, size=head_size, bold=True, color=col)
    if sub:
        text(s, x + 0.14, y + 0.38, w - 0.28, h - 0.45, sub, size=9, color=MUTED, ls=1.12)


def _arch_native(s, ax, ay, aw, ah):
    box(s, ax, ay, aw, ah, fill="0E0E10", line=LINE, radius=0.12)
    pad = 0.25
    # Column geometry
    c1x, c1w = ax + pad, 2.35
    c2x, c2w = c1x + c1w + 0.45, 1.95
    c4w = 3.05
    c4x = ax + aw - pad - c4w
    c3x = c2x + c2w + 0.45
    c3w = c4x - 0.45 - c3x
    top = ay + 0.5
    hgt = ah - 0.75
    labels = [(c1x, c1w, "Clients"), (c2x, c2w, "Edge"), (c3x, c3w, "Core"), (c4x, c4w, "Models & services")]
    for x, w, lab in labels:
        text(s, x, ay + 0.17, w, 0.25, lab, size=8.5, bold=True, color=DIM, spc=250, caps=True)
    # Clients
    ch = (hgt - 0.3) / 3
    clients = [("Mission Control", "Browser · vanilla JS · Leaflet map · live WebSocket"),
               ("Preview sites  /s/:id", "noindex · Claim $49 · Remove — owner in control"),
               ("Business owner", "Pitch email → Stripe Checkout → /claimed")]
    for i, (h, d) in enumerate(clients):
        _node(s, c1x, top + i * (ch + 0.15), c1w, ch, h, d)
    # Edge
    _node(s, c2x, top, c2w, hgt, "Worker", "", col=SIGNAL, border=SIGNAL)
    routes = ["/api/*", "/agents/hq/main", "/s/:id", "/img/:key", "/claimed", "/api/stripe/webhook", "static assets"]
    text(s, c2x + 0.14, top + 0.45, c2w - 0.28, hgt - 0.6,
         [([(r, {})], {"after": 5}) for r in routes], size=9.5, color=TEXT, font="Courier New")
    # Core (Durable Object)
    box(s, c3x, top, c3w, hgt, fill=PANEL, line=SIGNAL, lw=1.25, radius=0.1)
    text(s, c3x + 0.18, top + 0.1, c3w - 0.36, 0.3, "HQ · Durable Object", size=13, bold=True, color=SIGNAL)
    text(s, c3x + 0.18, top + 0.4, c3w - 0.36, 0.3, "Agents SDK · SQLite state · WebSocket broadcast", size=9,
         color=MUTED)
    ag = [(n, AGENT[n]) for n in ("Scout", "Archivist", "Builder", "Critic", "Director", "Closer")]
    gw = (c3w - 0.36 - 0.15) / 2
    gh = 0.46
    for i, (n, col) in enumerate(ag):
        r, c = divmod(i, 2)
        gx = c3x + 0.18 + c * (gw + 0.15)
        gy = top + 0.85 + r * (gh + 0.13)
        box(s, gx, gy, gw, gh, fill=PANEL2, line=LINE2, radius=0.08)
        circle(s, gx + 0.2, gy + gh / 2, 0.06, fill=col)
        text(s, gx + 0.35, gy, gw - 0.4, gh, n, size=10.5, color=TEXT, anchor="m", bold=True)
    cfo_y = top + 0.85 + 3 * (gh + 0.13)
    box(s, c3x + 0.18, cfo_y, c3w - 0.36, 0.4, fill=PANEL2, line=AGENT["CFO"], radius=0.08, line_alpha=0.6)
    text(s, c3x + 0.33, cfo_y, c3w - 0.5, 0.4, [[("CFO ", {"bold": True, "color": AGENT["CFO"]}),
                                                 ("spend vs revenue on every call", {"color": MUTED})]],
         size=9.5, anchor="m")
    # Services
    sv = [("Workers AI", "Llama 3.3 70B · gpt-oss-120b · FLUX hero images", TEXT),
          ("Claude / OpenAI", "brain auto-routed by key · gpt-image-1 fallback", TEXT),
          ("KV", "Hero images & media", TEXT),
          ("OpenStreetMap + business sites", "Overpass scouting · brand pages", TEXT),
          ("Stripe", "Payment Links · Checkout · HMAC-verified webhook", MONEY),
          ("Optional", "Brainbase review · Higgsfield video · Slack · Taste", MUTED)]
    sh = (hgt - 5 * 0.1) / 6
    for i, (h, d, col) in enumerate(sv):
        yy = top + i * (sh + 0.1)
        box(s, c4x, yy, c4w, sh, fill=PANEL2, line=LINE2, radius=0.06)
        text(s, c4x + 0.14, yy, 1.35, sh, h, size=10, bold=True, color=col, anchor="m")
        text(s, c4x + 1.45, yy, c4w - 1.55, sh, d, size=8.5, color=MUTED, anchor="m", ls=1.05)
    # Arrows
    mid = top + hgt / 2
    for i in range(3):
        yy = top + i * (ch + 0.15) + ch / 2
        line(s, c1x + c1w + 0.04, yy, c2x - 0.04, yy, color=DIM, w=1.0, arrow=True, head=True)
    line(s, c2x + c2w + 0.04, mid, c3x - 0.04, mid, color=SIGNAL, w=1.5, arrow=True, head=True)
    for i in range(6):
        yy = top + i * (sh + 0.1) + sh / 2
        line(s, c3x + c3w + 0.04, mid if False else yy, c4x - 0.04, yy, color=DIM, w=0.9, arrow=True)


def s08_model(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s, "bg_money.jpg")
    kicker(s, "Business model", color=MONEY)
    title(s, [("$49 to claim it. ", {}), ("$19/mo to keep it.", {"italic": True, "color": MONEY})], size=48)

    # Price cards
    cx, cy, cw_, chh = ML, 2.25, 2.85, 4.12
    cards = [
        ("$49", "Launch pack · one-time", ["Your finished site", "Brand kit + hero image",
                                           "Stripe Checkout, live now"], MONEY, "LIVE"),
        ("$19", "per month · keep-alive", ["Edge hosting", "Edits on request",
                                           "Seasonal refreshes"], TEXT, "PLANNED"),
    ]
    for i, (price, sub, bullets, col, tag) in enumerate(cards):
        x = cx + i * (cw_ + 0.3)
        box(s, x, cy, cw_, chh, fill=PANEL, line=MONEY if i == 0 else LINE, lw=1.25 if i == 0 else 0.75,
            radius=0.14)
        pill(s, x + 0.3, cy + 0.3, tag, color=BG if i == 0 else MUTED, fill=MONEY if i == 0 else PANEL2,
             line_c=MONEY if i == 0 else LINE2, size=8.5, h=0.28, pad=0.14, bold=True, char_w=0.085)
        text(s, x + 0.3, cy + 0.8, cw_ - 0.5, 1.1, price, font=SERIF, size=64, color=col)
        text(s, x + 0.3, cy + 1.9, cw_ - 0.5, 0.3, sub, size=12, bold=True, color=TEXT)
        line(s, x + 0.3, cy + 2.42, x + cw_ - 0.3, cy + 2.42, color=LINE2, w=0.75)
        text(s, x + 0.3, cy + 2.62, cw_ - 0.5, 1.3, [([("—  ", {"color": DIM}), (b, {})], {"after": 7})
                                                    for b in bullets], size=12, color=MUTED)

    # Unit economics
    ux = ML + 2 * cw_ + 0.3 + 0.55
    uw = SLIDE_W - ML - ux
    text(s, ux, cy - 0.02, uw, 0.3, "Unit economics per claim", size=10.5, bold=True, color=MUTED, spc=250,
         caps=True)
    price = 4900
    stripe_fee = round(price * 0.029 + 30)
    cps = L.get("costPerSite")
    rows = [("Launch pack price", fmt_money(price, precise=True), TEXT),
            ("Stripe fee (2.9% + 30¢)", "−" + fmt_money(stripe_fee, precise=True), MUTED),
            ("Model spend per site (live CFO)", ("−" + fmt_small_cost(cps)) if cps is not None else "live at demo",
             MUTED if cps is not None else WARN)]
    ry = cy + 0.42
    for lab, val, col in rows:
        text(s, ux, ry, uw - 1.8, 0.4, lab, size=13, color=TEXT if col == TEXT else MUTED, anchor="m")
        text(s, ux + uw - 1.8, ry, 1.8, 0.4, val, font=SERIF, size=17, color=col, align="r", anchor="m")
        line(s, ux, ry + 0.5, ux + uw, ry + 0.5, color=LINE, w=0.75)
        ry += 0.6
    if cps is not None:
        gross = price - stripe_fee - cps
        margin = gross / price * 100
        text(s, ux, ry + 0.05, uw - 1.8, 0.5, "Gross profit per claim", size=13, bold=True, color=TEXT, anchor="m")
        text(s, ux + uw - 2.4, ry + 0.05, 2.4, 0.5, [[(fmt_money(gross, precise=True), {}),
                                                      (f"  {margin:.0f}%", {"size": 14, "color": MUTED})]],
             font=SERIF, size=22, color=MONEY, align="r", anchor="m")
        builds = int((price - stripe_fee) // cps) if cps > 0 else None
    else:
        text(s, ux, ry + 0.05, uw - 1.8, 0.5, "Gross profit per claim", size=13, bold=True, color=TEXT, anchor="m")
        text(s, ux + uw - 1.8, ry + 0.05, 1.8, 0.5, "live at demo", size=12, color=WARN, align="r", anchor="m")
        builds = None
    by = ry + 0.85
    box(s, ux, by, uw, 1.05, fill=PANEL, line=LINE, radius=0.12)
    if builds:
        text(s, ux + 0.3, by, uw - 0.6, 1.05, [[("One claim pays for ", {}),
                                                (f"~{builds:,}", {"color": MONEY, "font": SERIF, "size": 24}),
                                                (" builds nobody buys.", {})]],
             size=13.5, color=TEXT, anchor="m", ls=1.1)
    else:
        text(s, ux + 0.3, by, uw - 0.6, 1.05, [[("Every unclaimed site is our marketing cost — ", {}),
                                                ("and the CFO prices every one live.", {"italic": True, "color": MONEY})]],
             size=13.5, color=TEXT, anchor="m", ls=1.1)
    text(s, ux, by + 1.15, uw, 0.3, "Model spend per site = total CFO spend ÷ sites built, from /api/state. "
                                    "Stripe: " + SOURCES["stripe"], size=8, color=DIM)
    footer(s, 8)
    if cps is not None and builds:
        econ = (f"Each build costs about {say_money(cps)} in model spend, so after Stripe's fee, one claim pays for "
                f"roughly {builds:,} sites nobody buys.")
    else:
        econ = ("Every unclaimed site is our marketing cost, and the CFO prices each one live — one claim covers a "
                "lot of sites nobody buys.")
    notes(s, f"""The model is simple: forty-nine dollars to claim your site — live on Stripe today — and a planned
    nineteen a month to keep it fresh. {econ}""")


def s09_traction(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    background(s)
    live = L.get("live")
    kicker(s, (f"Live from /api/state · {L['asof']}" if live else "Live numbers load at demo time"),
           color=MONEY if live else WARN, w=CW)
    title(s, [("Today, on ", {}), ("one block", {"italic": True}), (".", {})], size=52)

    tiles = [("Scouted", "scouted"), ("Built", "built"), ("Taste-passed", "tastePassed"), ("Contacted", "contacted"),
             ("Replied", "replied"), ("Paid", "paid")]
    gap = 0.22
    tw = (CW - 5 * gap) / 6
    ty, th = 2.25, 1.9
    for i, (lab, key) in enumerate(tiles):
        x = ML + i * (tw + gap)
        paid = key == "paid"
        box(s, x, ty, tw, th, fill=PANEL, line=MONEY if paid else LINE, lw=1.25 if paid else 0.75, radius=0.12)
        if live:
            text(s, x + 0.25, ty + 0.2, tw - 0.4, 1.05, f"{int(L.get(key, 0)):,}", font=SERIF, size=58,
                 color=MONEY if paid else TEXT)
        else:
            text(s, x + 0.25, ty + 0.2, tw - 0.4, 1.05, "—", font=SERIF, size=58, color=DIM)
        text(s, x + 0.25, ty + 1.3, tw - 0.4, 0.3, lab, size=12.5, bold=True, color=TEXT)
        if not live:
            text(s, x + 0.25, ty + 1.55, tw - 0.4, 0.25, "live at demo", size=9.5, color=WARN)
        if i < 5:
            line(s, x + tw + 0.03, ty + th / 2, x + tw + gap - 0.03, ty + th / 2, color=DIM, w=1.0, arrow=True)

    # second row: revenue + spend + speed
    ry, rh = ty + th + 0.3, 1.75
    rw1 = 4.4
    test_mode = paylink_is_test(L)
    box(s, ML, ry, rw1, rh, fill=PANEL, line=MONEY, lw=1.25, radius=0.12)
    text(s, ML + 0.3, ry + 0.2, rw1 - 0.6, 0.3, "Revenue" + (" · Stripe test mode" if test_mode else ""), size=10.5,
         bold=True, color=MONEY, spc=200, caps=True)
    text(s, ML + 0.3, ry + 0.5, rw1 - 0.6, 1.1, fmt_money(L.get("revenueCents")) if live else "live at demo",
         font=SERIF, size=60 if live else 26, color=MONEY if live else WARN, anchor="m")
    rest = [("Model spend", fmt_small_cost(L.get("spendCents")) if live else "—"),
            ("Avg build", fmt_ms(L.get("avgBuildMs")) if live else "—"),
            ("Fastest build", fmt_ms(L.get("bestBuildMs")) if live else "—")]
    ox = ML + rw1 + 0.3
    ow = (SLIDE_W - ML - ox - 2 * 0.22) / 3
    for i, (lab, val) in enumerate(rest):
        x = ox + i * (ow + 0.22)
        box(s, x, ry, ow, rh, fill=PANEL, line=LINE, radius=0.12)
        text(s, x + 0.3, ry + 0.2, ow - 0.5, 0.3, lab, size=10.5, bold=True, color=MUTED, spc=200, caps=True)
        text(s, x + 0.3, ry + 0.55, ow - 0.5, 1.0, val, font=SERIF, size=40, color=TEXT if live else DIM,
             anchor="m")
    text(s, ML, 6.5, CW, 0.3, "Real numbers from the running product — no projections, no seeded data."
         + ("  Payments run through Stripe test mode during the hackathon." if test_mode else ""),
         size=9.5, color=MUTED)
    footer(s, 9)
    if live:
        rev = L.get("revenueCents", 0)
        rev_say = (f"{fmt_money(rev)} in revenue" if rev else "no revenue yet")
        tm = " in Stripe test mode" if test_mode and rev else ""
        body = (f"""Here's today, honestly. We scouted {int(L['scouted'])} businesses and built {int(L['built'])}
        sites; {int(L['tastePassed'])} passed the taste gate. We contacted {int(L['contacted'])}, {int(L['replied'])}
        replied, and {int(L['paid'])} paid — {rev_say}{tm}. These are the live numbers from our API, not a
        projection.""")
    else:
        body = """Here's today, honestly — these tiles are the live numbers from our API: how many businesses we
        scouted, how many sites we built, how many passed the taste gate, how many owners we contacted, who replied,
        and who paid. No projections."""
    notes(s, body)


def s10_vision(prs, L, imgs):
    s = prs.slides.add_slide(prs.slide_layouts[6])
    # docs/hero.png is the README banner (it carries its own wordmark and illustrative numbers), so the
    # closing slide deliberately uses the plain cinematic background instead.
    background(s, "bg_hero.jpg")
    kicker(s, "The vision", y=0.7)
    text(s, ML, 1.2, 8.3, 3.0, [
        ([("Every storefront", {})], {"ls": 0.92}),
        ([("on Earth gets a", {})], {"ls": 0.92}),
        ([("Cold Open", {"italic": True, "color": SIGNAL}), (".", {})], {"ls": 0.92}),
    ], font=SERIF, size=64, color=TEXT)

    text(s, ML, 4.35, 8.2, 0.8, "The work, done before anyone asks. One click to claim it — or remove it.",
         size=15, color=MUTED, ls=1.2)
    # Try it / repo
    rows = [("Try it live", LIVE_HOST, SIGNAL), ("Open source", REPO, TEXT)]
    yy = 5.3
    for lab, val, col in rows:
        text(s, ML, yy, 1.9, 0.4, lab, size=10.5, bold=True, color=MUTED, spc=200, caps=True, anchor="m")
        text(s, ML + 1.95, yy, 6.0, 0.4, val, size=17, bold=True, color=col, anchor="m")
        yy += 0.52
    nxt = "Next: owner opt-in outreach · custom domains · Taste Labs scoring · video ads"
    text(s, ML, 6.45, 8.0, 0.3, nxt, size=10, color=DIM)

    qx, qy, qs = 9.35, 1.35, 3.25
    box(s, qx - 0.25, qy - 0.25, qs + 0.5, qs + 0.5, fill="F4F1EA", radius=0.22)
    qr = ASSETS / "qr.png"
    if qr.exists():
        s.shapes.add_picture(str(qr), I(qx), I(qy), I(qs), I(qs))
    else:
        text(s, qx, qy, qs, qs, LIVE_HOST, size=12, color=BG, align="c", anchor="m")
    text(s, qx - 0.25, qy + qs + 0.45, qs + 0.5, 0.3, "Scan — run the block yourself", size=12, bold=True,
         color=TEXT, align="c")
    text(s, qx - 0.25, qy + qs + 0.8, qs + 0.5, 0.3, "Thank you.", font=SERIF, size=20, italic=True, color=SIGNAL,
         align="c")
    footer(s, 10)
    notes(s, """Our vision: every storefront on Earth gets a Cold Open — the work done before anyone asks. Scan the
    code, pick any business on the block, and watch the agents build it live. It's open source at github dot com
    slash vnmoorthy slash coldopen. Thank you.""")


# --------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--offline", action="store_true", help="skip all network calls")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--state-file", help="use a saved /api/state JSON snapshot instead of fetching")
    ap.add_argument("--config-file", help="use a saved /api/config JSON snapshot")
    args = ap.parse_args()

    print("Cold Open deck")
    ASSETS.mkdir(parents=True, exist_ok=True)
    print("• live data")
    L = load_live(args.offline, args.state_file, args.config_file)
    print(f"  live={L['live']}  asof={L['asof']}")
    print("• assets")
    make_backgrounds()
    if not args.offline:
        download_qr()
    imgs = gather_images(L)
    for k, v in imgs.items():
        if v:
            print(f"  {k}: {v if not isinstance(v, list) else [str(x) for x in v]}")

    prs = Presentation()
    prs.slide_width = I(SLIDE_W)
    prs.slide_height = I(SLIDE_H)
    prs.core_properties.title = "Cold Open — the agency that does the work before the sale"
    prs.core_properties.author = "Cold Open"
    prs.core_properties.subject = "Startup Speedrun Hackathon · Cloudflare HQ · Sep 28 2026"

    for fn in (s01_title, s02_problem, s03_insight, s04_demo, s05_agents, s06_taste, s07_arch, s08_model,
               s09_traction, s10_vision):
        fn(prs, L, imgs)

    out = Path(args.out)
    prs.save(out)
    print(f"• wrote {out}  ({out.stat().st_size / 1024:.0f} KB, {len(prs.slides)} slides, live={L['live']})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
