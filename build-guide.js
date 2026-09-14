// build-guide.js v2 — regenerates guide.html from data.json + index.html design system.
// Deterministic solver copy (1 pass, no randomization) so rebuilds are byte-stable.
const fs = require('fs'), path = require('path');
const ROOT = __dirname;
const read = f => { const p = path.join(ROOT, f); return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safeId = s => Buffer.from(unescape(encodeURIComponent(s)), 'binary').toString('base64').replace(/[^a-zA-Z0-9]/g, '');
const compact = n => n == null ? '—' : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'K' : String(n);

const data = JSON.parse(read('data.json') || '{"challenges":[],"books":[]}');
const index = read('index.html');
// Best practice: template = guide.template.html; root guide.html is the build artifact.
// Fallback keeps repos mid-migration working.
const templateFile = read('guide.template.html') ? 'guide.template.html' : 'guide.html';
let guide = read(templateFile);
if (!guide) { console.error('[guide] template missing (guide.template.html / guide.html) — aborting.'); process.exit(1); }

// --- marker injection ---
function inject(html, name, content) {
  const S = name + '_START', E = name + '_END';
  const si = html.indexOf(S); if (si === -1) { console.warn('[guide] missing marker', name); return html; }
  const so = si + S.length; const ei = html.indexOf(E, so); if (ei === -1) { console.warn('[guide] missing end marker', name); return html; }
  return html.slice(0, so) + content + html.slice(ei);
}
// --- extract design system from index.html ---
function cssBlock(src, sel) { const i = src.indexOf(sel); if (i === -1) return ''; const j = src.indexOf('{', i); if (j === -1) return ''; let d = 0; for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); } } return ''; }
function grab(src, a, b) { const i = src.indexOf(a); if (i === -1) return ''; const j = src.indexOf(b, i); if (j === -1) return ''; return src.slice(i + a.length, j); }
const tokens = cssBlock(index, ':root') + '\n' + cssBlock(index, 'html.dark');
const sprite = grab(index, '<!-- ICON_SPRITE_START -->', '<!-- ICON_SPRITE_END -->');
if (!sprite) console.warn('[guide] icon sprite not found in index.html (add ICON_SPRITE markers).');

// --- season info ---
function seasonInfo(d) {
  let name = d.seasonName || d.season || null; const end = d.seasonEnd || null;
  if (!name) {
    const hay = (d.challenges || []).map(c => (c.name || '') + ' ' + (c.id || '')).join(' ') + ' ' + (d.title || '');
    const m = hay.match(/\b(Summer|Fall|Autumn|Winter|Spring)\b/i); const ym = hay.match(/\b(20\d{2})\b/);
    const year = ym ? ym[1] : (d.lastUpdated ? new Date(d.lastUpdated).getFullYear() : new Date().getFullYear());
    if (m) name = (m[1] === 'Autumn' ? 'Fall' : m[1]) + ' ' + year;
    else { const ref = d.lastUpdated ? new Date(d.lastUpdated) : new Date(); const mo = ref.getMonth(); const s = (mo <= 1 || mo === 11) ? 'Winter' : (mo <= 4 ? 'Spring' : (mo <= 7 ? 'Summer' : 'Fall')); name = s + ' ' + ref.getFullYear(); }
  }
  return { name, end };
}
const { name: seasonName, end: seasonEnd } = seasonInfo(data);
const updated = data.lastUpdated ? new Date(data.lastUpdated).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';

// --- dataset construction ---
const books = (data.books || []).map(b => ({ ...b, id: 'b_' + safeId(b.title + (b.author || '')) }));
const cats = (data.challenges || []).map(c => {
  const catBooks = books.filter(b => (b.challenges || []).includes(c.id)).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  const rated = catBooks.filter(b => b.rating != null);
  const shortest = catBooks.filter(b => b.pages != null).sort((a, b) => a.pages - b.pages)[0];
  const topRated = catBooks.filter(b => b.rating != null).sort((a, b) => (b.rating - a.rating) || ((b.ratingCount || 0) - (a.ratingCount || 0)))[0];
  const standaloneCount = catBooks.filter(b => { const rel = (b.challenges || []).filter(cc => (data.challenges || []).some(x => x.id === cc)); return rel.length === 1 && rel[0] === c.id; }).length;
  return {
    ...c, books: catBooks,
    avg: rated.length ? (rated.reduce((s, b) => s + b.rating, 0) / rated.length).toFixed(2) : null,
    pages: catBooks.reduce((s, b) => s + (b.pages || 0), 0),
    shortest, topRated, standaloneCount
  };
});
const catName = id => { const c = cats.find(x => x.id === id); return c ? c.name : id; };

// --- overlap combos ---
const comboMap = new Map();
books.forEach(b => {
  const cs = b.challenges || []; if (cs.length < 2) return;
  for (let i = 1; i < (1 << cs.length); i++) { const sub = []; for (let j = 0; j < cs.length; j++) if ((i >> j) & 1) sub.push(cs[j]); if (sub.length >= 2) { const key = sub.slice().sort().join(' + '); if (!comboMap.has(key)) comboMap.set(key, { cats: sub.slice().sort(), books: [] }); comboMap.get(key).books.push(b); } }
});
const combos = Array.from(comboMap.values()).sort((a, b) => b.cats.length - a.cats.length || b.books.length - a.books.length);
const overlapBookSet = new Set(); combos.forEach(c => c.books.forEach(b => overlapBookSet.add(b.id)));

// --- deterministic solver (mirrors app's runSinglePass with forceRandom=false) ---
function deterministicPass(mode, useLeastPages, activeCatIds) {
  const activeCats = new Set(activeCatIds);
  const uncovered = new Set(activeCats);
  const selected = [];
  const failedSingleCategories = [];
  const orderNotes = [];
  const extraReads = [];
  const available = books.filter(b => { const rel = (b.challenges || []).filter(c => activeCats.has(c)); return rel.length > 0 ? { ...b, categories: rel } : null; }).filter(Boolean);
  if (mode === 'overlap') {
    let pool = available.slice();
    while (uncovered.size > 0 && pool.length > 0) {
      let bestScore = Infinity, maxCov = 0, cands = [];
      for (const b of pool) {
        const covCats = b.categories.filter(c => uncovered.has(c)); const cov = covCats.length; if (cov === 0) continue;
        if (useLeastPages) { const cost = (b.pages || 320) / cov; if (cost < bestScore - 0.0001) { bestScore = cost; cands = [b]; } else if (Math.abs(cost - bestScore) <= 0.0001) cands.push(b); }
        else { if (cov > maxCov) { maxCov = cov; cands = [b]; } else if (cov === maxCov) cands.push(b); }
      }
      if (cands.length === 0) break;
      const chosen = cands.sort((a, b) => (b.rating || 0) - (a.rating || 0))[0];
      selected.push(chosen); chosen.categories.forEach(c => uncovered.delete(c)); pool = pool.filter(b => b.id !== chosen.id);
    }
  } else {
    const takenCats = new Set();
    const pureCount = c => available.filter(b => b.categories.length === 1 && b.categories[0] === c).length;
    for (const pb of available) {
      const freeCats = pb.categories.filter(c => uncovered.has(c) && !takenCats.has(c));
      if (freeCats.length === 0) { if (pb.categories.some(c => uncovered.has(c))) { extraReads.push(pb); selected.push(pb); } continue; }
      let best = freeCats[0], bestN = Infinity;
      for (const c of freeCats) { const n = pureCount(c); if (n < bestN) { bestN = n; best = c; } }
      takenCats.add(best); selected.push(pb); uncovered.delete(best);
      const others = pb.categories.filter(c => c !== best && activeCats.has(c));
      if (others.length > 0) orderNotes.push({ book: pb, collects: best, others });
    }
    const pureBooks = available.filter(b => b.categories.length === 1);
    for (const c of Array.from(uncovered)) {
      if (!uncovered.has(c)) continue;
      const cands = pureBooks.filter(b => b.categories.includes(c));
      if (cands.length > 0) {
        const pick = cands.sort((a, b) => { if (useLeastPages) return (a.pages || 320) - (b.pages || 320); return (b.rating || 0) - (a.rating || 0); })[0];
        selected.push(pick); uncovered.delete(c);
        const idx = pureBooks.findIndex(b => b.id === pick.id); if (idx !== -1) pureBooks.splice(idx, 1);
      } else failedSingleCategories.push(c);
    }
  }
  const totalPages = selected.reduce((s, b) => s + (b.pages || 0), 0);
  return { selected, uncovered: Array.from(uncovered), failedSingleCategories, orderNotes, extraReads, totalPages };
}

const activeCatIds = cats.map(c => c.id);
const shortestPath = deterministicPass('overlap', false, activeCatIds);
const onePerPath = deterministicPass('single', false, activeCatIds);
const readLastIds = new Set((onePerPath.orderNotes || []).map(n => n.book.id));
const extraIds = new Set((onePerPath.extraReads || []).map(b => b.id));

// --- markup builders ---
const rowLi = b => `<li><a href="${esc(b.url || '#')}" target="_blank" rel="noopener">${esc(b.title)}</a><span class="g-row-meta">— ${esc(b.author || 'Unknown author')} · ★ ${b.rating != null ? b.rating.toFixed(2) : '—'} · ${b.pages != null ? b.pages + 'p' : '—'}</span></li>`;
const planLi = (b, note) => `<li><a href="${esc(b.url || '#')}" target="_blank" rel="noopener">${esc(b.title)}</a><span class="g-plan-row-meta">by ${esc(b.author || 'Unknown author')} · ★ ${b.rating != null ? b.rating.toFixed(2) : '—'} · ${b.pages != null ? b.pages + 'p' : '—'}${note ? ' · ' + note : ''} · covers ${(b.categories || []).map(catName).join(', ')}</span></li>`;

// Shortest Path list (in the order the solver picked them)
const shortestList = shortestPath.selected;
const shortestHtml = `<div class="g-plan" data-name="Shortest Path" data-meta="${shortestList.length} books · ~${shortestPath.totalPages.toLocaleString()} pages">
<div class="g-plan-head">
<h3><svg class="ic" aria-hidden="true"><use href="#i-link"/></svg> Shortest Path</h3>
<div class="g-plan-meta"><span>${shortestList.length} books</span><span>~${shortestPath.totalPages.toLocaleString()} pages</span><span>Covers ${cats.length - shortestPath.uncovered.length}/${cats.length} goals</span></div>
<button class="btn outline sm g-copy" type="button">Copy list</button>
</div>
${shortestList.length ? `<ol class="g-plan-list">${shortestList.map(b => planLi(b, '')).join('')}</ol>` : '<div style="padding:20px;color:var(--muted-fg);font-size:13px;">No overlaps available in this season — every category requires a standalone book.</div>'}
</div>`;

// One-Per-Challenge list
const opcList = onePerPath.selected.filter(b => !extraIds.has(b.id));
const opcListHtml = opcList.map(b => planLi(b, readLastIds.has(b.id) ? 'read last' : '')).join('');
const opcExtraHtml = onePerPath.extraReads.map(b => planLi(b, 'extra read')).join('');
const onePerHtml = `<div class="g-plan" data-name="One Book Per Challenge" data-meta="${opcList.length} books · ~${onePerPath.totalPages.toLocaleString()} pages">
<div class="g-plan-head">
<h3><svg class="ic" aria-hidden="true"><use href="#i-swap"/></svg> One Book Per Challenge</h3>
<div class="g-plan-meta"><span>${opcList.length} books${onePerPath.extraReads.length ? ' +' + onePerPath.extraReads.length + ' extra' : ''}</span><span>~${onePerPath.totalPages.toLocaleString()} pages</span><span>Covers ${cats.length - onePerPath.uncovered.length}/${cats.length} goals</span></div>
<button class="btn outline sm g-copy" type="button">Copy list</button>
</div>
${opcList.length ? `<ol class="g-plan-list">${opcListHtml}${opcExtraHtml}</ol>` : '<div style="padding:20px;color:var(--muted-fg);font-size:13px;">No standalone books exist for this season — every book overlaps categories.</div>'}
</div>`;

// Categories with stat cards + standalone pool
let bookLists = '';
cats.forEach((c, i) => {
  const stats = [];
  if (c.avg) stats.push('avg ★ ' + c.avg);
  if (c.pages) stats.push('~' + c.pages.toLocaleString() + ' pages');
  if (c.shortest) stats.push('shortest: ' + c.shortest.pages + 'p — ' + c.shortest.title);
  if (c.topRated) stats.push('top rated: ' + c.topRated.title);
  if (c.standaloneCount > 0) stats.push(c.standaloneCount + ' standalone books');
  const standalonePool = c.books.filter(b => { const rel = (b.challenges || []).filter(cc => (data.challenges || []).some(x => x.id === cc)); return rel.length === 1 && rel[0] === c.id; }).slice(0, 5);
  const poolHtml = standalonePool.length ? `<div class="g-standalone-pool"><strong>${c.standaloneCount} standalone</strong> books belong only to this category${c.standaloneCount > 5 ? ' (showing first 5)' : ''}: ${standalonePool.map(b => `<a href="${esc(b.url || '#')}" target="_blank">${esc(b.title)}</a>`).join(' · ')}</div>` : '';
  bookLists += `<details class="g-acc" id="cat-${safeId(c.id)}"${i === 0 ? ' open' : ''} data-name="${esc(c.name)}" data-meta="${c.books.length} books${c.avg ? ' · avg ★ ' + c.avg : ''}">` +
    `<summary><span>${esc(c.name)}</span><span class="count-badge">${c.books.length}</span><span class="g-acc-stats">${stats.slice(0, 3).join(' · ')}</span><button class="btn outline sm g-copy" type="button">Copy list</button></summary>` +
    `<div class="g-acc-body"><ul class="g-rows">${c.books.map(rowLi).join('')}</ul>${poolHtml}</div></details>`;
});

// Combos
let comboHtml = '';
combos.forEach((cb, i) => {
  const sorted = cb.books.slice().sort((a, b) => (b.rating || 0) - (a.rating || 0));
  comboHtml += `<details class="g-acc" id="combo-${safeId(cb.cats.join('+'))}"${i === 0 ? ' open' : ''} data-name="${esc(cb.cats.map(catName).join(' + '))}" data-meta="${cb.books.length} books">` +
    `<summary><span>${esc(cb.cats.map(catName).join(' + '))}</span><span class="count-badge">${cb.books.length} book${cb.books.length === 1 ? '' : 's'}</span><button class="btn outline sm g-copy" type="button">Copy list</button></summary>` +
    `<div class="g-acc-body"><ul class="g-rows">${sorted.map(rowLi).join('')}</ul></div></details>`;
});

// TOC
const toc = cats.map(c => `<a href="#cat-${safeId(c.id)}"><span>${esc(c.name)}</span><span class="count-badge">${c.books.length}</span></a>`).join('') +
  `<a href="#shortest-path"><span>Shortest Path</span></a>` +
  `<a href="#one-per-challenge"><span>One Per Challenge</span></a>` +
  `<a href="#overlaps"><span>Overlaps</span><span class="count-badge">${combos.length}</span></a>` +
  `<a href="#faq"><span>FAQ</span></a>`;

// Season chip
let chip = '';
if (seasonEnd) {
  const days = Math.ceil((new Date(seasonEnd) - Date.now()) / 86400000);
  const explain = days > 0 ? `Season ends in ${days} day${days === 1 ? '' : 's'} — the countdown flips at midnight Pacific (California) time, no matter where you are.` : 'Season ended — the countdown ended at midnight Pacific (California) time.';
  chip = `<button type="button" class="g-chip" title="${esc(explain)}"><svg class="ic ic-sm" aria-hidden="true"><use href="#i-hour"/></svg> ${days > 0 ? 'Season ends in ' + days + ' day' + (days === 1 ? '' : 's') : 'Season ended'}</button>`;
}

// Key facts grid
const keyfacts = [
  `<div class="g-kf"><small>Categories</small><strong><svg class="ic" aria-hidden="true"><use href="#i-book"/></svg> ${cats.length}</strong></div>`,
  `<div class="g-kf"><small>Eligible Books</small><strong><svg class="ic" aria-hidden="true"><use href="#i-layers"/></svg> ${books.length}</strong></div>`,
  `<div class="g-kf"><small>Overlapping Books</small><strong><svg class="ic" aria-hidden="true"><use href="#i-link"/></svg> ${overlapBookSet.size}</strong></div>`,
  `<div class="g-kf"><small>Shortest Path</small><strong><svg class="ic" aria-hidden="true"><use href="#i-zap"/></svg> ${shortestList.length} books</strong></div>`,
  `<div class="g-kf"><small>One Per Challenge</small><strong><svg class="ic" aria-hidden="true"><use href="#i-swap"/></svg> ${opcList.length} books</strong></div>`,
  updated ? `<div class="g-kf"><small>Last Updated</small><strong style="font-size:14px;">${updated}</strong></div>` : ''
].filter(Boolean).join('');

// NL-FAQ (computed answers)
const faqItems = [
  { q: `How many books do I need to finish all ${cats.length} ${seasonName} Goodreads challenges?`, a: `The shortest path uses ${shortestList.length} book${shortestList.length === 1 ? '' : 's'} totaling about ${shortestPath.totalPages.toLocaleString()} pages, covering ${cats.length - shortestPath.uncovered.length} of ${cats.length} goals by maximizing overlaps.` },
  { q: `Can I read one distinct book per ${seasonName} challenge?`, a: `Yes — the one-book-per-challenge plan uses ${opcList.length} book${opcList.length === 1 ? '' : 's'} (~${onePerPath.totalPages.toLocaleString()} pages). Every read unlocks exactly one new bookmark, with no overlaps.` },
  { q: `What are the best-rated books in the ${seasonName} season?`, a: cats.filter(c => c.topRated).sort((a, b) => b.topRated.rating - a.topRated.rating).slice(0, 3).map(c => `<strong>${esc(c.topRated.title)}</strong> (${esc(c.name)}, ★ ${c.topRated.rating.toFixed(2)})`).join(', ') + '.' },
  { q: `What are the shortest books I can read this season?`, a: cats.filter(c => c.shortest).sort((a, b) => a.shortest.pages - b.shortest.pages).slice(0, 3).map(c => `<strong>${esc(c.shortest.title)}</strong> (${c.shortest.pages}p, ${esc(c.name)})`).join(', ') + '.' },
  { q: `Which categories have standalone books (no overlap)?`, a: cats.filter(c => c.standaloneCount > 0).slice(0, 5).map(c => `${esc(c.name)} (${c.standaloneCount})`).join(', ') + (cats.filter(c => c.standaloneCount > 0).length > 5 ? ' and more' : '') + (cats.every(c => c.standaloneCount === 0) ? 'None — every book in this season overlaps with at least one other category.' : '.') },
  { q: `What is the biggest overlap combination this season?`, a: combos[0] ? `The largest combo is <strong>${combos[0].cats.map(catName).join(' + ')}</strong> with ${combos[0].books.length} common book${combos[0].books.length === 1 ? '' : 's'}.` : 'No overlaps exist in this season — every book belongs to exactly one category.' }
];
const faqHtml = faqItems.map(f => `<details><summary>${f.q}</summary><p class="g-faq-a">${f.a}</p></details>`).join('');

// JSON-LD
const jsonld = {
  '@context': 'https://schema.org',
  '@type': 'WebPage',
  name: seasonName + ' Goodreads Challenge Guide',
  description: `Complete book list and optimal reading plans for the ${seasonName} Goodreads reading challenge.`,
  url: 'https://sugamb.github.io/goodreads-reading-challenges/guide.html',
  dateModified: data.lastUpdated || new Date().toISOString(),
  mainEntity: {
    '@type': 'FAQPage',
    mainEntity: faqItems.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a.replace(/<[^>]+>/g, '') } }))
  },
  hasPart: [
    { '@type': 'ItemList', name: 'Challenge Categories', itemListElement: cats.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, url: 'https://sugamb.github.io/goodreads-reading-challenges/guide.html#cat-' + safeId(c.id) })) },
    { '@type': 'ItemList', name: 'Shortest Path', itemListElement: shortestList.slice(0, 50).map((b, i) => ({ '@type': 'ListItem', position: i + 1, name: b.title, url: b.url || '#' })) }
  ]
};
const jsonldScript = '<script type="application/ld+json">\n' + JSON.stringify(jsonld, null, 2) + '\n<\/script>';

// --- inject everything ---
guide = inject(guide, 'THEME_TOKENS', '\n' + tokens + '\n');
guide = inject(guide, 'GUIDE_SPRITE', '\n' + (sprite || '') + '\n');
guide = inject(guide, 'JSONLD', '\n' + jsonldScript + '\n');
guide = inject(guide, 'GUIDE_TITLE', esc(seasonName + ' Goodreads Challenge Guide — Complete Book List'));
guide = inject(guide, 'OG_TITLE', esc(seasonName + ' Goodreads Challenge Guide — Complete Book List'));
guide = inject(guide, 'GUIDE_H1', esc(seasonName + ' Goodreads Reading Challenge: Complete Book List'));
guide = inject(guide, 'SEASON_CHIP', chip);
guide = inject(guide, 'KEYFACTS', keyfacts);
guide = inject(guide, 'GUIDE_TOC', toc);
guide = inject(guide, 'SHORTEST_PATH', '\n' + shortestHtml + '\n');
guide = inject(guide, 'ONE_PER_CHALLENGE', '\n' + onePerHtml + '\n');
guide = inject(guide, 'BOOK_LISTS', '\n' + bookLists + '\n');
guide = inject(guide, 'SHEET_STATS', `<strong>${combos.length}</strong> combinations · <strong>${overlapBookSet.size}</strong> overlapping books · max overlap <strong>${combos.length ? combos[0].cats.length : 0}</strong> challenges`);
guide = inject(guide, 'SHEET_COMBOS', '\n' + comboHtml + '\n');
guide = inject(guide, 'FAQ', '\n' + faqHtml + '\n');
guide = inject(guide, 'GUIDE_UPDATED', updated);
if (!guide.includes('gc.zgo.at')) {
  guide = guide.replace('</head>', '<script data-goatcounter="https://sugamb.goatcounter.com/count" async src="//gc.zgo.at/count.js"><\/script>\n</head>');
}
guide = guide.replace('<head>', '<!-- GENERATED FILE — do not edit by hand. Source template: guide.template.html -->\n<head>');
fs.writeFileSync(path.join(ROOT, 'guide.html'), guide);
console.log(`[guide v2] built: ${cats.length} categories, ${combos.length} combos, ${books.length} books, shortest=${shortestList.length}, one-per=${opcList.length}, season "${seasonName}".`);