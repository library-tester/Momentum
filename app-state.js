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
let collectionLoadError = null;                          // set if ascii/image tracks failed to load — shown in the reveal panel, not just buried in the terminal log
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
let titleOn = true;                                      // the "MOMENTUM — yet another task manager" banner — purely cosmetic, off just reclaims a bit of vertical space
let statLineOn = true;                                   // the "N total · N completed · ..." summary line under the title
let showAge = true;                                      // the "[3d ago]" detail field, computed from createdAt — see "show age"
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
// the side column's width is draggable in both views, via the same #col-divider —
// but each view keeps its own ratio, so switching views and back doesn't disturb
// whatever width you'd set for the other one.
let taskPaneRatio = 40;                                  // % of the window the task list takes in "view tasks"
let artPaneRatio = 55;                                   // % of the window the reveal panel takes in "view art" — the old fixed split, now just the default
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
  side.style.flex = `0 0 ${tasksView ? taskPaneRatio : artPaneRatio}%`;

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

// relative age since createdAt, for the "[3d ago]" detail field (see "show age").
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
  const days = Math.floor((Date.now() - createdAt) / 86400000);
  if(days <= 0) return 'today';
  if(days === 1) return '1d ago';
  if(days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if(months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
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
    tasks, archive, projects, displayMode, theme, splitOn, splitRatio, titleOn, statLineOn, showAge,
    blockSizePref, blockCountOverride, excludedImageFolders, viewMode, taskPaneRatio, artPaneRatio, mirrored, paneFilter,
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
  splitOn = data.splitOn === undefined ? true : !!data.splitOn;   // undefined: a save from before split defaulted on
  splitRatio = Number.isFinite(data.splitRatio) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, data.splitRatio)) : 38;
  titleOn = data.titleOn === undefined ? true : !!data.titleOn;   // undefined: a save from before this setting existed, when the title was always on
  statLineOn = data.statLineOn === undefined ? true : !!data.statLineOn;   // same reasoning as titleOn
  showAge = data.showAge === undefined ? true : !!data.showAge;   // same reasoning as titleOn
  excludedImageFolders = Array.isArray(data.excludedImageFolders) ? data.excludedImageFolders : [];
  // rebuilt field by field rather than trusted wholesale: a saved filter is the one
  // setting that can hide your tasks, so a malformed one has to fail open (show
  // everything) instead of leaving the pane mysteriously empty.
  paneFilter = data.paneFilter && !listArgsError(data.paneFilter)
    ? { status: data.paneFilter.status, proj: data.paneFilter.proj || null, tag: data.paneFilter.tag || null }
    : { ...NO_FILTER };
  viewMode = VIEW_MODES.includes(data.viewMode) ? data.viewMode : 'art';   // undefined: a save from before the tasks view existed
  taskPaneRatio = Number.isFinite(data.taskPaneRatio) ? Math.min(SIDE_MAX, Math.max(SIDE_MIN, data.taskPaneRatio)) : 40;
  artPaneRatio = Number.isFinite(data.artPaneRatio) ? Math.min(SIDE_MAX, Math.max(SIDE_MIN, data.artPaneRatio)) : 55;   // undefined: a save from before the art column was draggable
  mirrored = !!data.mirrored;                                              // undefined: a save from before mirroring existed — unmirrored, as it looked then
  blockSizePref = sanitizeBlockSizePref(data.blockSizePref);
  blockCountOverride = Number.isFinite(data.blockCountOverride) && data.blockCountOverride > 0
    ? Math.min(BLOCK_COUNT_MAX, Math.round(data.blockCountOverride)) : null;
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
  applyTheme();
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
  } else {
    print('no tasks yet — a few commands to get going:', 'info');
    const starters = [
      { cmd: 'add "organize your desk"', desc: 'create your first task' },
      { cmd: 'done 1',                   desc: "mark it complete once it's done" },
      { cmd: 'help',                     desc: 'see everything else this can do' },
    ];
    // two columns only while the console is actually wide enough to hold them:
    // the padded command column plus a description is ~60 characters, and a phone's
    // console is closer to 43, so this block — the first thing a new user ever
    // sees — used to arrive as a ragged wrap with descriptions broken mid-phrase.
    // the same accommodation buildHelpRows already makes for the help screen, and
    // for the same reason. stacked below that width, indented so each description
    // still reads as belonging to the command above it.
    const w = Math.max(...starters.map(s => s.cmd.length));
    const twoColumn = outputColumns() >= w + 4 + Math.max(...starters.map(s => s.desc.length));
    starters.forEach(s => {
      if(twoColumn){ printHanging(`  ${s.cmd.padEnd(w)}  ${s.desc}`, w + 4, 'info'); }
      else { print(`  ${s.cmd}`, 'info'); printHanging(`      ${s.desc}`, 6, 'info'); }
    });
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
      applyTheme(); applyView(); applyTitle(); applyStatLine();
      await Promise.all([asciiTrack.resync(), imageTrack.resync()]);
      asciiTrack.pruneMissing(); imageTrack.pruneMissing();
      saveState(); renderPanel(); cmd_list([]);
      print(`restored the backup from ${new Date(chosen.at).toLocaleString()}.`, 'ok');
    }
  );
}

