const fs = require('fs');

// 1. Read data.json
const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
let guideHtml = fs.readFileSync('guide.html', 'utf8');

// 2. Generate the HTML for the book lists
let listsHtml = '';
data.challenges.forEach(c => {
  const books = data.books.filter(b => b.challenges.includes(c.id)).sort((a, b) => a.title.localeCompare(b.title));
  listsHtml += `<details class="guide-cat" open><summary>${c.name} (${books.length} books)</summary><ul>`;
  books.forEach(b => {
    const meta = [];
    if (b.rating) meta.push(`⭐ ${b.rating.toFixed(2)}`);
    if (b.pages) meta.push(`${b.pages} pages`);
    const metaStr = meta.length ? ` <span class="g-meta">(${meta.join(' · ')})</span>` : '';
    listsHtml += `<li><a href="${b.url || '#'}">${b.title}</a> <span class="g-author">by ${b.author || 'Unknown'}</span>${metaStr}</li>`;
  });
  listsHtml += `</ul></details>\n`;
});

// 3. Inject into guide.html
guideHtml = guideHtml.replace(/<!-- BOOK_LISTS_START -->[\s\S]*<!-- BOOK_LISTS_END -->/, `<!-- BOOK_LISTS_START -->\n${listsHtml}\n<!-- BOOK_LISTS_END -->`);

// 4. Update title if seasonName exists
if (data.seasonName) {
  const seasonTitle = `${data.seasonName} Reading Challenge: Complete Book List`;
  guideHtml = guideHtml.replace(/<title>.*?<\/title>/, `<title>${seasonTitle}</title>`);
  guideHtml = guideHtml.replace(/<h1 id="season-title">.*?<\/h1>/, `<h1 id="season-title">${seasonTitle}</h1>`);
}

// 5. Write back to guide.html
fs.writeFileSync('guide.html', guideHtml);
console.log('✅ Successfully updated guide.html with book lists from data.json');