// ===== Momentum — app-art.js =====
// the reward-art system: folder discovery, the shared reveal-track factory, and
// the two tracks built on it (ascii + image), including regridding. Must load after
// app-state.js (reads blockCountOverride/excludedImageFolders) and before the rest:
// asciiTrack/imageTrack are constructed at load time, right here.
// Loaded by index.html as a plain <script src> (no modules: ES imports are blocked
// under file://, which this app has to keep working). Everything here is a global,
// shared across the four app-*.js files. Load order is fixed: app-state.js -> app-art.js -> app-commands.js -> app-render.js

// ---------- folder discovery ----------
// lets new files just work by dropping them into ascii_art/ or image_art/ and
// reloading — no manifest.json edit required. relies on the dev server exposing
// a plain directory listing (an <a href> per entry) at each folder URL, which
// `python3 -m http.server` (this project's usual dev server) does automatically.
// manifest.json becomes optional, per-file *override* data: if an entry there
// matches a discovered file's path, its fields (name/category/revealTasks/grid/
// id) win over the auto-derived defaults, so existing curation keeps working.
// hosts that don't expose directory listings (most production static hosts)
// simply fail the discovery fetch, and loadManifest() falls back to reading
// manifest.json as a plain, complete list, exactly as before.
//
// none of this works when the page is opened directly as a file:// URL —
// browsers refuse fetch()/XHR against local files entirely, for both the
// directory listing and manifest.json itself. art-data.js (see art-data.js
// header + build_art_data.py) is a pre-baked snapshot of exactly what
// discovery would have produced, loaded as a plain <script> tag instead of
// fetched, which file:// pages *are* allowed to do. loadManifest() below
// still tries live discovery first (so serving over http keeps auto-picking
// up new files with zero build step, per the comment above), and only falls
// back to that snapshot when discovery fails — which is always, under
// file://. opening the html file directly needs one command first, whenever
// ascii_art/ or image_art/ have changed: python3 build_art_data.py
//
// forgetting that step is easy to miss, because it never breaks anything while
// you're serving the app — only the *next* time it's opened as file://, quietly
// showing the old set with no error. detectStaleSnapshot() below closes that gap:
// whenever live discovery does succeed, it's compared against art-data.js right
// there, and loadState() prints a gentle note if discovery found files the
// snapshot has never heard of.
function humanizeName(stem){
  const words = stem.split(/[-_\s]+/).filter(Boolean);
  if(!words.length) return stem;
  return words.map(w => (w === w.toUpperCase() && /[A-Z]/.test(w)) ? w : w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}
async function fetchDirListing(url){
  const res = await fetch(url);
  if(!res.ok || !(res.headers.get('content-type') || '').includes('text')) throw new Error('no directory listing at ' + url);
  const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
  return Array.from(doc.querySelectorAll('a[href]'))
    .map(a => a.getAttribute('href'))
    .filter(href => href && !href.startsWith('?') && !href.includes('://'));
}
// directory-listing HTML isn't standardized and formats vary a lot between dev
// servers: python's http.server emits relative hrefs with a trailing slash on
// folders ("nature/", "manifest.json"), while servers built on "serve-index"
// (the live-server npm package, and VS Code's Live Server extension, which
// appears to use the same or a compatible listing format) emit *absolute*
// paths with *no* trailing slash on folders, plus "up"/breadcrumb links back
// to the parent folder and site root — including a bare href="/" that (like
// any folder link) ends in "/", so a naive "ends with slash = recurse into
// it" check follows it straight back to a listing containing that same "/"
// link again, forever. resolving every href against the current listing's own
// URL and only following ones that land strictly *inside* the folder this
// walk started from sidesteps the format differences entirely and can't walk
// back out toward the root; the visited set is a second backstop against any
// other kind of link cycle (e.g. a symlink loop) doing the same thing.
async function discoverFiles(baseUrl, extensions){
  const topBase = new URL(baseUrl, location.href).href;
  const visited = new Set([topBase]);
  async function walk(dirUrl){
    const hrefs = await fetchDirListing(dirUrl);
    let files = [];
    for(const href of hrefs){
      const resolved = new URL(href, dirUrl).href;
      if(!resolved.startsWith(topBase) || resolved === topBase || visited.has(resolved)) continue;
      const relPath = decodeURIComponent(resolved.slice(topBase.length)).replace(/\/$/, '');
      const isDir = href.endsWith('/') || !/\.[^./]+$/.test(relPath);
      if(isDir){
        visited.add(resolved);
        files = files.concat(await walk(resolved.endsWith('/') ? resolved : resolved + '/'));
      } else if(extensions.some(ext => relPath.toLowerCase().endsWith(ext))){
        files.push(relPath);
      }
    }
    return files;
  }
  return walk(topBase);
}
async function discoverManifest({ baseDir, extensions, manifestUrl, itemsField, defaultExtra }){
  const files = await discoverFiles(baseDir, extensions);
  if(files.length === 0) throw new Error('discovery found nothing at ' + baseDir);   // probably not a real listing — fall back

  let overridesByFile = {};
  try{
    const res = await fetch(manifestUrl);
    if(res.ok){
      (((await res.json())[itemsField]) || []).forEach(e => { if(e.file) overridesByFile[e.file] = e; });
    }
  }catch(e){ /* no manifest.json (or it's unreadable) — discovered defaults stand on their own */ }

  const usedIds = new Set();
  const items = files.sort().map(file => {
    const override = overridesByFile[file] || {};
    const stem = file.slice(file.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
    const folder = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : null;
    const baseId = override.id || slugify(stem);
    let id = baseId, n = 2;
    while(usedIds.has(id)){ id = `${baseId}-${n++}`; }
    usedIds.add(id);
    return Object.assign({ id, name: humanizeName(stem), category: folder, file, revealTasks: 6 }, defaultExtra, override, { file });
  });
  return { [itemsField]: items };
}

// compares a live-discovered file list against the pre-baked art-data.js snapshot
// for the same track, looking only for files discovery found that the snapshot has
// never heard of — the "you added art and forgot to rebuild" case (item 18). the
// reverse (a file the snapshot has but discovery didn't find, i.e. something was
// deleted) is a different, already-tracked problem — missing/broken art files —
// and not what this check is for, so it's deliberately left alone here.
function detectStaleSnapshot(discoveredItems, dataKey, itemsField){
  const baked = window.ART_DATA && window.ART_DATA[dataKey];
  if(!baked || !Array.isArray(baked[itemsField])) return null;   // no snapshot to be stale relative to
  const bakedFiles = new Set(baked[itemsField].map(e => e.file));
  const newFiles = discoveredItems.map(e => e.file).filter(f => !bakedFiles.has(f));
  return newFiles.length ? { newFiles, generatedAt: window.ART_DATA.generatedAt || null } : null;
}

// ---------- generic collectible reveal track ----------
// both the ascii-art system and the image system are the same state machine:
// load a manifest of entries, load the current entry's content, reveal a random
// handful of its cells per completed task, and once fully revealed, log it to a
// permanent gallery and start a new one (picked so nothing repeats until every
// entry in the manifest has had a turn). this factory is shared by both so a
// third mode later is just another instantiation, not a new system.
function createRevealTrack({ baseDir, extensions, manifestUrl, itemsField, dataKey, loadItem, totalCellsFor, defaultExtra, progressExtra, regrid, syncItem, perTaskOverride, filterPool }){
  return {
    manifest: null,
    current: null,                                        // loaded item, shape depends on loadItem
    progress: { itemId:null, seed:0, revealedCount:0 },
    collected: [],                                         // permanent gallery history [{id,name,collectedAt}] — never auto-cleared
    cycleSeen: [],                                         // ids picked in the current pass, so nothing repeats until everyone's had a turn
    pending: false,                                        // true once fully revealed but not yet closed/downloaded — freezes it on screen
    banked: 0,                                             // completions earned while pending, waiting to be spent on the next piece
    staleSnapshot: null,                                   // set when live discovery found files art-data.js doesn't know about — see loadManifest

    async loadManifest(){
      // live discovery first: when served over http this picks up newly dropped-in
      // files immediately, no rebuild step (see the comment above). it always fails
      // under file:// (and on static hosts with no directory listing), so falling
      // through to the art-data.js snapshot — and, failing that, a plain manifest.json
      // fetch — is the normal path in those cases, not an error case.
      try{
        this.manifest = await discoverManifest({ baseDir, extensions, manifestUrl, itemsField, defaultExtra });
        // only meaningful here, in the branch where discovery actually succeeded:
        // that's the one moment this app can see both "what's really on disk" and
        // "what art-data.js thinks is on disk" at once, so it's the only place a
        // staleness check is even possible.
        this.staleSnapshot = detectStaleSnapshot(this.manifest[itemsField], dataKey, itemsField);
        return;
      }catch(e){ /* fall through to the baked snapshot / plain manifest.json below */ }
      const baked = window.ART_DATA && window.ART_DATA[dataKey];
      if(baked && Array.isArray(baked[itemsField]) && baked[itemsField].length){
        this.manifest = { [itemsField]: baked[itemsField] };
        return;
      }
      const res = await fetch(manifestUrl);
      this.manifest = await res.json();
    },
    pickNextEntry(){
      const all = this.manifest[itemsField];
      // filterPool (image track only — see "exclude"/"include") narrows the pool
      // before the cycle logic runs, so excluded folders never get a turn. falls
      // back to the unfiltered list if that would leave nothing to pick from,
      // rather than throwing — a stale/impossible exclusion shouldn't brick the app.
      const filtered = filterPool ? filterPool(all) : all;
      const items = filtered.length ? filtered : all;
      let pool = items.filter(e => !this.cycleSeen.includes(e.id));
      if(pool.length === 0){ this.cycleSeen = []; pool = items.slice(); }
      const entry = pool[Math.floor(Math.random() * pool.length)];
      this.cycleSeen.push(entry.id);
      return entry;
    },
    async startNew(){
      const entry = this.pickNextEntry();
      this.current = await loadItem(entry);
      this.progress = Object.assign({
        itemId: this.current.id,
        seed: randomSeed(),
        revealedCount: 0,
      }, progressExtra ? progressExtra(this.current) : null);
      this.pending = false;
    },
    async init(){
      await this.loadManifest();
      const entry = this.progress.itemId && this.manifest[itemsField].find(e => e.id === this.progress.itemId);
      if(entry){
        this.current = await loadItem(entry);
        const total = totalCellsFor(this.current);
        // a mismatch is only possible when there's an explicit order (set by a past
        // regrid) whose length no longer fits — a seed alone always regenerates
        // correctly-sized for whatever `total` turns out to be, so there's nothing
        // to rescue in that case; it's self-healing by construction.
        if(Array.isArray(this.progress.order) && this.progress.order.length !== total){
          // the cell count moved under us — either the source file changed, or the
          // grid preference did (a "block size" command run in an earlier session,
          // or an import from a save made under a different one). regrid, where the
          // track knows how, keeps the picture; otherwise fall back to a fresh order.
          const rescued = regrid && regrid(this.progress, this.current, this.pending);
          if(rescued) Object.assign(this.progress, rescued);
          else { this.progress.order = null; this.progress.seed = randomSeed(); }
        } else if(!Array.isArray(this.progress.order) && !Number.isFinite(this.progress.seed)){
          // neither an explicit order nor a seed — a corrupt save, or one that
          // slipped past the migration in restore() below. same fallback.
          this.progress.seed = randomSeed();
        }
        this.progress.revealedCount = Math.min(this.progress.revealedCount || 0, total);
        return;
      }
      await this.startNew();
    },
    totalCells(){ return totalCellsFor(this.current); },
    // how many cells one completed task uncovers. perTaskOverride (image track only —
    // see "block count") is a direct value that replaces the usual derivation from
    // revealTasks entirely, so it holds steady across images with different totals
    // rather than scaling with them.
    cellsPerCompletion(){
      if(perTaskOverride && perTaskOverride()) return Math.min(perTaskOverride(), this.totalCells());
      return Math.max(1, Math.ceil(this.totalCells() / (this.current.revealTasks || 6)));
    },
    // tasks-to-fully-reveal as actually shown to the user: the piece's own declared
    // value normally, but derived from the override when one is active (revealTasks
    // itself isn't touched, so switching the override off cleanly restores the
    // manifest's number rather than whatever this last computed to).
    tasksToFullyReveal(){
      if(perTaskOverride && perTaskOverride()) return Math.ceil(this.totalCells() / this.cellsPerCompletion());
      return this.current.revealTasks;
    },
    // reveals n more cells; once full, freezes as "pending" instead of auto-advancing —
    // the caller (close/download) decides when to actually move on.
    async reveal(n, onComplete){
      if(!this.current || this.pending) return;
      const total = totalCellsFor(this.current);
      this.progress.revealedCount = Math.min(total, this.progress.revealedCount + n);
      if(this.progress.revealedCount >= total){
        this.pending = true;
        if(onComplete) onComplete(this.current);
      }
    },
    // one finished task = one completion's worth of reveal. if the current piece is
    // already fully revealed and just waiting to be closed, the credit is *banked*
    // rather than dropped on the floor: the whole promise of the app is that every
    // completed task moves the reward forward, so "done 1,2,3" that finishes the
    // piece on task 1 must still pay out for tasks 2 and 3 (see applyBanked).
    async creditCompletion(onComplete){
      if(!this.current) return 'none';
      if(this.pending){ this.banked++; return 'banked'; }
      await this.reveal(this.cellsPerCompletion(), onComplete);
      return 'revealed';
    },
    // spends the banked completions on the freshly started piece. one at a time, so
    // if the bank is deep enough to finish this piece too it stops there and the rest
    // stays banked for the one after — nothing is ever lost, just deferred.
    async applyBanked(onComplete){
      let spent = 0;
      while(this.banked > 0 && !this.pending && this.current){
        this.banked--;
        spent++;
        await this.reveal(this.cellsPerCompletion(), onComplete);
      }
      return spent;
    },
    // re-points `current` at whatever progress.itemId says, for when state is replaced
    // wholesale underneath us — undo can rewind past a "close" that switched pieces,
    // and without this the panel would draw the old artwork with the new progress.
    // the loaded item also carries settings that live in the snapshot (the reveal
    // grid, the pace), so syncItem pulls those back too: here the restored progress
    // is the authority and the item follows it. (that's the opposite of init(),
    // where a *preference* changed and the saved progress is what has to adapt —
    // different direction because a rewind must reproduce exactly what you had.)
    async resync(){
      if(!this.manifest || !this.progress.itemId) return;
      if(!this.current || this.current.id !== this.progress.itemId){
        const entry = this.manifest[itemsField].find(e => e.id === this.progress.itemId);
        if(entry) this.current = await loadItem(entry);
      }
      if(syncItem && this.current) syncItem(this.current, this.progress);
    },
    // logs the finished piece to the permanent gallery and starts a new one; returns the finished item
    async closePending(){
      if(!this.pending) return null;
      const finished = this.current;
      this.collected.push({ id: finished.id, name: finished.name, collectedAt: Date.now() });
      await this.startNew();
      return finished;
    },
    // drops collected entries whose source file is no longer in the manifest —
    // deleted from ascii_art/image_art (and rebuilt out of manifest.json /
    // art-data.js) since they were collected. called wherever the manifest or
    // the collection could have just changed underneath `collected` (init, and
    // every full-state restore: undo/import/recover), so a removed piece quietly
    // drops out of the gallery instead of sitting there as a permanent "?" tile.
    // returns whether anything was actually dropped, so callers only re-save
    // state when there's something to persist.
    pruneMissing(){
      if(!this.manifest) return false;
      const known = new Set(this.manifest[itemsField].map(e => e.id));
      const before = this.collected.length;
      this.collected = this.collected.filter(c => known.has(c.id));
      return this.collected.length !== before;
    },
    serialize(){ return { progress: this.progress, collected: this.collected, cycleSeen: this.cycleSeen, pending: this.pending, banked: this.banked }; },
    restore(data){
      if(!data) return;
      this.progress = data.progress || { itemId:null, seed:0, revealedCount:0 };
      // legacy saves (from before progress moved to a seed) stored the shuffled
      // order outright — kept as an explicit override rather than migrated into a
      // seed, so an old save's art doesn't invisibly reshuffle on its first load
      // under this version.
      if(Array.isArray(this.progress.revealOrder) && this.progress.order === undefined){
        this.progress.order = this.progress.revealOrder;
      }
      delete this.progress.revealOrder;
      this.collected = data.collected || [];
      this.cycleSeen = data.cycleSeen || [];
      this.pending = !!data.pending;
      this.banked = data.banked || 0;
    },
  };
}

// ---------- ascii-art track ----------
// artworks live as plain text files under ascii_art/, indexed by ascii_art/manifest.json,
// so new ones can be dropped in without touching this code.
async function loadArtworkFile(entry){
  const text = entry.content !== undefined ? entry.content : await (await fetch('ascii_art/' + entry.file)).text();
  const rawRows = text.replace(/\r\n/g, '\n').split('\n');
  while(rawRows.length && rawRows[rawRows.length - 1] === '') rawRows.pop();
  const width = Math.max(1, ...rawRows.map(r => r.length));
  const rows = rawRows.map(r => r.padEnd(width, ' '));
  const cellIndices = [];
  rows.forEach((row, r) => {
    for(let c = 0; c < width; c++){ if(row[c] !== ' ') cellIndices.push(r * width + c); }
  });
  return {
    id: entry.id, name: entry.name, category: entry.category,
    revealTasks: entry.revealTasks || 6,
    // `rows` is the padded rectangle the reveal panel draws: every line runs the
    // full width of the piece so the block can't change size as cells fill in.
    // `sourceRows` is the file exactly as written, unpadded — the artwork as a
    // *document* rather than as a canvas. anything leaving the app (copy,
    // download — see asciiArtText) has to use sourceRows: the padding is often
    // far wider than the art itself (100+ trailing spaces a line on the widest
    // pieces), and pasted into anything that wraps at a width, those invisible
    // runs wrap every line and tear the picture apart.
    rows, sourceRows: rawRows, width, height: rows.length, cellIndices,
  };
}

// the text of an ascii piece as it should leave the app — for the clipboard or a
// downloaded .txt. trailing newline included, the way a text file normally ends.
// falls back to the padded rows only for an art object built somewhere that
// predates sourceRows, which shouldn't exist but costs nothing to tolerate.
function asciiArtText(art){
  return (art.sourceRows || art.rows).join('\n') + '\n';
}

const asciiTrack = createRevealTrack({
  baseDir: 'ascii_art/',
  extensions: ['.txt'],
  manifestUrl: 'ascii_art/manifest.json',
  itemsField: 'artworks',
  dataKey: 'ascii',
  loadItem: loadArtworkFile,
  totalCellsFor: item => item.cellIndices.length,
});

// ---------- image track ----------
// images live under image_art/, indexed by image_art/manifest.json. each entry declares
// a reveal grid (cols x rows); completing tasks pops that many "cube" tiles off the image.

// the source file's pixel dimensions, needed to give "block size" a stable meaning —
// a target px-per-block only means the same thing across images once it's measured
// against each one's real resolution, rather than assumed from the manifest grid,
// which for auto-discovered files is just a 6x4 default that says nothing about the
// photo's shape. cached because it costs a decode, and answered with a 3:2 guess if
// the file won't load at all, so a broken image degrades to a slightly-off grid
// instead of a hang.
const DEFAULT_DIMS = { w: 900, h: 600 };
const IMAGE_DIMS_TIMEOUT = 3000;
const imageDimsCache = {};
function imageDims(file){
  if(imageDimsCache[file]) return Promise.resolve(imageDimsCache[file]);
  return new Promise(resolve => {
    const img = new Image();
    let settled = false;
    // the guess from a timeout isn't cached — a slow decode that eventually
    // succeeds should give the real numbers next time, unlike a genuine error.
    const done = (dims, cache) => { if(settled) return; settled = true; if(cache) imageDimsCache[file] = dims; resolve(dims); };
    img.onload = () => done(img.naturalWidth && img.naturalHeight
      ? { w: img.naturalWidth, h: img.naturalHeight } : DEFAULT_DIMS, true);
    img.onerror = () => done(DEFAULT_DIMS, true);
    setTimeout(() => done(DEFAULT_DIMS, false), IMAGE_DIMS_TIMEOUT);
    img.src = 'image_art/' + file;
  });
}

// a saved/imported preference is untrusted input like everything else in a restored
// snapshot — anything that isn't exactly one of the real tiers falls back to null
// ("medium" — use the manifest grid).
function sanitizeBlockSizePref(p){
  if(!p || typeof p !== 'object' || !Number.isFinite(p.n)) return null;
  return Object.values(BLOCK_SIZE_TIERS).some(t => t.n === p.n) ? { n: p.n } : null;
}

function clampGrid(cols, rows){
  cols = Math.max(1, Math.round(cols) || 1);
  rows = Math.max(1, Math.round(rows) || 1);
  // scale both axes down together first, so the shape of the grid you asked for
  // survives being cut down to size. capping each side first instead would take a
  // 400x250 request to 100x100 — square blocks turned into slabs, which is exactly
  // the thing the count/size modes exist to avoid.
  if(cols * rows > GRID_MAX_CELLS){
    const k = Math.sqrt(GRID_MAX_CELLS / (cols * rows));
    cols = Math.max(1, Math.floor(cols * k));
    rows = Math.max(1, Math.floor(rows * k));
  }
  return { cols: Math.min(GRID_MAX_SIDE, cols), rows: Math.min(GRID_MAX_SIDE, rows) };
}

// turns the stored block-size preference into a concrete grid for one specific
// image. cols is chosen so cols x rows lands as close to the target count as whole
// blocks allow, with cols/rows matching the image's real aspect ratio (so blocks
// come out square-ish rather than stretched); rows is derived from cols rather than
// rounded independently, which is what keeps the product on target.
async function resolveGrid(entry){
  const declared = entry.grid && entry.grid.cols && entry.grid.rows
    ? { cols: entry.grid.cols, rows: entry.grid.rows }
    : { cols: 6, rows: 4 };                                // manifest entry with no grid — don't crash, just use the house default
  if(!blockSizePref) return clampGrid(declared.cols, declared.rows);
  if(blockSizePref.n === 1) return { cols: 1, rows: 1 };   // "full": always exactly one block, whatever the aspect ratio
  const dims = await imageDims(entry.file);
  const aspect = (dims.w / dims.h) || 1;
  const cols = Math.max(1, Math.round(Math.sqrt(blockSizePref.n * aspect)));
  return clampGrid(cols, blockSizePref.n / cols);
}

// ---------- regridding a piece that's already part-revealed ----------
// changing the grid must not throw away what you've uncovered. the revealed area is
// treated as a *region of the image*, not as a set of tile numbers: every new block
// is scored by how much of it the old revealed region covers (exact rectangle
// intersection — both grids are regular), then the most-covered blocks are the ones
// that come up revealed. so the picture you're looking at stays the picture you're
// looking at; only the resolution of the mask changes.
//
// how many blocks end up revealed is set by area, not by count: the revealed
// *fraction* is preserved and rounded to the nearest whole block of the new grid.
// two guards on that rounding:
//   - progress that rounds down to zero is kept at one block. this app's one
//     inviolable rule is that earned reveal never silently vanishes (see the banked-
//     completions logic above), and "you regridded and your 2% disappeared" is that
//     same leak wearing a different hat.
//   - a piece that wasn't finished can't come out finished. completing a piece is
//     something tasks do; a display setting rounding up to 100% would hand out a
//     gallery entry nobody earned. it stops one block short instead.
// takes the OLD order already materialized (see materializeOrder) rather than a
// progress object, so this doesn't care whether that order came from a stored
// seed or an earlier explicit override — either way the caller hands over a
// plain array and this produces a new one, since a coverage-weighted remap
// depends on the specific old revealed region and can't be re-derived from a
// formula the way a fresh shuffle can.
function remapReveal(oldOrder, oldRevealedCount, from, to, wasComplete){
  const oldTotal = from.cols * from.rows, newTotal = to.cols * to.rows;
  const revealedOld = new Set(oldOrder.slice(0, oldRevealedCount));

  const coverage = new Array(newTotal).fill(0);
  for(let nr = 0; nr < to.rows; nr++){
    const y0 = nr / to.rows, y1 = (nr + 1) / to.rows;
    // only the old rows this new row actually touches
    const r0 = Math.floor(y0 * from.rows), r1 = Math.min(from.rows - 1, Math.ceil(y1 * from.rows) - 1);
    for(let nc = 0; nc < to.cols; nc++){
      const x0 = nc / to.cols, x1 = (nc + 1) / to.cols;
      const c0 = Math.floor(x0 * from.cols), c1 = Math.min(from.cols - 1, Math.ceil(x1 * from.cols) - 1);
      let covered = 0;
      for(let orr = r0; orr <= r1; orr++){
        const oy0 = orr / from.rows, oy1 = (orr + 1) / from.rows;
        const oh = Math.min(y1, oy1) - Math.max(y0, oy0);
        if(oh <= 0) continue;
        for(let oc = c0; oc <= c1; oc++){
          if(!revealedOld.has(orr * from.cols + oc)) continue;
          const ox0 = oc / from.cols, ox1 = (oc + 1) / from.cols;
          const ow = Math.min(x1, ox1) - Math.max(x0, ox0);
          if(ow > 0) covered += ow * oh;
        }
      }
      coverage[nr * to.cols + nc] = covered * newTotal;    // as a fraction of one new block
    }
  }

  const fraction = oldTotal ? oldRevealedCount / oldTotal : 0;
  let keep = Math.round(fraction * newTotal);
  if(oldRevealedCount > 0 && keep < 1) keep = 1;
  if(!wasComplete && keep >= newTotal) keep = newTotal - 1;
  if(wasComplete) keep = newTotal;
  keep = Math.min(newTotal, Math.max(0, keep));

  // most-covered blocks first so the revealed region lands where it was; the random
  // tiebreak keeps equally-covered blocks (and the whole untouched remainder) from
  // uncovering in a readable left-to-right sweep later on. this result is a
  // coverage-weighted reordering, not a plain shuffle, so — unlike a fresh piece's
  // order — it has to be stored explicitly; `order` (not `seed`) is what carries it.
  const order = shuffledIndices(newTotal).sort((a, b) => coverage[b] - coverage[a]);
  return { order, revealedCount: keep, grid: { cols: to.cols, rows: to.rows } };
}

async function loadImageEntry(entry){
  const grid = await resolveGrid(entry);
  return {
    id: entry.id, name: entry.name, category: entry.category, file: entry.file,
    cols: grid.cols, rows: grid.rows,
    declaredGrid: entry.grid && entry.grid.cols ? { cols: entry.grid.cols, rows: entry.grid.rows } : { cols: 6, rows: 4 },
    revealTasks: entry.revealTasks || 6,
  };
}

// the top-level image_art/ subfolder a manifest entry lives in — read straight
// from "file" rather than "category", since category can be (and in this
// project's own manifest.json, is) overridden away from the real folder; the
// "exclude"/"include" commands are about physical folders, so they need the
// one field discovery never lets drift from disk.
function imageFolderOf(entry){
  return (entry && entry.file && entry.file.includes('/')) ? entry.file.split('/')[0] : '(root)';
}

const imageTrack = createRevealTrack({
  baseDir: 'image_art/',
  extensions: ['.png', '.jpg', '.jpeg', '.svg', '.webp', '.gif'],
  manifestUrl: 'image_art/manifest.json',
  itemsField: 'images',
  dataKey: 'image',
  loadItem: loadImageEntry,
  totalCellsFor: item => item.cols * item.rows,
  defaultExtra: { grid: { cols: 6, rows: 4 } },
  filterPool: items => items.filter(e => !excludedImageFolders.includes(imageFolderOf(e))),
  // the grid each saved reveal order was numbered against — without it, a reload
  // under a changed grid preference has no way to know where the revealed blocks were.
  progressExtra: item => ({ grid: { cols: item.cols, rows: item.rows } }),
  regrid: (progress, item, pending) => (progress.grid && progress.grid.cols)
    ? remapReveal(
        materializeOrder(progress, progress.grid.cols * progress.grid.rows),
        progress.revealedCount, progress.grid, { cols: item.cols, rows: item.rows }, pending)
    : null,
  syncItem: (item, progress) => {
    if(progress.grid && progress.grid.cols){ item.cols = progress.grid.cols; item.rows = progress.grid.rows; }
  },
  perTaskOverride: () => blockCountOverride,
});

function activeTrack(){ return displayMode === 'image' ? imageTrack : asciiTrack; }

