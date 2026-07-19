import fs from 'fs';
import path from 'path';

const OUT_DIR = process.env.OUT_DIR || './out';
const fileName = process.argv[2] || 'trace-landing.json';
const tracePath = path.join(OUT_DIR, fileName);

const events = JSON.parse(fs.readFileSync(tracePath, 'utf8'));
console.log('Total events:', events.length.toLocaleString());

function byName(list) {
  const map = {};
  for (const e of list) {
    const dur = typeof e.dur === 'number' ? e.dur : 0;
    const n = map[e.name] || { count: 0, dur: 0 };
    n.count += 1;
    n.dur += dur;
    map[e.name] = n;
  }
  return Object.entries(map).sort((a, b) => b[1].dur - a[1].dur);
}

function byCategory(list) {
  const map = {};
  for (const e of list) {
    const dur = typeof e.dur === 'number' ? e.dur : 0;
    for (const cat of (e.cat || '').split(',')) {
      const c = cat.trim();
      if (!c) continue;
      const n = map[c] || { count: 0, dur: 0 };
      n.count += 1;
      n.dur += dur;
      map[c] = n;
    }
  }
  return Object.entries(map).sort((a, b) => b[1].dur - a[1].dur);
}

function catNames(list, cat) {
  const filtered = list.filter((e) => (e.cat || '').split(',').map((c) => c.trim()).includes(cat));
  return byName(filtered);
}

function printTop(title, entries, limit = 20) {
  console.log(`\n${title}`);
  for (const [name, { count, dur }] of entries.slice(0, limit)) {
    console.log(`  ${name}: ${Math.round(dur / 1000).toLocaleString()} ms  (${count.toLocaleString()} events)`);
  }
}

printTop('Top categories', byCategory(events), 20);
printTop('Top names overall', byName(events), 30);
printTop('Names in disabled-by-default-devtools.timeline', catNames(events, 'disabled-by-default-devtools.timeline'), 30);
printTop('Names in blink', catNames(events, 'blink'), 30);
printTop('Names in cc', catNames(events, 'cc'), 30);

// Image-related events
const imageEvents = events.filter((e) =>
  /decode|image|raster|bitmap|texture/i.test(e.name) || /decode|image|raster|bitmap|texture/i.test(e.cat)
);
printTop('Image / raster related names', byName(imageEvents), 30);
