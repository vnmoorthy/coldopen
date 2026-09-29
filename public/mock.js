/* =====================================================================
   COLD OPEN — design-review mock backend.
   Loaded ONLY when Mission Control is opened with ?mock=1. It simulates
   the HTTP API + WebSocket in memory so the UI can be reviewed without a
   running Worker. Nothing here is ever used by the real product, and the
   UI shows a "Mock data" badge whenever it is active.
   ===================================================================== */

export function createMockBackend() {
  const QS = new URLSearchParams(location.search);
  const HQ = { lat: 37.7786, lon: -122.3893 };
  const now = Date.now();
  let evId = 1;
  let listener = () => {};
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const palettes = {
    brick: { primary: '#B4532A', secondary: '#3B2418', accent: '#F2C36B', background: '#FBF4EA', text: '#23160F' },
    taq: { primary: '#E0412F', secondary: '#1F6F5C', accent: '#FFD23F', background: '#FFF8EC', text: '#1A1A1A' },
    books: { primary: '#2F3E5C', secondary: '#C9B79C', accent: '#B8432F', background: '#F5F0E6', text: '#1D2230' },
    lumen: { primary: '#101418', secondary: '#E8A23A', accent: '#D94B3F', background: '#0E1114', text: '#F4EFE6' },
    tailor: { primary: '#243B35', secondary: '#B89B72', accent: '#E9E2D0', background: '#F7F4EE', text: '#18201D' },
    flor: { primary: '#C2577A', secondary: '#48624A', accent: '#F4C7C3', background: '#FFF7F5', text: '#2A1E22' },
    deli: { primary: '#1E5B3A', secondary: '#F1E4C3', accent: '#D8452E', background: '#FFFBF1', text: '#1B1B1B' },
    cycle: { primary: '#1F4E79', secondary: '#F2A541', accent: '#E4572E', background: '#F6F8FA', text: '#101820' },
  };
  const mkBrand = (name, key, fonts, voice, vibe, tagline, kw, offers, confirmed, signals) => ({
    name, tagline, voice, vibe, palette: palettes[key], fonts, keywords: kw,
    offerings: offers, offeringsConfirmed: confirmed,
    story: `${name} is an independent spot a few minutes from 101 Townsend. This preview only uses what we could read publicly.`,
    sourceSignals: signals,
  });
  const score = (v, s, notes, slop = [], ago = 0) => ({ version: v, score: s, notes, slopHits: slop, provider: 'workers-ai:llama-3.3-70b', at: now - ago });
  const base = (id, name, category, dLat, dLon, extra = {}) => ({
    id, name, category, lat: HQ.lat + dLat, lon: HQ.lon + dLon, address: extra.address || null, website: extra.website || null,
    phone: extra.phone || null, email: extra.email || null, openingHours: extra.openingHours || null, osmId: `node/${1000000 + Math.floor(Math.random() * 8999999)}`,
    osmTags: extra.osmTags || { amenity: category }, status: 'scouted', brand: null, site: null, scores: [], heroImage: null, video: { status: 'none' },
    pitch: null, paymentUrl: null, paymentVerified: false, paidAt: null, amountCents: null, contactedAt: null, repliedAt: null,
    timings: {}, costCents: 0, error: null, createdAt: now - (extra.ago || 0), updatedAt: now - (extra.ago || 0) + 1000, ...extra.over,
  });
  const site = (v, theme, headline) => ({ version: v, theme, headline, subheadline: '', about: '', highlights: [], offeringsTitle: 'Menu', offerings: [], ctaLabel: 'Visit us', hoursText: 'Hours — owner to confirm', seo: { title: headline, description: '' } });
  const pay = (id) => `https://buy.stripe.com/test_cNieV5am70px0O47jK0Ny00?client_reference_id=${id}`;
  const pitch = (name) => ({
    subject: `A concept site for ${name} (already built, yours to keep or delete)`,
    body: `Hi ${name} team,\n\nI walk past you most days on the way to 101 Townsend. I noticed you don't have much of a site, so I built a concept preview using only what's public — your name, hours and the colors on your sign.\n\nIt's here: https://coldopen.vnarasingamoorthy.workers.dev/s/…\n\nIf you like it, it's yours for $49 (domain setup included). If not, one click removes it for good.\n\n— Cold Open`,
  });

  const B = [
    base('brick-and-bean', 'Brick & Bean', 'cafe', 0.0012, -0.0021, { address: '120 Townsend St', website: 'https://brickandbean.example', ago: 3600e3, over: {
      status: 'paid', brand: mkBrand('Brick & Bean', 'brick', { heading: 'Fraunces', body: 'Inter' }, 'warm, neighborly, a little cheeky', 'sunlit brick-wall espresso bar', 'Espresso, pastries and a window seat on Townsend.', ['espresso', 'pastries', 'SoMa', 'morning'], [{ name: 'Espresso drinks', description: 'Classic espresso menu, milk alternatives available' }, { name: 'Pastries', description: 'Baked goods, rotating daily' }], false, ['website title “Brick & Bean — Coffee”', 'theme-color #B4532A', '14 hex swatches (top: #B4532A, #3B2418)', '3 headings', 'OSM amenity=cafe']),
      site: site(2, 'warm', 'Coffee with a brick-wall view.'), scores: [score(1, 74, ['Hero is generic stock-cafe copy — use their own words.', 'Palette ignores the brick red on their sign.'], ['nestled in the heart of'], 3400e3), score(2, 88, ['Headline is specific and short.', 'Warm theme matches the storefront.'], [], 3380e3)],
      heroImage: '/img/mock-brick.svg', pitch: pitch('Brick & Bean'), paymentUrl: pay('brick-and-bean'), paymentVerified: true, paidAt: now - 900e3, amountCents: 4900, contactedAt: now - 3000e3, repliedAt: now - 1800e3,
      timings: { scout: 900, archivist: 6200, builder: 7400, critic: 5100, director: 9800, closer: 2600, total: 32000 }, costCents: 4.1 } }),
    base('oyster-point-taqueria', 'Oyster Point Taqueria', 'restaurant', -0.0009, -0.0013, { address: '85 Second St', ago: 3300e3, over: {
      status: 'replied', brand: mkBrand('Oyster Point Taqueria', 'taq', { heading: 'Archivo Black', body: 'Work Sans' }, 'loud, generous, family-run', 'Baja taco stand energy', 'Baja-style tacos, two blocks from the ballpark.', ['tacos', 'baja', 'lunch', 'ballpark'], [{ name: 'Tacos', description: 'Category-typical taqueria offerings' }], false, ['OSM cuisine=mexican', 'OSM amenity=restaurant', 'name contains “Taqueria”']),
      site: site(2, 'bold', 'Tacos before first pitch.'), scores: [score(1, 81, ['Good energy, but the CTA is buried.'], [], 3200e3), score(2, 90, ['CTA above the fold.', 'Bold theme earns its volume.'], [], 3180e3)],
      heroImage: '/img/mock-taq.svg', pitch: pitch('Oyster Point Taqueria'), paymentUrl: pay('oyster-point-taqueria'), contactedAt: now - 2500e3, repliedAt: now - 600e3,
      timings: { scout: 700, archivist: 3100, builder: 6900, critic: 4400, director: 8800, closer: 2200, total: 26100 }, costCents: 3.6 } }),
    base('second-draft-books', 'Second Draft Books', 'books', 0.0021, 0.0004, { address: '301 Brannan St', website: 'https://seconddraft.example', ago: 3000e3, osmTags: { shop: 'books' }, over: {
      status: 'contacted', brand: mkBrand('Second Draft Books', 'books', { heading: 'DM Serif Display', body: 'Source Serif 4' }, 'bookish, dry wit, unhurried', 'used-book shop with a reading chair', 'Used books, second chances.', ['used books', 'fiction', 'poetry'], [{ name: 'Used fiction', description: 'Browse the shelves' }, { name: 'Poetry corner', description: 'Small-press poetry' }], true, ['website title “Second Draft Books”', 'meta description', '6 headings', 'og:image present']),
      site: site(3, 'editorial', 'Every book deserves a second draft.'), scores: [score(1, 69, ['Reads like a template.', 'Too many adjectives.'], ['a hidden gem', 'curated selection'], 2900e3), score(2, 79, ['Better voice; hero image still generic.'], [], 2880e3), score(3, 87, ['Editorial theme fits.', 'Headline is theirs.'], [], 2860e3)],
      heroImage: '/img/mock-books.svg', pitch: { ...pitch('Second Draft Books') }, email: 'hello@seconddraft.example', paymentUrl: pay('second-draft-books'), contactedAt: now - 1500e3,
      timings: { scout: 800, archivist: 5400, builder: 11200, critic: 9300, director: 9100, closer: 2500, total: 38300 }, costCents: 5.2 } }),
    base('lumen-noodle-bar', 'Lumen Noodle Bar', 'restaurant', -0.0016, 0.0011, { address: '650 Third St', ago: 2400e3, osmTags: { amenity: 'restaurant', cuisine: 'ramen' }, over: {
      status: 'ready', brand: mkBrand('Lumen Noodle Bar', 'lumen', { heading: 'Space Grotesk', body: 'Inter' }, 'late-night, precise, warm', 'neon-lit noodle counter', 'Late-night bowls under warm light.', ['ramen', 'late night', 'counter'], [{ name: 'Ramen', description: 'Category-typical noodle bowls' }], false, ['OSM cuisine=ramen', 'OSM opening_hours', 'no website found']),
      site: site(1, 'bold', 'Late-night bowls, warm light.'), scores: [score(1, 92, ['Passes on the first try: specific, confident, on-brand.'], [], 2300e3)],
      heroImage: '/img/mock-lumen.svg', pitch: pitch('Lumen Noodle Bar'), paymentUrl: pay('lumen-noodle-bar'),
      timings: { scout: 600, archivist: 2900, builder: 6100, critic: 3900, director: 8700, closer: 2100, total: 24300 }, costCents: 2.9 } }),
    base('townsend-tailors', 'Townsend Tailors', 'tailor', 0.0005, 0.0019, { address: '88 King St', ago: 2000e3, osmTags: { shop: 'tailor' }, over: {
      status: 'ready', brand: mkBrand('Townsend Tailors', 'tailor', { heading: 'Cormorant Garamond', body: 'Inter' }, 'precise, quiet, old-school', 'tailor shop with brass fittings', 'Alterations, done right the first time.', ['alterations', 'suits', 'hemming'], [{ name: 'Alterations', description: 'Hemming, taking in, letting out' }], false, ['OSM shop=tailor', 'OSM phone']),
      site: site(2, 'editorial', 'Alterations, done right.'), scores: [score(1, 77, ['Needs more restraint.'], ['state-of-the-art'], 1900e3), score(2, 86, ['Restrained, confident.'], [], 1880e3)],
      heroImage: '/img/mock-tailor.svg', pitch: pitch('Townsend Tailors'), paymentUrl: pay('townsend-tailors'),
      timings: { scout: 700, archivist: 3300, builder: 8100, critic: 6600, director: 9400, closer: 2300, total: 30400 }, costCents: 3.8 } }),
    base('fog-city-florals', 'Fog City Florals', 'florist', -0.0024, -0.0004, { address: '410 Townsend St', ago: 400e3, osmTags: { shop: 'florist' }, over: {
      status: 'critiquing', brand: mkBrand('Fog City Florals', 'flor', { heading: 'Playfair Display', body: 'Inter' }, 'soft, romantic, practical', 'foggy-morning flower stall', 'Flowers for foggy mornings.', ['bouquets', 'weddings'], [{ name: 'Bouquets', description: 'Seasonal arrangements' }], false, ['OSM shop=florist']),
      site: site(1, 'warm', 'Flowers for foggy mornings.'), scores: [], costCents: 1.1 } }),
    base('caltrain-corner-deli', 'Caltrain Corner Deli', 'deli', 0.0031, -0.0009, { address: '700 Fourth St', ago: 300e3, osmTags: { shop: 'deli' }, over: { status: 'building', costCents: 0.6 } }),
    base('mission-bay-cycles', 'Mission Bay Cycles', 'bicycle', -0.0031, 0.0023, { address: '1 Mission Bay Blvd', ago: 200e3, osmTags: { shop: 'bicycle' }, over: { status: 'extracting' } }),
    base('rincon-records', 'Rincon Records', 'music', 0.0036, 0.0017, { address: '205 Brannan St', ago: 150e3, osmTags: { shop: 'music' } }),
    base('pier-40-pilates', 'Pier 40 Pilates', 'fitness', 0.0009, 0.0033, { address: 'Pier 40', ago: 140e3, osmTags: { leisure: 'fitness_centre' } }),
    base('bluebird-bakeshop', 'Bluebird Bakeshop', 'bakery', -0.0012, -0.0031, { address: '255 King St', website: 'https://bluebird.example', ago: 130e3, osmTags: { shop: 'bakery' } }),
    base('night-owl-wine', 'Night Owl Wine Bar', 'bar', -0.0004, 0.0028, { address: '500 Second St', website: 'https://nightowl.example', ago: 1200e3, osmTags: { amenity: 'bar' }, over: { status: 'error', error: 'Website fetch timed out after 8s and the fallback LLM returned invalid JSON twice.' } }),
  ];
  const biz = new Map(B.map((b) => [b.id, b]));

  const lines = [
    ['System', 'info', 'HQ online. Brain: Workers AI (llama-3.3-70b). Images: FLUX-1 schnell.'],
    ['Scout', 'info', 'Walking 450 m around 101 Townsend St — querying OpenStreetMap.'],
    ['Scout', 'success', 'Found 12 independents. Skipped 5 chains (brand:wikidata).'],
    ['Archivist', 'info', 'Fetching brickandbean.example…', 'brick-and-bean'],
    ['Archivist', 'success', 'Read theme-color #B4532A, 14 hex swatches, 3 headings.', 'brick-and-bean'],
    ['Builder', 'info', 'Composing v1 with the warm theme.', 'brick-and-bean'],
    ['Critic', 'warn', 'v1 scored 74. “Hero is generic. Use their own words.” Caught 1 slop phrase.', 'brick-and-bean'],
    ['Builder', 'info', 'Revising → v2 from 2 critic notes.', 'brick-and-bean'],
    ['Critic', 'success', 'v2 scored 88 — cleared the gate.', 'brick-and-bean'],
    ['Director', 'success', 'Hero frame rendered on FLUX in 2.1s.', 'brick-and-bean'],
    ['Closer', 'success', 'Pitch written. $49 checkout attached.', 'brick-and-bean'],
    ['CFO', 'info', 'Brick & Bean cost $0.04 to build. Running spend $0.04.'],
    ['Critic', 'success', 'Lumen Noodle Bar v1 scored 92 on the first pass.', 'lumen-noodle-bar'],
    ['Critic', 'success', 'Second Draft Books v3 scored 87 after two revisions.', 'second-draft-books'],
    ['System', 'warn', 'Night Owl Wine Bar: website fetch timed out after 8s.', 'night-owl-wine'],
    ['Closer', 'money', 'Brick & Bean paid $49.00 — verified with Stripe.', 'brick-and-bean'],
    ['CFO', 'money', 'Revenue $49.00 vs spend $0.19 → ROI 257×.'],
    ['Archivist', 'info', 'Reading Fog City Florals from OSM tags (no website).', 'fog-city-florals'],
    ['Builder', 'info', 'Composing v1 with the warm theme.', 'fog-city-florals'],
    ['Critic', 'info', 'Scoring v1 against the brand kit…', 'fog-city-florals'],
    ['Builder', 'info', 'Composing v1 for Caltrain Corner Deli.', 'caltrain-corner-deli'],
    ['Archivist', 'info', 'Fetching Mission Bay Cycles from OpenStreetMap…', 'mission-bay-cycles'],
  ];
  const events = lines.map(([agent, kind, text, bizId], i) => ({ id: evId++, ts: now - (lines.length - i) * 40e3, agent, kind, text, bizId }));

  function stats() {
    const list = [...biz.values()].filter((b) => b.status !== 'removed');
    const built = list.filter((b) => ['ready', 'contacted', 'replied', 'paid'].includes(b.status));
    const t = built.map((b) => b.timings.total).filter(Boolean);
    return {
      scouted: list.length, built: built.length,
      tastePassed: built.filter((b) => b.scores.length && b.scores[b.scores.length - 1].score >= 85).length,
      contacted: list.filter((b) => ['contacted', 'replied', 'paid'].includes(b.status)).length,
      replied: list.filter((b) => ['replied', 'paid'].includes(b.status)).length,
      paid: list.filter((b) => b.status === 'paid').length,
      revenueCents: list.reduce((s, b) => s + (b.status === 'paid' ? b.amountCents || 0 : 0), 0),
      spendCents: list.reduce((s, b) => s + (b.costCents || 0), 0),
      avgBuildMs: t.length ? t.reduce((a, b) => a + b, 0) / t.length : null,
      bestBuildMs: t.length ? Math.min(...t) : null,
    };
  }
  const snapshot = () => ({ businesses: [...biz.values()].filter((b) => b.status !== 'removed').map(clone), events: events.slice(-200).map(clone), stats: stats() });
  const send = (msg) => setTimeout(() => listener(clone(msg)), 0);
  const emit = (agent, kind, text, bizId, data) => { const e = { id: evId++, ts: Date.now(), agent, kind, text, bizId, data }; events.push(e); send({ type: 'event', event: e }); };
  const put = (b, patch) => { Object.assign(b, patch, { updatedAt: Date.now() }); send({ type: 'business', business: b }); send({ type: 'stats', stats: stats() }); };

  const running = new Set();
  async function pipeline(b, from = 'extracting') {
    if (running.has(b.id)) return;
    running.add(b.id);
    const t0 = Date.now();
    const T = {};
    const mark = (k, s) => { T[k] = Date.now() - s; };
    const order = ['extracting', 'building', 'critiquing', 'directing'];
    const startAt = Math.max(0, order.indexOf(from));
    try {
      let s = Date.now();
      if (startAt <= 0) {
        put(b, { status: 'extracting', scores: [], error: null });
        emit('Archivist', 'info', b.website ? `Fetching ${new URL(b.website).host}… (8s timeout)` : `No website — reading OSM tags for ${b.name}.`, b.id);
        await sleep(1900);
        const key = Object.keys(palettes)[Math.floor(Math.random() * 8)];
        b.brand = b.brand || mkBrand(b.name, key, { heading: 'Fraunces', body: 'Inter' }, 'friendly, direct, local', 'corner-shop warmth', `${b.name}, a few minutes from Townsend.`, [b.category, 'SoMa'], [{ name: `${b.category} staples`, description: 'Category-typical offerings' }], false, [`OSM ${Object.keys(b.osmTags)[0]}=${Object.values(b.osmTags)[0]}`, 'name', 'address']);
        emit('Archivist', 'success', `Brand kit ready: ${b.brand.palette.primary} primary, ${b.brand.fonts.heading} headings, voice “${b.brand.voice}”.`, b.id);
        mark('archivist', s);
      }
      const plan = [71 + Math.floor(Math.random() * 6), 80 + Math.floor(Math.random() * 4), 87 + Math.floor(Math.random() * 6)];
      const notes = [['Hero copy is generic — use their own words.', 'CTA is buried below the fold.'], ['Better. Headline still reads like a template.'], ['Specific, on-brand, confident. Ship it.']];
      let tb = 0, tc = 0;
      for (let v = 1; v <= 3; v++) {
        s = Date.now();
        put(b, { status: 'building' });
        emit('Builder', 'info', v === 1 ? `Composing v1 with the ${['editorial', 'bold', 'warm'][v % 3]} theme.` : `Revising → v${v} from ${notes[v - 2].length} critic notes.`, b.id);
        await sleep(1500);
        b.site = site(v, 'warm', `${b.name}, done properly.`);
        tb += Date.now() - s;
        s = Date.now();
        put(b, { status: 'critiquing' });
        emit('Critic', 'info', `Scoring v${v} against the brand kit…`, b.id);
        await sleep(1300);
        const sc = plan[v - 1];
        b.scores.push({ version: v, score: sc, notes: notes[v - 1], slopHits: v === 1 ? ['nestled in the heart of'] : [], provider: 'workers-ai:llama-3.3-70b', at: Date.now() });
        tc += Date.now() - s;
        if (sc >= 85) { emit('Critic', 'success', `v${v} scored ${sc} — cleared the gate.`, b.id); put(b, {}); break; }
        emit('Critic', 'warn', `v${v} scored ${sc}. “${notes[v - 1][0]}”`, b.id);
      }
      T.builder = tb; T.critic = tc;
      s = Date.now();
      put(b, { status: 'directing' });
      emit('Director', 'info', 'Rendering hero frame on FLUX-1 schnell…', b.id);
      await sleep(2400);
      const imgs = ['brick', 'taq', 'books', 'lumen', 'tailor'];
      put(b, { heroImage: `/img/mock-${imgs[Math.floor(Math.random() * imgs.length)]}.svg` });
      emit('Director', 'success', 'Hero frame rendered and stored in KV.', b.id);
      mark('director', s);
      s = Date.now();
      emit('Closer', 'info', 'Writing an honest pitch — no invented facts.', b.id);
      await sleep(900);
      b.pitch = pitch(b.name);
      b.paymentUrl = pay(b.id);
      emit('Closer', 'success', 'Pitch written. $49 checkout attached.', b.id);
      mark('closer', s);
      T.scout = 600;
      T.total = Date.now() - t0;
      put(b, { status: 'ready', timings: T, costCents: (b.costCents || 0) + 3.4 });
      emit('CFO', 'info', `${b.name} cost $0.03 to build. Running spend ${'$' + (stats().spendCents / 100).toFixed(2)}.`);
    } finally {
      running.delete(b.id);
    }
  }

  const routes = [
    ['GET', /^\/api\/state$/, () => snapshot()],
    ['GET', /^\/api\/config$/, () => ({ publicUrl: 'https://coldopen.vnarasingamoorthy.workers.dev', paymentLink: 'https://buy.stripe.com/test_cNieV5am70px0O47jK0Ny00', hq: { lat: HQ.lat, lon: HQ.lon, label: '101 Townsend St, San Francisco' }, integrations: { claude: false, workersAI: true, stripeApi: false, stripeWebhook: true, slack: true, higgsfield: false, taste: false } })],
    ['POST', /^\/api\/scout$/, async (m, body) => {
      emit('Scout', 'info', `Querying OpenStreetMap within ${body.radius || 450} m of HQ…`);
      await sleep(2200);
      const names = [['Salt & Sprout', 'restaurant'], ['King St Cobbler', 'shoes'], ['Hatch Tea House', 'cafe']];
      const added = [];
      for (const [n, c] of names) {
        const id = n.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (biz.has(id)) continue;
        const b = base(id, n, c, (Math.random() - 0.5) * 0.007, (Math.random() - 0.5) * 0.008, { address: `${100 + Math.floor(Math.random() * 600)} Townsend St` });
        b.createdAt = Date.now(); biz.set(id, b); added.push(b);
        send({ type: 'business', business: b });
      }
      emit('Scout', 'success', `Found ${added.length} new independents. Skipped 2 chains.`);
      send({ type: 'stats', stats: stats() });
      return { added: added.map(clone), total: [...biz.values()].filter((b) => b.status !== 'removed').length };
    }],
    ['POST', /^\/api\/businesses$/, async (m, body) => {
      await sleep(900);
      const id = String(body.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.floor(Math.random() * 900 + 100);
      const b = base(id, body.name, body.category || 'cafe', (Math.random() - 0.5) * 0.006, (Math.random() - 0.5) * 0.006, { address: body.address || '181 Townsend St', website: body.website || null });
      b.createdAt = Date.now();
      biz.set(id, b);
      emit('Scout', 'success', `Found ${b.name} on OpenStreetMap — 180 m from HQ.`, id);
      send({ type: 'business', business: b });
      return clone(b);
    }],
    ['POST', /^\/api\/businesses\/([^/]+)\/build$/, (m) => { const b = biz.get(decodeURIComponent(m[1])); if (!b) throw Object.assign(new Error('Not found'), { status: 404 }); pipeline(b); return { ok: true }; }],
    ['POST', /^\/api\/run-block$/, (m, body) => {
      const list = [...biz.values()].filter((b) => b.status === 'scouted').slice(0, body.limit || 8);
      emit('System', 'info', `Running the block: ${list.length} businesses, concurrency 3.`);
      (async () => { const q = [...list]; const worker = async () => { while (q.length) await pipeline(q.shift()); }; await Promise.all([worker(), worker(), worker()]); })();
      return { ok: true };
    }],
    ['POST', /^\/api\/businesses\/([^/]+)\/pitch$/, async (m) => { const b = biz.get(decodeURIComponent(m[1])); await sleep(1200); b.pitch = { subject: `${pitch(b.name).subject} — v2`, body: pitch(b.name).body }; emit('Closer', 'success', 'Rewrote the pitch.', b.id); put(b, {}); return clone(b); }],
    ['POST', /^\/api\/businesses\/([^/]+)\/status$/, async (m, body) => { const b = biz.get(decodeURIComponent(m[1])); await sleep(300); put(b, { status: body.status, [body.status === 'contacted' ? 'contactedAt' : 'repliedAt']: Date.now() }); emit('Closer', 'info', `${b.name} marked ${body.status}.`, b.id); return clone(b); }],
    ['POST', /^\/api\/businesses\/([^/]+)\/video$/, async () => { await sleep(300); throw Object.assign(new Error('Higgsfield key not configured'), { status: 400 }); }],
    ['POST', /^\/api\/businesses\/([^/]+)\/video-url$/, async (m, body) => { const b = biz.get(decodeURIComponent(m[1])); await sleep(300); put(b, { video: { status: 'ready', url: body.url, provider: 'external' } }); emit('Director', 'success', 'External ad attached.', b.id); return clone(b); }],
    ['DELETE', /^\/api\/businesses\/([^/]+)$/, async (m) => { const b = biz.get(decodeURIComponent(m[1])); await sleep(400); b.status = 'removed'; send({ type: 'removed', id: b.id }); emit('System', 'warn', `${b.name}'s preview removed.`); send({ type: 'stats', stats: stats() }); return { ok: true }; }],
    ['POST', /^\/api\/reset$/, async () => { await sleep(500); biz.clear(); events.length = 0; send({ type: 'snapshot', snapshot: snapshot() }); return { ok: true }; }],
  ];

  function markPaid(id) {
    const b = biz.get(id);
    if (!b) return;
    put(b, { status: 'paid', paidAt: Date.now(), amountCents: 4900, paymentVerified: false });
    emit('Closer', 'money', `${b.name} paid $49.00 via Stripe Checkout.`, b.id, { amountCents: 4900 });
  }

  if (QS.get('open') === 'empty') { biz.clear(); events.length = 0; }

  return {
    async request(method, path, body) {
      const url = new URL(path, location.origin);
      for (const [m, re, fn] of routes) {
        const match = url.pathname.match(re);
        if (m === method && match) {
          await sleep(120 + Math.random() * 200);
          return clone(await fn(match, body || {}));
        }
      }
      throw Object.assign(new Error(`Mock has no route for ${method} ${url.pathname}`), { status: 404 });
    },
    connect(onMessage) {
      listener = onMessage;
      send({ type: 'cf_agent_identity', name: 'main', agent: 'hq' });
      send({ type: 'snapshot', snapshot: snapshot() });
      setTimeout(() => {
        for (const b of biz.values()) if (['extracting', 'building', 'critiquing', 'directing'].includes(b.status)) pipeline(b, b.status);
      }, 1500);
    },
    autopilot(ui) {
      const open = QS.get('open');
      if (open === 'challenge') { ui.openChallenge(); setTimeout(() => ui.chStart({ name: 'Harbor Lane Coffee', website: 'https://example.com' }), 400); }
      if (open === 'challenge-form') ui.openChallenge();
      if (open === 'drawer') ui.openDrawer(QS.get('id') || 'second-draft-books');
      if (open === 'money') setTimeout(() => markPaid('oyster-point-taqueria'), 1500);
    },
  };
}
