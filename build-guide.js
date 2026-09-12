// build-guide.js — regenerates guide.html from data.json (+ syncs theme tokens from index.html)
// Run automatically by .github/workflows/build.yml on every push. No dependencies.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(ROOT, f), s);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const fmtDate = (iso) => new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

function replaceBetween(html, startMarker, endMarker, content) {
  const si = html.indexOf(startMarker);
  const ei = html.indexOf(endMarker);
  if (si === -1 || ei === -1) throw new Error(`Marker pair not found in guide.html: ${startMarker} ... ${endMarker}`);
  return html.slice(0, si) + startMarker + '\n' + content + '\n' + html.slice(ei);
}

function subsets(arr, minSize) {
  const res = [], n = arr.length;
  for (let i = 1; i < (1 << n); i++) {
    const sub = [];
    for (let j = 0; j < n; j++) if ((i >> j) & 1) sub.push(arr[j]);
    if (sub.length >= minSize) res.push(sub);
  }
  return res;
}

// Mirrors the optimizer's detectSeasonInfo() logic
function detectSeason(d) {
  let name = d.seasonName || d.season || null;
  if (!name) {
    const haystack = ((d.challenges || []).map((c) => `${c.name || ''} ${c.id || ''}`).join(' ')) + ' ' + (d.title || '');
    const m = haystack.match(/\b(Summer|Fall|Autumn|Winter|Spring)\b/i);
    const ym = haystack.match(/\b(20\d{2})\b/);
    const year = ym ? ym[1] : (d.lastUpdated ? String(new Date(d.lastUpdated).getFullYear()) : String(new Date().getFullYear()));
    if (m) {
      name = `${m[1] === 'Autumn' ? 'Fall' : m[1]} ${year}`;
    } else {
      const ref = d.lastUpdated ? new Date(d.lastUpdated) : new Date();
      const mo = ref.getMonth();
      const season = (mo <= 1 || mo === 11) ? 'Winter' : (mo <= 4 ? 'Spring' : (mo <= 7 ? 'Summer' : 'Fall'));
      name = `${season} ${ref.getFullYear()}`;
    }
  }
  return name;
}

function main() {
  const data = JSON.parse(read('data.json'));
  let guide = read('guide.html');
  const books = data.books || [];
  const challenges = data.challenges || [];
  const nameOf = (id) => { const c = challenges.find((x) => x.id === id); return c ? c.name : id; };

  // 1) Sync theme tokens from index.html (zero-drift aesthetics)
  try {
    const indexHtml = read('index.html');
    const rootMatch = indexHtml.match(/^:root \{[\s\S]*?^\}/m);
    const darkMatch = indexHtml.match(/^html\.dark \{[\s\S]*?^\}/m);
    if (rootMatch && darkMatch) {
      guide = replaceBetween(guide, '/* THEME_TOKENS_START */', '/* THEME_TOKENS_END */', rootMatch[0] + '\n' + darkMatch[0]);
    } else {
      console.warn('⚠️ Could not extract theme tokens from index.html — keeping existing tokens in guide.html.');
    }
  } catch (e) {
    console.warn('⚠️ index.html not readable — keeping existing tokens in guide.html.');
  }

  // 2) Season-aware titles & meta (static, crawlable)
  const season = detectSeason(data);
  const fullTitle = `${season} Goodreads Reading Challenge: Complete Book List`;
  const desc = `The complete, up-to-date book list for the ${season} Goodreads reading challenge, organized by category, plus every multi-category overlap combination.`;
  guide = guide.replace(/<title>[\s\S]*?<\/title>/, `<title>${esc(fullTitle)}</title>`);
  guide = guide.replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${esc(desc)}" />`);
  guide = guide.replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${esc(fullTitle)}" />`);
  guide = guide.replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${esc(desc)}" />`);
  guide = guide.replace(/<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${esc(fullTitle)}" />`);
  guide = guide.replace(/<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${esc(desc)}" />`);
  guide = replaceBetween(guide, '<!-- GUIDE_H1_START -->', '<!-- GUIDE_H1_END -->', esc(fullTitle));

  // 3) Optional seasonEnd chip (never breaks if absent)
  let chip = '';
  if (data.seasonEnd) {
    const days = Math.ceil((new Date(data.seasonEnd) - Date.now()) / 86400000);
    if (!isNaN(days)) {
      chip = days > 0
        ? `<span class="season-chip">⏳ Season ends in ${days} day${days === 1 ? '' : 's'}</span>`
        : `<span class="season-chip muted-chip">Season ended</span>`;
    }
  }
  guide = replaceBetween(guide, '<!-- SEASON_CHIP_START -->', '<!-- SEASON_CHIP_END -->', chip);

  // 4) Updated date
  guide = replaceBetween(guide, '<!-- GUIDE_UPDATED_START -->', '<!-- GUIDE_UPDATED_END -->', data.lastUpdated ? `Updated ${fmtDate(data.lastUpdated)}` : 'Updated —');

  // 5) Overlap combinations (same subset logic as the optimizer's spreadsheet, all challenges selected)
  const comboMap = new Map();
  books.forEach((b) => {
    const cats = b.challenges || [];
    if (cats.length < 2) return;
    subsets(cats, 2).forEach((sub) => {
      const key = [...sub].sort().join(' + ');
      if (!comboMap.has(key)) comboMap.set(key, { categories: [...sub].sort(), books: [] });
      comboMap.get(key).books.push(b);
    });
  });
  const combos = [...comboMap.values()].sort((a, b) =>
    b.categories.length - a.categories.length ||
    b.books.length - a.books.length ||
    a.categories.join(',').localeCompare(b.categories.join(','))
  );
  const overlapBookCount = books.filter((b) => (b.challenges || []).length >= 2).length;
  const maxOverlap = combos.length ? combos[0].categories.length : 0;

  // 6) At-a-glance stats
  const glance = [
    `<div class="glance-row"><span>Season</span><strong>${esc(season)}</strong></div>`,
    `<div class="glance-row"><span>Categories</span><strong>${challenges.length}</strong></div>`,
    `<div class="glance-row"><span>Total books</span><strong>${books.length}</strong></div>`,
    `<div class="glance-row"><span>Multi-category books</span><strong>${overlapBookCount}</strong></div>`,
    `<div class="glance-row"><span>Overlap combinations</span><strong>${combos.length}</strong></div>`,
    data.lastUpdated ? `<div class="glance-row"><span>List updated</span><strong>${fmtDate(data.lastUpdated)}</strong></div>` : ''
  ].filter(Boolean).join('\n');
  guide = replaceBetween(guide, '<!-- GUIDE_GLANCE_START -->', '<!-- GUIDE_GLANCE_END -->', glance);

  // 7) Contents
  const toc = challenges.map((c) => `<li><a href="#gc-${slug(c.id)}">${esc(c.name)}</a></li>`).join('\n')
    + '\n<li><a href="#overlap-spreadsheet">Overlap Spreadsheet</a></li>';
  guide = replaceBetween(guide, '<!-- GUIDE_TOC_START -->', '<!-- GUIDE_TOC_END -->', toc);

  // 8) Category book lists
  const lists = challenges.map((c, i) => {
    const cBooks = books.filter((b) => (b.challenges || []).includes(c.id)).sort((a, b) => a.title.localeCompare(b.title));
    const rows = cBooks.map((b) => {
      const meta = [b.rating != null ? `⭐ ${Number(b.rating).toFixed(2)}` : null, b.pages != null ? `${b.pages}p` : null].filter(Boolean).join(' · ');
      return `<li><a href="${esc(b.url || '#')}" target="_blank" rel="noopener">${esc(b.title)}</a> <span class="g-author">— ${esc(b.author || 'Unknown')}</span>${meta ? ` <span class="g-meta">· ${meta}</span>` : ''}</li>`;
    }).join('\n');
    return `<details class="guide-cat" id="gc-${slug(c.id)}"${i === 0 ? ' open' : ''}>
<summary><span class="title-group">${esc(c.name)} <span class="count-badge">${cBooks.length}</span></span></summary>
<ul class="guide-list">
${rows}
</ul>
</details>`;
  }).join('\n');
  guide = replaceBetween(guide, '<!-- BOOK_LISTS_START -->', '<!-- BOOK_LISTS_END -->', lists);

  // 9) Spreadsheet stats + combination accordions (slim columns, pre-sorted, no JS needed)
  guide = replaceBetween(guide, '<!-- SHEET_STATS_START -->', '<!-- SHEET_STATS_END -->',
    `Overlap groups: <strong>${combos.length}</strong> combinations &nbsp;|&nbsp; Overlapping books: <strong>${overlapBookCount}</strong> &nbsp;|&nbsp; Max overlap: <strong>${maxOverlap}</strong> challenges`);

  const comboHtml = combos.map((sec, i) => {
    const secBooks = [...sec.books].sort((a, b) => (b.rating == null ? -1 : b.rating) - (a.rating == null ? -1 : a.rating) || a.title.localeCompare(b.title));
    const rows = secBooks.map((b) =>
      `<tr><td><a href="${esc(b.url || '#')}" target="_blank" rel="noopener"><strong>${esc(b.title)}</strong></a></td><td class="td-muted">${esc(b.author || 'Unknown')}</td><td style="text-align:right;">${b.pages == null ? '—' : b.pages}</td><td style="text-align:center;">${b.rating != null ? Number(b.rating).toFixed(2) : '—'}</td></tr>`
    ).join('\n');
    return `<details class="guide-cat" id="combo-${i}"${i < 3 ? ' open' : ''}>
<summary><span class="title-group">${sec.categories.map((c) => esc(nameOf(c))).join(' + ')} <span class="count-badge">${secBooks.length}</span></span></summary>
<div class="table-wrap">
<table class="sheet-table">
<thead><tr><th>Book</th><th>Author</th><th style="text-align:right;">Pages</th><th style="text-align:center;">Rating</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</div>
</details>`;
  }).join('\n');
  guide = replaceBetween(guide, '<!-- SHEET_COMBOS_START -->', '<!-- SHEET_COMBOS_END -->', comboHtml || '<p class="stats-row">No overlapping books this season.</p>');
  
  // 5) Inject privacy-friendly analytics (no cookies, GDPR compliant)
  const analyticsTag = `<script data-goatcounter="https://sugamb.goatcounter.com/count" async src="//gc.zgo.at/count.js"><\/script>`;
  guide = guide.replace('</head>', analyticsTag + '\n</head>');
  write('guide.html', guide);
  console.log(`✅ guide.html rebuilt — season "${season}", ${challenges.length} categories, ${books.length} books, ${combos.length} overlap combos.`);
}

main();
