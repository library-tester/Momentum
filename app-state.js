// ===== Momentum — app-state.js =====
// task/preference state, the storage keys, snapshot build+restore, undo, the
// rolling auto-backup, and typed-command history. Loads first: everything else
// reads these globals.
// Loaded by index.html as a plain <script src> (no modules: ES imports are blocked
// under file://, which this app has to keep working). Everything here is a global,
// shared across the four app-*.js files. Load order is fixed: app-state.js -> app-art.js -> app-commands.js -> app-render.js

// ---------- state ----------
let tasks = [];
let archive = [];                                          // completed tasks live here, out of the normal list
let projects = [];
let cmdHistory = [];                                      // typed commands — not "history", which would shadow window.history
let historyWalk = null;                                    // in-progress Up/Down prefix search — see historyUp/historyDown
let displayMode = 'ascii';                                // 'ascii' | 'image' — which reveal track is shown on the right
const THEMES = ['amber', 'night', 'day', 'solar', 'nord'];
const THEME_ALIASES = { nightmode: 'night', daymode: 'day' };   // the original two-word switch commands still work
let theme = 'day';

// ---------- fonts ----------
// two sources, one list. bundled families come from font-data.js, which
// build_font_data.py writes by scanning fonts/ — the same generated-manifest trick
// art-data.js uses, and for the same reason: a browser can't list a directory, and
// under file:// it can't fetch one either, so "whatever is in that folder" has to
// be written down somewhere a plain <script src> can reach.
//
// system stacks are the other half, and they're what makes the command useful on a
// fresh checkout: they need no files at all, so the list isn't one entry long until
// you go and find webfonts. each is offered only if the machine actually has it
// (see fontAvailable) rather than listed and silently falling back to something
// else, which would make picking one feel broken.
//
// every candidate is monospace on purpose. this is an app whose ascii art and
// whose aligned [id] columns are only correct in a fixed-width face, so a
// proportional font isn't a style choice here, it's a broken layout — see
// isMonospace, which verifies rather than trusting the list.
const SYSTEM_FONTS = [
  { id:'system',        name:'System monospace', family:'monospace' },
  { id:'menlo',         name:'Menlo',            family:'Menlo' },
  { id:'consolas',      name:'Consolas',         family:'Consolas' },
  { id:'dejavu-mono',   name:'DejaVu Sans Mono', family:'DejaVu Sans Mono' },
  { id:'liberation',    name:'Liberation Mono',  family:'Liberation Mono' },
  { id:'ubuntu-mono',   name:'Ubuntu Mono',      family:'Ubuntu Mono' },
  { id:'jetbrains',     name:'JetBrains Mono',   family:'JetBrains Mono' },
  { id:'fira-mono',     name:'Fira Mono',        family:'Fira Mono' },
  { id:'source-mono',   name:'Source Code Pro',  family:'Source Code Pro' },
  { id:'sf-mono',       name:'SF Mono',          family:'SF Mono' },
  { id:'cascadia',      name:'Cascadia Mono',    family:'Cascadia Mono' },
];
// the app's own face, and the fallback every other choice ends with — a bundled
// font that failed to load lands on the system's monospace rather than on the
// browser's proportional default.
const DEFAULT_FONT = 'ibm-plex-mono';
let fontId = DEFAULT_FONT;

// text size, expressed as the app's *body* size in px — the 13px the console, task
// list and reveal panel are all set in. that's the number worth naming because it's
// the one you actually read; --font-scale (see momentum.css) is derived from it, and
// carries the title and metadata sizes along in proportion.
//
// the bounds are where it stops being usable rather than where it stops being
// possible: under 9 the metadata row is smaller than most browsers will render
// legibly, and over 28 a task title stops fitting the pane on a laptop.
const FONT_SIZE_DEFAULT = 13, FONT_SIZE_MIN = 9, FONT_SIZE_MAX = 28;
let fontSize = FONT_SIZE_DEFAULT;

// the bundled half of the list, as font-data.js describes it. read through a
// function rather than captured at load so a missing or malformed font-data.js is
// simply an empty list — the app still runs, it just has nothing bundled to offer.
function bundledFonts(){
  const fams = (window.FONT_DATA && window.FONT_DATA.families) || [];
  return fams.filter(f => f && f.id && f.family).map(f => ({
    id: f.id,
    name: f.name || f.family,
    family: f.family,
    category: f.category || null,      // the fonts/ subfolder it came from — the font list's headings
    bundled: true,
  }));
}
// bundled first: they ship with the app, they're the look it was designed in, and
// they're the only entries guaranteed to render the same on every machine.
//
// deduped on the family *name* rather than the id, because the two halves of the
// list name the same font differently — SYSTEM_FONTS calls JetBrains Mono
// "jetbrains" while the bundled copy is "jetbrains-mono" after its filename — and
// matching on id let the same face appear twice, once from each source. the name is
// the thing that actually decides what you'd see on screen, so it's the honest key.
function allFonts(){
  const bundled = bundledFonts();
  const taken = new Set(bundled.map(f => f.family.toLowerCase()));
  // grouped by category so the printed list can put a heading over each run rather
  // than repeating one every few rows. uncategorised first — that's the app's own
  // default face, sitting loose at the top of fonts/ — then categories in
  // alphabetical order, which is arbitrary but stable, and stable is what matters:
  // these are numbers people pick off a list, so the order can't shift under them.
  // no hardcoded category order, because the categories are just whatever folders
  // are in fonts/ and this file shouldn't have to be edited to add one.
  const sorted = [...bundled].sort((a, b) =>
    (a.category === null) - (b.category === null) === 0
      ? String(a.category).localeCompare(String(b.category)) || a.name.localeCompare(b.name)
      : (a.category === null ? -1 : 1));
  return [...sorted, ...SYSTEM_FONTS.filter(f => !taken.has(f.family.toLowerCase()))];
}
// a font named directly ("font Iosevka") that neither the manifest nor SYSTEM_FONTS
// knows about. it has to be held somewhere, because everything downstream resolves
// the font through fontEntry() — without this, a name the list didn't recognise
// resolved to null, and fontStack(null) quietly handed back the default, so the
// escape hatch reported success and then rendered the font you were trying to leave.
// one slot rather than a collection: it's whatever you last typed in, and the moment
// you pick something from the list it stops being the answer.
let customFont = null;                                    // { id, name, family } | null
function fontEntry(id){
  return allFonts().find(f => f.id === id)
      || (customFont && customFont.id === id ? customFont : null);
}

// ---------- measuring a font ----------
// both checks below work the same way: render a probe string on a canvas and look
// at how wide it comes out. it's the only way to ask the questions that matter here
// — "is this font actually on this machine" and "is it fixed-width" — since the
// browser exposes neither directly and answers a request for a missing family by
// quietly substituting another one.
let fontProbeCtx = null;
function measureText(text, family, size){
  if(!fontProbeCtx) fontProbeCtx = document.createElement('canvas').getContext('2d');
  fontProbeCtx.font = `${size || 72}px ${family}`;
  return fontProbeCtx.measureText(text).width;
}
// a family is "available" if asking for it changes the result versus not asking.
// measured against two different generic fallbacks, because a font that happens to
// metric-match one of them would otherwise read as missing — it has to tie with
// both to be a substitution rather than a coincidence.
const FONT_PROBE = 'mmmwwwiiil0O1';
function fontAvailable(family){
  if(family === 'monospace') return true;         // the generic is always there by definition
  const mono = measureText(FONT_PROBE, 'monospace');
  const serif = measureText(FONT_PROBE, 'serif');
  const asMono = measureText(FONT_PROBE, `"${family}", monospace`);
  const asSerif = measureText(FONT_PROBE, `"${family}", serif`);
  return !(asMono === mono && asSerif === serif);
}
// fixed-width means every glyph is the same width, so the narrowest character and
// the widest have to measure the same. 'i' against 'W' is the sharpest pair for
// that, and 'l' against 'M' is a second opinion in case a font special-cases one.
function isMonospace(family){
  const stack = `"${family}", monospace`;
  return measureText('i', stack) === measureText('W', stack)
      && measureText('l', stack) === measureText('M', stack);
}

// the css value that goes into --font-mono. every stack ends in the generic
// monospace: whatever happens — a bundled file that 404s, a system font uninstalled
// since you picked it — the app lands on a fixed-width face rather than on the
// browser's proportional default, which is the one outcome that would visibly break
// the art and the columns.
function fontStack(entry){
  if(!entry) return `'IBM Plex Mono', monospace`;
  return entry.family === 'monospace' ? 'monospace' : `"${entry.family}", monospace`;
}
function applyFont(){
  document.documentElement.style.setProperty('--font-mono', fontStack(fontEntry(fontId)));
  applyFontScale();
}
function applyFontScale(){
  document.documentElement.style.setProperty('--font-scale', String(fontSize / FONT_SIZE_DEFAULT));
}
// @font-face for every bundled family, built from the manifest rather than written
// into momentum.css, so dropping a file into fonts/ and re-running the build script
// is the whole of adding a font — no stylesheet edit, no second place to forget.
// injected once at load; switching fonts afterwards only rewrites the variable.
function installBundledFonts(){
  const rules = bundledFonts().flatMap(fam => {
    const src = (window.FONT_DATA.families.find(f => f.id === fam.id) || {}).files || [];
    return src.map(f => [
      '@font-face{',
      `font-family:"${fam.family}";`,
      `font-style:${f.style || 'normal'};`,
      `font-weight:${f.weight || 400};`,
      'font-display:swap;',
      `src:url("${f.file}") format("${f.format || 'woff2'}");`,
      '}',
    ].join(''));
  });
  if(!rules.length) return;
  const el = document.createElement('style');
  el.id = 'bundled-fonts';
  el.textContent = rules.join('\n');
  document.head.appendChild(el);
  // and then actually fetch them, rather than waiting for something to be rendered
  // in one. a browser treats @font-face as a declaration, not a download — the file
  // is only requested when a glyph needs it — which would leave every bundled font
  // you haven't selected unmeasurable (isMonospace would be reading the fallback's
  // metrics) and make switching to one flash the fallback first. there are only a
  // handful of small local files here, so pulling them up front costs nothing worth
  // counting. failures are ignored on purpose: a missing file is already handled by
  // every stack ending in the generic monospace.
  if(document.fonts && document.fonts.load){
    bundledFonts().forEach(f => { try{ document.fonts.load(`16px "${f.family}"`); }catch(e){} });
  }
}

let collectionLoadError = null;                        // set if ascii/image tracks failed to load — shown in the reveal panel, not just buried in the terminal log
let brokenImageStreak = 0;                                // consecutive images that failed to load, auto-skipping — see handleImageLoadError
// the reveal panel shows either the live in-progress piece or the collected
// gallery — never both, same panel either way. galleryOpen picks which;
// galleryDetailIdx, only meaningful while it's true, picks the contact-sheet
// grid (null) or one piece shown full-size (its index into collectedGalleryList()).
// deliberately session-only, not saved with the rest of state — "you left the
// gallery open" isn't a preference worth restoring on reload, unlike splitOn/
// viewMode, and a stale galleryDetailIdx surviving a reload into a collection
// that's since changed shape is a bug waiting to happen for no real benefit.
let galleryOpen = false;
let galleryDetailIdx = null;
// which tasks currently have their [label:value] metadata line open in the list
// pane — see "row-toggle" in app-render.js. session-only like the gallery state
// just above and for the same reason: which tasks you had expanded isn't a
// preference worth restoring on reload, and a stale id left in here from a task
// that's since been deleted is harmless — it just never matches a rendered row.
let expandedTaskIds = new Set();
let titleOn = true;                                      // the "MOMENTUM — yet another task manager" banner — purely cosmetic, off just reclaims a bit of vertical space
let statLineOn = true;                                   // the "N total · N completed · ..." summary line under the title
let showAge = false;                                     // the "[created:3d ago]" detail field, computed from createdAt — see "set age". off by default: it's the one field that shows up on every task whether or not you gave it anything, and it's the least load-bearing of them
// ---------- feature flags ----------
// the optional halves of the app, switchable from "set <feature> on|off". this
// exists because the task fields kept being all-or-nothing: they were ripped out
// wholesale once for a cleaner list, then wanted back, and a rip-out/put-back
// cycle is expensive and lossy. a flag makes that a one-word decision instead.
//
// the contract every one of them keeps, so "off" means the same thing everywhere:
//   1. data is never destroyed. a task keeps its priority/due/tags/project while
//      the feature is off — turning it back on restores every task exactly as it
//      was, which is the whole point of a flag rather than a deletion.
//   2. commands are refused with an explanation, not removed from dispatch, so
//      typing one gets "that's switched off, here's how to switch it on" rather
//      than an "unknown command" that reads like the app is broken.
//   3. help and Tab hide them, so nothing is advertised that would refuse — the
//      same rule printShortcutsRow already follows for shortcuts.
//   4. the fields vanish from list rows, sorting, stats and filters, which is the
//      "cleaner list" the removal was originally reaching for.
// all default on: an existing save (or a first run) behaves exactly as before,
// and you only ever see a difference by asking for one.
const FEATURE_KEYS = ['priority', 'due', 'est', 'tags', 'projects', 'streak'];
let features = Object.fromEntries(FEATURE_KEYS.map(k => [k, true]));
function featureOn(key){ return features[key] !== false; }
let excludedImageFolders = [];                           // top-level image_art/ subfolders left out of the random pool — see "exclude"/"include"
// the standing filter on the always-visible task pane — same {status, proj, tag}
// shape "list" parses its arguments into, set by "filter". a *view* preference, not
// a query: "list" stays a one-off question that answers exactly what you asked it.
const NO_FILTER = { status:'all', proj:null, tag:null };
let paneFilter = { ...NO_FILTER };
let splitOn = true;                                      // split view: task list pinned above the terminal instead of only appearing when you type "list"
let splitRatio = 38;                                     // % of the left column the list pane takes, dragged via #split-divider
const SPLIT_MIN = 12, SPLIT_MAX = 80;                    // keeps either pane from being dragged away to nothing
// 'art'   — the original layout: console left, reveal panel right (split adds the list pane above the console)
// 'tasks' — console left, task list right instead. the reward system keeps running
//           underneath either way (completions still credit reveal progress) — "art"/
//           "display" still report and show it on demand even when it's not on screen.
let viewMode = 'art';
const VIEW_MODES = ['art', 'tasks'];
// the side column's width is draggable in both views, via the same #col-divider,
// and it's one width for both: "view" only decides *which* panel occupies that
// column, so giving each view its own remembered ratio meant the divider jumped to
// a different place every time you switched. one ratio keeps the boundary exactly
// where you left it and lets the panels trade across it — the same thing "mirror"
// goes out of its way to preserve when it flips the columns end for end.
let sidePaneRatio = 55;                                  // % of the window the side column takes, in either view — the old fixed art split, now just the default
const SIDE_MIN = 15, SIDE_MAX = 70;
let mirrored = false;                                    // flips the two columns left-for-right — see "mirror". purely which side each column is on; nothing moves between them

// how big the image reveal blocks are, set by "block size <tier>". tiers are a
// target *block count*, not a target pixel size — an earlier version measured
// blocks in source-image pixels, but that fell apart on this project's own SVG
// pieces: a viewBox-only SVG with no width/height attribute reports a tiny,
// arbitrary "natural size" (a browser fallback, often 300x150) that has nothing to
// do with how detailed the artwork actually is, so a fixed px target produced a
// near-empty grid on exactly the images it was meant to divide finely. block count
// only needs the image's *aspect ratio* to lay out square-ish blocks, and aspect
// ratio survives that fallback intact even when the absolute numbers don't.
// null means medium: leave the image on the grid its manifest entry declares,
// rather than a computed count, since manifest grids already sit in a medium-ish
// range (this project's own images run 20-40 blocks). medium isn't listed in the
// tier table below — it's the null case. full is a hard special case in
// resolveGrid (always exactly 1x1) rather than n:1 run through the usual
// square-block formula, which can drift off 1 block on a skewed aspect ratio.
const BLOCK_SIZE_TIERS = {
  full:      { n: 1,   label: 'full — one block; a single completed task reveals it' },
  verybig:   { n: 4,   label: 'very big' },
  big:       { n: 10,  label: 'big' },
  small:     { n: 100, label: 'small' },
  verysmall: { n: 300, label: 'very small' },
};
let blockSizePref = { n: BLOCK_SIZE_TIERS.small.n };     // default: small. null | { n: <target block count> }
const GRID_MAX_CELLS = 2500;                             // one <div> per block; past this the DOM cost stops being free
const GRID_MAX_SIDE = 100;

// how many blocks one completed task uncovers, set by "block count <n>". direct,
// not derived from a piece's declared revealTasks — set once, it holds for every
// image regardless of how many blocks that image has. null = leave each piece on
// its own manifest pace.
const BLOCK_COUNT_MAX = 20;
let blockCountOverride = 10;                             // default: 10 blocks per completed task

// the ascii equivalent, set by "character count <n>". a wider span than block
// count's 1-20, since ascii pieces are counted in non-space characters rather than
// in coarse blocks — but deliberately not wider than a number anyone would sit and
// type: past a hundred characters a task the difference stops being a pace you can
// feel, and 'all' covers the "just show me the whole thing" end. 'all' is its own
// special value rather than just "set the number as high as totalCells" —
// a fixed number would only fully-reveal-in-one-task the pieces at or below it,
// while 'all' keeps that true piece to piece regardless of size (see asciiTrack's
// perTaskOverride, which turns it into Infinity so cellsPerCompletion's own
// Math.min against totalCells does the clamping). null = leave each piece on its
// own manifest pace.
const CHAR_COUNT_MAX = 100;
let charCountOverride = null;                            // default: each piece's own pace

function applyTheme(){
  document.documentElement.setAttribute('data-theme', theme);
}

// each panel is on screen in two of the four (view x split) combinations: the one
// where it's the side panel, plus the one where split pins it above the console.
// everything that needs to know "is this thing actually visible right now" asks
// here rather than testing splitOn, which is only ever half the answer.
function listPaneVisible(){ return viewMode === 'tasks' || splitOn; }
function revealPaneVisible(){ return viewMode === 'art' || splitOn; }

// puts the two panels in their slots for the current view and sizes them. the art
// view keeps the reward art at the side and stacks the task list above the console;
// the tasks view swaps the pair, so whichever panel isn't the headline is the one
// "split" pins above the prompt. one panel is never in both places at once —
// they're single elements that get moved, not duplicated.
function applyView(){
  const tasksView = viewMode === 'tasks';
  const listPane = document.getElementById('list-pane');
  const revealPane = document.getElementById('reveal-panel');
  const stacked = tasksView ? revealPane : listPane;
  const side    = tasksView ? listPane   : revealPane;

  document.body.classList.toggle('view-tasks', tasksView);
  document.body.classList.toggle('split', splitOn);
  document.body.classList.toggle('mirrored', mirrored);

  // only move a panel when it's actually in the wrong place: re-parenting tears
  // down and rebuilds an element's rendering, which would restart the tile fade
  // transitions on every unrelated render.
  const wrap = document.getElementById('term-wrap');
  const main = document.getElementById('main');
  if(wrap.firstElementChild !== stacked) wrap.insertBefore(stacked, wrap.firstElementChild);
  if(main.lastElementChild !== side) main.appendChild(side);

  stacked.classList.add('slot-stacked'); stacked.classList.remove('slot-side');
  side.classList.add('slot-side'); side.classList.remove('slot-stacked');

  stacked.style.flex = `0 0 ${splitRatio}%`;
  side.style.flex = `0 0 ${sidePaneRatio}%`;

  if(listPaneVisible()) renderListPane();
}

function applyTitle(){
  document.body.classList.toggle('no-title', !titleOn);
}

function applyStatLine(){
  document.body.classList.toggle('no-statline', !statLineOn);
}

const STORAGE_KEY = 'momentum-tasks-v1';
const LEGACY_STORAGE_KEY = 'garden-tasks-v1';  // fall back to pre-rename saves so existing task lists aren't lost
// four small keys, separate from STORAGE_KEY on purpose: none of this is app data,
// so none of it belongs in what "undo"/"import"/"export" read or write.
const AUTOBACKUP_KEY = 'momentum-autobackup-v1';    // rolling history — see pushAutoBackup/cmd_recover
const LAST_EXPORT_KEY = 'momentum-last-export-v1';  // for the "you haven't exported in a while" nudge
const FIRST_SEEN_KEY = 'momentum-first-seen-v1';    // that nudge's fallback baseline if you've never exported at all
const HISTORY_KEY = 'momentum-history-v1';          // typed-command history — see cmdHistory below

function isOverdue(t){
  if(!t.due || t.status === 'done') return false;
  const today = new Date(); today.setHours(0,0,0,0);
  const d = new Date(t.due + 'T00:00:00');
  return d < today;
}

// calendar-day key in local time — the unit both the streak and the heatmap
// group completions by, so two completions on the same day (regardless of
// time of day) always land in the same bucket.
function localDateKey(d){
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// relative age since createdAt, for the "[3d ago]" detail field (see "set age").
// coarsens as it goes further back — a task doesn't need day-level precision once
// it's months old, and staying coarse keeps the detail line from getting noisy.
// every rung above "days" is derived from the one below it: years come from the
// month count, not from a second, independent days/365 division. those two
// divisors used to disagree — at day 360 the month count already read 12 while
// days/365 still floored to 0, so anything 360-364 days old printed the nonsense
// "0y ago". deriving one from the other means a gap like that can't reopen. the
// tradeoff is that a "year" here is 12x30 days, so the 1y mark lands ~5 days
// early, which is well inside the precision this is already rounding away.
function taskAgeText(createdAt){
  // calendar days apart, not elapsed 24h periods: a task added at 11pm is
  // "yesterday" by 1am, two hours later — and yesterday is the word you'd
  // actually use for it. the old elapsed-time version called that "today" for
  // another 22 hours. rounded rather than floored because DST makes a day 23 or
  // 25 hours twice a year, which quietly shifts a floored difference by one.
  const created = new Date(createdAt); created.setHours(0, 0, 0, 0);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.round((today - created) / 86400000);
  if(days <= 0) return 'today';
  if(days === 1) return 'yesterday';
  if(days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if(months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function escapeHtml(s){
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function shuffledIndices(n){
  const arr = Array.from({length:n}, (_,i)=>i);
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(Math.random() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// small, fast, deterministic PRNG (mulberry32) — doesn't need to be cryptographic,
// it exists purely so a reveal order can be reproduced from one saved integer
// instead of the whole shuffled array (see materializeOrder below). same
// Fisher-Yates as shuffledIndices above, just drawing from this instead of
// Math.random() so the same seed always reshuffles the same way.
function mulberry32(seed){
  let s = seed >>> 0;
  return function(){
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function seededShuffledIndices(seed, n){
  const rand = mulberry32(seed);
  const arr = Array.from({length:n}, (_,i)=>i);
  for(let i = arr.length - 1; i > 0; i--){
    const j = Math.floor(rand() * (i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
// a fresh 32-bit seed for a newly-started piece — one Math.random() call, versus
// the array of up to GRID_MAX_CELLS numbers it replaces in storage.
function randomSeed(){
  return (Math.random() * 0xFFFFFFFF) >>> 0;
}
// progress.order is the authority whenever it's set — that only happens after a
// regrid (see remapReveal), whose coverage-weighted reordering depends on the
// old revealed region and can't be reconstructed from a formula. absent that,
// the order is generated fresh from progress.seed every time it's needed: a
// seeded shuffle of range(total) is fully determined by (seed, total), so a
// piece that's never been regridded doesn't need its shuffle order stored at
// all — just the one number that reproduces it.
function materializeOrder(progress, total){
  return progress.order || seededShuffledIndices(progress.seed, total);
}


// shared between saveState (-> localStorage) and cmd_export (-> downloadable file),
// so "back up your tasks" is always exactly what "restore your tasks" expects.
function buildStateSnapshot(){
  return {
    tasks, archive, projects, displayMode, theme, fontId, fontSize, customFont, splitOn, splitRatio, titleOn, statLineOn, showAge, features,
    blockSizePref, blockCountOverride, charCountOverride, excludedImageFolders, viewMode, sidePaneRatio, mirrored, paneFilter,
    ascii: asciiTrack.serialize(), image: imageTrack.serialize(),
  };
}
// shared between loadState (localStorage) and cmd_import (a backup file) — same
// shape either way, so importing a file behaves exactly like a fresh page load.
function applyStateSnapshot(data){
  tasks = data.tasks || [];
  archive = data.archive || [];
  projects = data.projects || [];
  displayMode = data.displayMode === 'image' ? 'image' : 'ascii';
  theme = THEMES.includes(data.theme) ? data.theme : (data.nightMode ? 'night' : 'day');   // data.nightMode: pre-multi-theme saves
  // checked against the list that exists *now*, not the one that was saved: a font
  // whose file has since been removed from fonts/ (or a system font gone with an OS
  // reinstall) falls back to the bundled default rather than leaving the app set to
  // something that can't render. undefined is a save from before fonts were switchable.
  // restored *before* fontId is validated below, since it's one of the things that
  // can make a saved fontId valid — otherwise a directly-named font would fail its
  // own check on every reload and fall back to the default.
  customFont = data.customFont && data.customFont.id && data.customFont.family
    ? { id: String(data.customFont.id), name: String(data.customFont.name || data.customFont.family), family: String(data.customFont.family) }
    : null;
  fontId = fontEntry(data.fontId) ? data.fontId : DEFAULT_FONT;
  // clamped rather than trusted: this one is a raw number in a file anyone can hand-
  // edit or import, and a 500 here would render the app as three enormous words.
  fontSize = Number.isFinite(data.fontSize)
    ? Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(data.fontSize)))
    : FONT_SIZE_DEFAULT;
  splitOn = data.splitOn === undefined ? true : !!data.splitOn;   // undefined: a save from before split defaulted on
  splitRatio = Number.isFinite(data.splitRatio) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, data.splitRatio)) : 38;
  titleOn = data.titleOn === undefined ? true : !!data.titleOn;   // undefined: a save from before this setting existed, when the title was always on
  statLineOn = data.statLineOn === undefined ? true : !!data.statLineOn;   // same reasoning as titleOn
  showAge = data.showAge === undefined ? false : !!data.showAge;  // undefined: a save from before this setting existed. unlike titleOn above it defaults *off*, matching the declaration — see the note there
  // read key by key rather than trusted wholesale, so a save from before feature
  // flags existed (or one naming a feature this version has since dropped) still
  // lands on "everything on" — the state it was actually written in — instead of
  // silently switching half the app off.
  features = Object.fromEntries(FEATURE_KEYS.map(k => [k, (data.features || {})[k] !== false]));
  excludedImageFolders = Array.isArray(data.excludedImageFolders) ? data.excludedImageFolders : [];
  // rebuilt field by field rather than trusted wholesale: a saved filter is the one
  // setting that can hide your tasks, so a malformed one has to fail open (show
  // everything) instead of leaving the pane mysteriously empty.
  paneFilter = data.paneFilter && !listArgsError(data.paneFilter)
    ? { status: data.paneFilter.status, proj: data.paneFilter.proj || null, tag: data.paneFilter.tag || null }
    : { ...NO_FILTER };
  viewMode = VIEW_MODES.includes(data.viewMode) ? data.viewMode : 'art';   // undefined: a save from before the tasks view existed
  // a save from when the two views had a width each carries both numbers: the one
  // that belongs to the view being restored is the width that was actually on
  // screen last, so that's the one to keep — the other view's is discarded rather
  // than averaged into something you never set. undefined all round is a save from
  // before the column was draggable at all.
  const savedSide = Number.isFinite(data.sidePaneRatio) ? data.sidePaneRatio
    : viewMode === 'tasks' ? data.taskPaneRatio : data.artPaneRatio;
  sidePaneRatio = Number.isFinite(savedSide) ? Math.min(SIDE_MAX, Math.max(SIDE_MIN, savedSide)) : 55;
  mirrored = !!data.mirrored;                                              // undefined: a save from before mirroring existed — unmirrored, as it looked then
  blockSizePref = sanitizeBlockSizePref(data.blockSizePref);
  blockCountOverride = Number.isFinite(data.blockCountOverride) && data.blockCountOverride > 0
    ? Math.min(BLOCK_COUNT_MAX, Math.round(data.blockCountOverride)) : null;
  charCountOverride = data.charCountOverride === 'all' ? 'all'
    : Number.isFinite(data.charCountOverride) && data.charCountOverride > 0
    ? Math.min(CHAR_COUNT_MAX, Math.round(data.charCountOverride)) : null;
  asciiTrack.restore(data.ascii);
  imageTrack.restore(data.image);
}

// ---------- undo ----------
// a stack of whole-state snapshots, one per command that actually changed something.
// whole-state rather than per-command inverse operations because it's the only way to
// be sure "undo" is exact — a task's reveal progress, archive, and ids all move
// together. session-only on purpose: persisting 20 copies of everything would bloat
// localStorage, and undo is for the mistake you just made, not last week's.
const UNDO_LIMIT = 20;
let undoStack = [];

function pushUndo(label, before){
  if(before === JSON.stringify(buildStateSnapshot())) return;   // command was a no-op — nothing worth undoing
  undoStack.push({ label, before });
  if(undoStack.length > UNDO_LIMIT) undoStack.shift();
}

async function cmd_undo(){
  if(undoStack.length === 0){ print('nothing to undo', 'info'); return; }
  const entry = undoStack.pop();
  applyStateSnapshot(JSON.parse(entry.before));
  applyTheme();
  applyFont();
  applyView();
  applyTitle();
  applyStatLine();
  await Promise.all([asciiTrack.resync(), imageTrack.resync()]);   // in case we rewound past a piece switch
  asciiTrack.pruneMissing(); imageTrack.pruneMissing();            // ditto for a since-deleted piece the rewind brought back
  saveState();
  renderPanel();
  print(`undid "${entry.label}" — ${tasks.length} task(s) in the list.`, 'ok');
}

// a gentle, one-line heads-up rather than an error: the app is working fine either
// way (live discovery is what's actually driving it right now), this is purely
// about the *other* way of running it — file:// — quietly showing an old set the
// next time someone opens it that way.
function printStaleSnapshotNotice(){
  const parts = [];
  if(asciiTrack.staleSnapshot) parts.push(`${asciiTrack.staleSnapshot.newFiles.length} ascii file${asciiTrack.staleSnapshot.newFiles.length === 1 ? '' : 's'}`);
  if(imageTrack.staleSnapshot) parts.push(`${imageTrack.staleSnapshot.newFiles.length} image file${imageTrack.staleSnapshot.newFiles.length === 1 ? '' : 's'}`);
  if(!parts.length) return;
  const generatedAt = (asciiTrack.staleSnapshot || imageTrack.staleSnapshot).generatedAt;
  const builtTxt = generatedAt ? ` (built ${new Date(generatedAt).toLocaleString()})` : '';
  print(`note: art-data.js${builtTxt} doesn't know about ${parts.join(' and ')} you've added — run "python3 build_art_data.py" so the offline (file://) copy of this app picks them up too.`, 'info');
}

async function loadState(){
  try{
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if(raw) applyStateSnapshot(JSON.parse(raw));
  }catch(e){ /* nothing stored yet, or storage unavailable */ }
  // "has this person ever actually used the app", not "is the list empty right
  // now" — someone who finished everything they had still knows how it works, and
  // shouldn't be handed the tutorial again. checked here, before the greeting, and
  // reused by the closing block at the bottom of this function.
  const firstRun = tasks.length + archive.length === 0
    && asciiTrack.collected.length + imageTrack.collected.length === 0;
  // the one line that has to answer "what is this?" — the art panel is already on
  // screen at this point, half of the app's surface, with nothing yet to say why
  // it's there. naming the reward loop is what turns it from decoration into the
  // point. a returning visitor has long since had that question answered, so they
  // get a greeting instead of a pitch.
  print(firstRun
    ? 'Momentum — every task you finish uncovers part of a picture.'
    : 'Momentum — welcome back.', 'command-weight');
  applyTheme();
  applyFont();
  applyView();
  applyTitle();
  applyStatLine();
  try{
    await Promise.all([asciiTrack.init(), imageTrack.init()]);
    // a piece collected in an earlier session can have been deleted from disk
    // since — rebuilt out of the manifest / art-data.js snapshot this just
    // loaded — so it's pruned from the gallery right here, once, rather than
    // sitting there forever as a "?" tile. only worth a re-save when it
    // actually found something to drop.
    const prunedAscii = asciiTrack.pruneMissing(), prunedImage = imageTrack.pruneMissing();
    if(prunedAscii || prunedImage) saveState();
  }catch(e){
    collectionLoadError = location.protocol === 'file:'
      ? 'could not load the art collection — art-data.js is missing or out of date. run "python3 build_art_data.py" next to this file, then reopen it.'
      : 'could not load the art collection — make sure ascii_art/ and image_art/ are being served alongside this page.';
    print(collectionLoadError, 'err');
  }
  printStaleSnapshotNotice();
  printExportNudge();
  renderPanel();
  if(tasks.length){
    print(`— ${tasks.length} task(s) loaded —`, 'info');
    // the pane above (see listPaneVisible) already shows this exact list the
    // moment renderPanel() runs, a few lines up — dumping the full framed
    // listing here too would just be the same list twice on every single boot.
    // it only earns its keep when there's no pane to have shown it already.
    if(!listPaneVisible()) cmd_list([]);
  } else if(!firstRun){
    // an empty list you *earned* is a result, not a blank slate — so it reads as
    // one, instead of dropping a returning user back into the first-run tutorial.
    print('nothing on your list right now.');
    printHanging('  add water the plants   to start the next one', 2, 'info');
  } else {
    // deliberately two commands, not three. the old version listed "help" as a
    // third peer of equal weight, which is the one thing a newcomer shouldn't do
    // first: it opens a menu onto ~70 commands. the whole job of this block is to
    // get someone to their first completed task, because that's the moment the app
    // explains itself — the picture visibly moves. everything else can wait for the
    // pointer below.
    const starters = [
      { cmd: 'add "water the plants"', desc: 'add your first task' },
      { cmd: 'done 1',               desc: 'finish it — watch the art panel' },
    ];
    // two columns only while the console is actually wide enough to hold them:
    // the padded command column plus a description is ~60 characters, and a phone's
    // console is closer to 43, so this block — the first thing a new user ever
    // sees — used to arrive as a ragged wrap with descriptions broken mid-phrase.
    // the same accommodation buildHelpRows already makes for the help screen, and
    // for the same reason. stacked below that width, indented so each description
    // still reads as belonging to the command above it.
    // plain (full-opacity, un-bolded) rather than the dimmed .info style — this
    // block used to be near-unreadable in some themes since .info is the same hue
    // as everything else, just faded to 72% opacity.
    const w = Math.max(...starters.map(s => s.cmd.length));
    const twoColumn = outputColumns() >= w + 4 + Math.max(...starters.map(s => s.desc.length));
    starters.forEach(s => {
      if(twoColumn){ printHanging(`  ${s.cmd.padEnd(w)}  ${s.desc}`, w + 4); }
      else { print(`  ${s.cmd}`); printHanging(`      ${s.desc}`, 6); }
    });
    print('');
    printHanging('type help for more', 0, 'info');
  }
}
function saveState(){
  try{
    const snapshot = buildStateSnapshot();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    pushAutoBackup(snapshot);
  }catch(e){ print('warning: could not save progress', 'err'); }
}

// ---------- automatic rolling backup ----------
// a second safety net alongside undo: undo is session-only and only covers the
// mistake you just made (see its own comment), so it can't help if the *browser*
// is what loses the state — a wiped localStorage, a new profile, a private window.
// keeping the last few full snapshots under their own key means there's still
// something to fall back to even then, without you having to have remembered to
// export first. still lives in the same localStorage origin, though — this is not
// the durable, leaves-the-browser copy that "export" is (see printExportNudge).
const AUTOBACKUP_LIMIT = 10;
const AUTOBACKUP_MIN_INTERVAL_MS = 10 * 60 * 1000;   // 10 minutes
// in-memory rate-limit clock for the backup below — resets to 0 on reload, which
// is fine, since that just means the first save of a fresh session always backs
// up rather than waiting out a clock nobody remembers. saveState()'s own write to
// STORAGE_KEY (above) is the real, immediate save on every command; this is only
// the bonus rolling copy, and doesn't need to track it command-for-command.
let lastAutoBackupAt = 0;
function loadAutoBackups(){
  try{
    const entries = JSON.parse(localStorage.getItem(AUTOBACKUP_KEY) || '[]');
    return Array.isArray(entries) ? entries : [];
  }catch(e){ return []; }
}
function pushAutoBackup(snapshot){
  // failure here is silent, not printed like saveState()'s own — if the primary
  // write above failed too, that's already been reported once; a second warning
  // about the bonus copy on top of it would just be noise on top of a problem the
  // user already knows about. if only this one fails (primary fine, quota tight),
  // staying quiet matches this app's habit of keeping secondary systems gentle.
  const now = Date.now();
  if(now - lastAutoBackupAt < AUTOBACKUP_MIN_INTERVAL_MS) return;   // rate-limited: skip the read/append/write dance entirely, not just the write
  try{
    const entries = loadAutoBackups();
    entries.push({ at: now, data: snapshot });
    while(entries.length > AUTOBACKUP_LIMIT) entries.shift();
    localStorage.setItem(AUTOBACKUP_KEY, JSON.stringify(entries));
    lastAutoBackupAt = now;
  }catch(e){ /* quota exceeded or storage unavailable — this backup is a bonus, not critical */ }
}

// ---------- typed-command history ----------
// persisted so the up-arrow still has something to say after a reload — losing
// it every refresh was the whole complaint. capped the same way the autobackup
// list is, and just as gentle about failure: this is a convenience, not data.
const HISTORY_LIMIT = 100;
function loadCmdHistory(){
  try{
    const entries = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(entries) ? entries.filter(x => typeof x === 'string') : [];
  }catch(e){ return []; }
}
function pushCmdHistory(val){
  cmdHistory.push(val);
  if(cmdHistory.length > HISTORY_LIMIT) cmdHistory.shift();
  try{ localStorage.setItem(HISTORY_KEY, JSON.stringify(cmdHistory)); }catch(e){ /* quota exceeded or storage unavailable — same as pushAutoBackup, not worth a warning */ }
}

// manual backup/restore — a safety net for whenever localStorage doesn't stick
// around (a new browser profile, a new Codespace, private browsing, etc.):
// localStorage lives in the browser, tied to the exact origin you loaded the
// page from, not in this project's files, so nothing server-side can prevent
// that. "export" now, "import" later is the reliable workaround.
function cmd_export(){
  const blob = new Blob([JSON.stringify(buildStateSnapshot(), null, 2)], { type:'application/json' });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `momentum-backup-${stamp}.json`);
  markExported();
  print(`exported ${tasks.length} task(s) + ${archive.length} archived — save this file somewhere safe.`, 'ok');
}
function markExported(){
  try{ localStorage.setItem(LAST_EXPORT_KEY, String(Date.now())); }catch(e){ /* the export itself already succeeded; missing this timestamp only means the nudge below might fire again sooner than strictly necessary */ }
}
// import doesn't call this — having a file to import from proves that file exists,
// not that the *current* state (which may have moved on since) is saved anywhere.
// only an actual export resets the clock.
const EXPORT_NUDGE_DAYS = 7;
function printExportNudge(){
  if(tasks.length + archive.length === 0) return;          // nothing worth nagging about backing up yet
  let lastExportAt = null;
  try{ const raw = localStorage.getItem(LAST_EXPORT_KEY); if(raw) lastExportAt = parseInt(raw, 10); }catch(e){ /* treat as never exported */ }
  // no export on record: fall back to "first time this app was ever opened" rather
  // than nudging immediately on task #1 — a brand new user hasn't gone a while
  // without exporting yet, they just haven't had the chance to.
  let firstSeenAt = lastExportAt;
  if(!firstSeenAt){
    try{
      firstSeenAt = parseInt(localStorage.getItem(FIRST_SEEN_KEY), 10) || null;
      if(!firstSeenAt){ firstSeenAt = Date.now(); localStorage.setItem(FIRST_SEEN_KEY, String(firstSeenAt)); }
    }catch(e){ firstSeenAt = Date.now(); }
  }
  const daysSince = (Date.now() - firstSeenAt) / (24 * 60 * 60 * 1000);
  if(daysSince < EXPORT_NUDGE_DAYS) return;
  const whenTxt = lastExportAt ? `your last export was ${new Date(lastExportAt).toLocaleDateString()}` : "you've never exported a backup";
  print(`note: ${whenTxt} — type "export" to save an offline copy of your tasks. (there's also an automatic in-browser backup — see "recover" — but that disappears along with everything else if this browser's site data ever gets cleared; export is the one copy that actually leaves the browser.)`, 'info');
}

function cmd_import(){
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files[0];
    if(!file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      // import has to take its own undo snapshot, here, rather than leaning on the
      // one handleCommand takes for every MUTATING command: "import" only opens a
      // file picker and returns, so that command is long finished by the time this
      // callback actually replaces anything. handleCommand's snapshot therefore saw
      // a state that hadn't changed yet, pushUndo's no-op guard discarded it, and
      // nothing was ever recorded for the import at all — which left "undo" popping
      // the *previous* command's entry and restoring a state from before that,
      // silently throwing away both the import and whatever came just before it.
      // taken before the parse (not just before applyStateSnapshot) so it's still
      // in hand if a malformed backup fails partway and leaves the state half-applied.
      const before = JSON.stringify(buildStateSnapshot());
      try{
        const data = JSON.parse(reader.result);
        if(!data || !Array.isArray(data.tasks)) throw new Error('not a momentum backup file');
        applyStateSnapshot(data);
        // same wholesale replacement undo does, so the same repair: the backup names
        // the piece and grid it was saved with, and the loaded art has to follow.
        await Promise.all([asciiTrack.resync(), imageTrack.resync()]);
        asciiTrack.pruneMissing(); imageTrack.pruneMissing();
        saveState(); renderPanel(); cmd_list([]);
        print(`imported ${tasks.length} task(s) + ${archive.length} archived from "${file.name}".`, 'ok');
      }catch(e){
        print(`could not import "${file.name}" — it doesn't look like a momentum backup file.`, 'err');
      }
      // outside the try, so a half-applied import stays recoverable too. pushUndo's
      // own no-op check means a cleanly-rejected file (nothing changed) still adds
      // nothing to the stack.
      pushUndo(`import ${file.name}`, before);
    };
    reader.readAsText(file);
  });
  input.click();
}

// restores from the rolling backup pushAutoBackup() has been keeping — the
// recovery half of the safety net item 21 asked for. always confirmed, unlike
// import: choosing a file via the native picker is already a deliberate multi-step
// action that works as its own confirmation, but typing "recover 2" is one quick
// command that could land by mistake, and unconditionally replaces everything
// currently in the app the moment it does.
function cmd_recover(arg){
  const entries = loadAutoBackups();
  if(!arg || arg.toLowerCase() === 'list'){
    if(entries.length === 0){ print('no automatic backups yet — they build up as you use the app (see "export" for a backup you can make right now instead).', 'info'); return; }
    print('automatic backups, most recent first — "recover <n>" restores one:');
    entries.slice().reverse().forEach((e, i) => {
      const taskCount = (e.data.tasks || []).length, archCount = (e.data.archive || []).length;
      print(`  ${i + 1}. ${new Date(e.at).toLocaleString()}  —  ${taskCount} task${taskCount === 1 ? '' : 's'}, ${archCount} archived`);
    });
    return;
  }
  const ordered = entries.slice().reverse();
  const n = parseInt(arg, 10);
  if(!Number.isInteger(n) || n < 1 || n > ordered.length){
    print(`usage: recover [list|<n>]  (currently ${ordered.length} backup${ordered.length === 1 ? '' : 's'} — "recover list" to see them)`, 'err');
    return;
  }
  const chosen = ordered[n - 1];
  askConfirm(
    `restore the automatic backup from ${new Date(chosen.at).toLocaleString()}? this replaces everything currently here — tasks, archive, reveal progress — with what was saved back then.`,
    `recover ${n}`,
    async () => {
      applyStateSnapshot(chosen.data);
      applyTheme(); applyFont(); applyView(); applyTitle(); applyStatLine();
      await Promise.all([asciiTrack.resync(), imageTrack.resync()]);
      asciiTrack.pruneMissing(); imageTrack.pruneMissing();
      saveState(); renderPanel(); cmd_list([]);
      print(`restored the backup from ${new Date(chosen.at).toLocaleString()}.`, 'ok');
    }
  );
}

