// ===== Momentum — app-render.js =====
// drawing the reveal panel + gallery, the fullscreen views, then the DOM wiring
// (keyboard, clicks, drag dividers) and boot. Loads last: its wiring runs immediately
// and boot calls into all three files above.
// Loaded by index.html as a plain <script src> (no modules: ES imports are blocked
// under file://, which this app has to keep working). Everything here is a global,
// shared across the four app-*.js files. Load order is fixed: app-state.js -> app-art.js -> app-commands.js -> app-render.js

// ---------- rendering ----------
function buildArtworkScene(art, progress){
  const { rows, width, height, cellIndices } = art;
  const revealed = new Set(
    materializeOrder(progress, cellIndices.length).slice(0, progress.revealedCount).map(pos => cellIndices[pos])
  );
  let html = '';
  for(let r = 0; r < height; r++){
    let line = '';
    for(let c = 0; c < width; c++){
      const ch = rows[r][c];
      if(ch === ' '){ line += ' '; continue; }
      const idx = r * width + c;
      // unrevealed cells are blank, not placeholder dots: dots traced the artwork's
      // whole silhouette before you'd earned any of it, which gave away the picture
      // and took the surprise out of the reveal. rows stay padded to the full width,
      // so the block keeps its size as it fills in.
      line += revealed.has(idx)
        ? `<span style="color:var(--amber)">${escapeHtml(ch)}</span>`
        : ' ';
    }
    html += line + '\n';
  }
  return `<pre class="reveal-scene">${html}</pre>`;
}

function buildImageScene(art, progress){
  const total = art.cols * art.rows;
  const revealed = new Set(materializeOrder(progress, total).slice(0, progress.revealedCount));
  let tiles = '';
  for(let i = 0; i < total; i++){
    tiles += `<div class="tile${revealed.has(i) ? ' revealed' : ''}"></div>`;
  }
  return (
    `<div class="image-stage">` +
      `<div class="image-frame">` +
        `<img class="image-base" src="image_art/${art.file}" alt="${escapeHtml(art.name)}">` +
        `<div class="tile-grid" style="grid-template-columns:repeat(${art.cols},1fr);grid-template-rows:repeat(${art.rows},1fr)">${tiles}</div>` +
      `</div>` +
    `</div>`
  );
}

// sizes a frame in real pixels rather than via CSS aspect-ratio, because the
// frame's own children are absolutely positioned (so it has no intrinsic
// content size for the browser's auto-sizing to key off). starts from the
// reveal grid's cols/rows as an approximate ratio (so there's a correctly-shaped
// box on first paint), then corrects to the photo's real aspect ratio once it
// loads. raster photos are additionally capped at their native pixel size so
// small images never get blown up past their real resolution; vector art has
// no such ceiling and is free to fill the available space. shared by the
// in-panel view and the fullscreen "display" overlay — they only differ in
// what counts as "available space" (getAvail). returns the layout function so
// the caller can re-run it (e.g. on resize).
function fitFrameToAvail(frame, img, art, getAvail){
  const isVector = /\.svg($|\?)/i.test(art.file);
  let ratio = art.cols / art.rows;

  function layout(){
    const { w: availW, h: availH } = getAvail();
    if(!availW || !availH) return;
    let w = availW, h = w / ratio;
    if(h > availH){ h = availH; w = h * ratio; }
    if(!isVector && img.naturalWidth && w > img.naturalWidth){
      w = img.naturalWidth; h = img.naturalHeight;
    }
    frame.style.width = `${w}px`;
    frame.style.height = `${h}px`;
  }

  const onLoad = () => {
    if(img.naturalWidth && img.naturalHeight) ratio = img.naturalWidth / img.naturalHeight;
    layout();
  };
  if(img.complete) onLoad(); else img.addEventListener('load', onLoad, { once:true });

  layout();
  return layout;
}

// a manifest entry pointing at a file that's been deleted (or never existed) shows
// up as nothing more than the browser's own broken-image icon sitting inside the
// tile frame, with no indication why — and the reveal tiles on top of it still
// "work" in the sense that they animate away, giving no hint anything is wrong.
// rather than sit there broken, this treats it as unplayable and moves straight to
// the next piece, the same way "next" does, with a printed reason so it's not a
// silent jump. brokenImageStreak guards against every image in the manifest being
// broken at once (a misconfigured image_art/, say) turning this into a silent
// infinite loop — it caps at one skip attempt per image in the manifest, then
// stops and says so plainly instead of hammering the network forever. a
// successful load anywhere resets it, so one bad file doesn't poison the count
// against images that load fine later.
async function handleImageLoadError(art){
  brokenImageStreak++;
  print(`could not load "${art.name}" — image_art/${art.file} is missing or unreadable.`, 'err');
  const manifestSize = (imageTrack.manifest && imageTrack.manifest.images && imageTrack.manifest.images.length) || 1;
  if(brokenImageStreak >= manifestSize){
    print(`that's every image in the collection failing to load — stopping here instead of skipping forever. check that the files under image_art/ actually exist, then reload.`, 'err');
    return;
  }
  print('skipping to the next piece...', 'info');
  await imageTrack.startNew();
  const spent = await imageTrack.applyBanked(a => printCompletionPrompt(a));
  if(spent) print(`(spent ${spent} banked completion${spent === 1 ? '' : 's'} on it)`, 'info');
  saveState(); renderPanel();
}

let imageResizeObserver = null;
function fitImageFrame(container, art){
  const stage = container.querySelector('.image-stage');
  const frame = container.querySelector('.image-frame');
  const img = container.querySelector('.image-base');
  if(imageResizeObserver){ imageResizeObserver.disconnect(); imageResizeObserver = null; }
  if(!stage || !frame || !img) return;

  // each render creates a fresh <img>, so this is re-wired every time rather than
  // once — there's no stale listener to worry about, but also no way to skip it.
  img.onerror = () => handleImageLoadError(art);
  img.onload = () => { brokenImageStreak = 0; };

  const layout = fitFrameToAvail(frame, img, art, () => {
    const cs = getComputedStyle(stage);
    return {
      w: stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
      h: stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom),
    };
  });
  imageResizeObserver = new ResizeObserver(layout);
  imageResizeObserver.observe(stage);
}

// ---------- fullscreen "display" ----------
// shows the current piece's live reveal state (not the pristine source file)
// stretched as large as the screen allows. works for both tracks: images keep the
// contain/no-upscale rules of the in-panel view, ascii art is scaled up by measuring
// its natural size and transforming to fit. exits on escape/enter/space or a click.
const FULLSCREEN_EXIT_KEYS = ['Escape', 'Enter', ' '];
let fullscreenEl = null, fullscreenResizeHandler = null;
// set only while fullscreen is showing a piece from the collected gallery (see
// openGalleryFullscreen) — null for the ordinary "display" of the live piece,
// which has no "next piece" to browse to. that's what left/right arrow only
// doing something in the gallery case, not during a plain "display".
let fullscreenGalleryIdx = null;
function handleFullscreenKey(e){
  if(fullscreenGalleryIdx !== null && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')){
    e.preventDefault();
    stepFullscreenGallery(e.key === 'ArrowRight' ? 1 : -1);
    return;
  }
  if(FULLSCREEN_EXIT_KEYS.includes(e.key)){
    e.preventDefault();                                  // space would otherwise scroll the page behind the overlay
    closeFullscreen();
  }
}
function closeFullscreen(){
  if(!fullscreenEl) return;
  fullscreenEl.remove();
  fullscreenEl = null;
  fullscreenGalleryIdx = null;
  if(fullscreenResizeHandler){ window.removeEventListener('resize', fullscreenResizeHandler); fullscreenResizeHandler = null; }
  document.removeEventListener('keydown', handleFullscreenKey);
  cmdInput.focus();
}
// both openers build their own content, then hand the finished layout function here
// so the exit wiring (click, keys, resize, focus) lives in exactly one place.
function mountFullscreen(innerHTML){
  // tear down any overlay that's already up first. without this, a second "display"
  // orphans the first one: it stays in the DOM, only the newest is tracked, so no
  // key or click can ever remove it and the screen is stuck black.
  closeFullscreen();
  fullscreenEl = document.createElement('div');
  fullscreenEl.id = 'fullscreen-overlay';
  fullscreenEl.innerHTML = innerHTML;
  document.body.appendChild(fullscreenEl);
  return fullscreenEl;
}
function wireFullscreen(layout){
  layout();
  fullscreenResizeHandler = layout;
  window.addEventListener('resize', fullscreenResizeHandler);
  fullscreenEl.addEventListener('click', closeFullscreen);
  // the exit-key listener goes on *after* the current event finishes. "display" is
  // normally run by pressing Enter, and that keydown is still bubbling up toward
  // document at this point — a listener added to an ancestor mid-propagation still
  // receives the event in flight, so attaching synchronously let the very Enter that
  // opened the overlay close it again on the same keystroke. (harmless back when
  // Escape was the only exit key; a self-cancel the moment Enter became one.)
  setTimeout(() => {
    if(fullscreenEl) document.addEventListener('keydown', handleFullscreenKey);
  }, 0);
  cmdInput.blur();
}
function openImageFullscreen(art, progress){
  const total = art.cols * art.rows;
  const revealed = new Set(materializeOrder(progress, total).slice(0, progress.revealedCount));
  let tiles = '';
  for(let i = 0; i < total; i++){
    tiles += `<div class="tile${revealed.has(i) ? ' revealed' : ''}"></div>`;
  }
  mountFullscreen(
    `<div class="image-frame">` +
      `<img class="image-base" src="image_art/${art.file}" alt="${escapeHtml(art.name)}">` +
      `<div class="tile-grid" style="grid-template-columns:repeat(${art.cols},1fr);grid-template-rows:repeat(${art.rows},1fr)">${tiles}</div>` +
    `</div>`
  );
  const frame = fullscreenEl.querySelector('.image-frame');
  const img = fullscreenEl.querySelector('.image-base');
  // the panel's own <img> (see fitImageFrame) is normally what catches a broken
  // file first, on the very first render — this is mainly a safety net for the
  // narrow race where the file gets deleted between that successful load and
  // opening fullscreen. closing the overlay first matters here in a way it doesn't
  // for the panel: the terminal where the message and the skip land is hidden
  // behind the fullscreen black screen, so leaving it up would print an
  // explanation nobody can see.
  img.onerror = () => { closeFullscreen(); handleImageLoadError(art); };
  wireFullscreen(fitFrameToAvail(frame, img, art, () => ({ w: window.innerWidth, h: window.innerHeight })));
}
// ascii is shown at its true size — the glyphs stay exactly as big as they are in
// the panel, because their size *is* the artwork: blowing them up turns crisp
// characters into soft giant letters and loses the texture the piece is made of.
// so fullscreen only means "centered on a black screen, with nothing else around
// it". the single exception is a piece too big to fit, which is scaled down just
// enough to touch the edges — shrinking keeps the character grid readable, where
// enlarging would have nothing to gain. measured rather than computed from a
// character aspect ratio, which would drift with the font.
function openAsciiFullscreen(art, progress){
  mountFullscreen(`<div class="ascii-fullscreen">${buildArtworkScene(art, progress)}</div>`);
  const holder = fullscreenEl.querySelector('.ascii-fullscreen');
  wireFullscreen(() => {
    holder.style.transform = 'none';                     // measure at natural size
    const rect = holder.getBoundingClientRect();
    if(!rect.width || !rect.height) return;
    const scale = Math.min(1, window.innerWidth / rect.width, window.innerHeight / rect.height);
    holder.style.transform = scale < 1 ? `scale(${scale})` : 'none';
  });
}
function cmd_display(){
  const track = activeTrack();
  if(!track.current){ print(`the ${displayMode} collection is still loading...`, 'info'); return; }
  if(displayMode === 'image') openImageFullscreen(track.current, track.progress);
  else openAsciiFullscreen(track.current, track.progress);
}

// ---------- fullscreen from the gallery ----------
// "gallery display <n>" (or left/right from an already-open one — see
// handleFullscreenKey) — a collected piece is complete, so unlike the live
// "display" this never needs a reveal-tile grid or progress object; it's just
// the finished art, as large as the screen allows. keeps galleryDetailIdx (and
// therefore the in-panel view underneath) in sync as you browse, so whatever
// you land on in fullscreen is still showing once you exit.
function openGalleryFullscreen(idx){
  const all = collectedGalleryList();
  if(all.length === 0) return;
  idx = ((idx % all.length) + all.length) % all.length;   // wraps both directions, so arrowing past either end loops rather than dead-ending
  const item = all[idx];
  const entry = galleryManifestEntry(item);
  if(!entry){
    print(`the source file for "${item.name}" is missing — it can't be shown fullscreen.`, 'err');
    return;
  }
  if(item.type === 'image'){
    const grid = entry.grid && entry.grid.cols ? entry.grid : { cols: 6, rows: 4 };
    const art = { cols: grid.cols, rows: grid.rows, file: entry.file, name: item.name };
    mountFullscreen(`<div class="image-frame"><img class="image-base" src="image_art/${entry.file}" alt="${escapeHtml(item.name)}"></div>`);
    const frame = fullscreenEl.querySelector('.image-frame');
    const img = fullscreenEl.querySelector('.image-base');
    // mirrors openImageFullscreen's own onerror: close first so the message
    // lands on a terminal that's actually visible, not hidden behind the overlay.
    // no handleImageLoadError here — that's specific to skipping the *live*
    // track forward, which doesn't apply to browsing a static collection.
    img.onerror = () => {
      closeFullscreen();
      print(`image_art/${entry.file} is missing or unreadable.`, 'err');
    };
    fullscreenGalleryIdx = idx;
    galleryOpen = true; galleryDetailIdx = idx; renderPanel();
    wireFullscreen(fitFrameToAvail(frame, img, art, () => ({ w: window.innerWidth, h: window.innerHeight })));
  } else {
    // ascii has to load before there's anything to mount — unlike the image
    // branch, this doesn't open (or disturb whatever's already open) until the
    // text is actually in hand, so a broken file during a left/right browse
    // leaves you exactly where you were rather than closing on a failed step.
    loadArtworkFile(entry).then(art => {
      const full = { order: Array.from({length: art.cellIndices.length}, (_,i)=>i), revealedCount: art.cellIndices.length };
      galleryOpen = true; galleryDetailIdx = idx; renderPanel();
      openAsciiFullscreen(art, full);   // mounts via closeFullscreen(), which clears fullscreenGalleryIdx — so this must be set after, not before
      fullscreenGalleryIdx = idx;
    }).catch(() => {
      print(`could not load "${item.name}".`, 'err');
    });
  }
}
function stepFullscreenGallery(delta){
  if(fullscreenGalleryIdx === null) return;
  const all = collectedGalleryList();
  if(all.length <= 1) return;   // nothing to step to
  openGalleryFullscreen(fullscreenGalleryIdx + delta);
}

// ---------- real browser fullscreen ----------
// a different thing from "display": that one enlarges the artwork inside the page,
// this is the F11 equivalent — the whole app, no browser chrome, terminal included.
// nothing here awaits before calling requestFullscreen, deliberately: browsers only
// grant it while the keystroke that ran the command still counts as user activation,
// and an await would spend that. state is read live from the document rather than
// tracked in a variable, since escape/F11 can leave fullscreen behind our back.
function isBrowserFullscreen(){
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}
function cmd_fullscreen(arg){
  const el = document.documentElement;
  const request = el.requestFullscreen || el.webkitRequestFullscreen;
  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if(!request || !exit){ print('this browser has no fullscreen api — use F11 instead', 'err'); return; }
  arg = (arg || '').toLowerCase();
  if(arg && !['on','off'].includes(arg)){ print('usage: fullscreen [on|off]  (no argument toggles)', 'err'); return; }
  const now = isBrowserFullscreen();
  const want = arg ? arg === 'on' : !now;                  // bare "fullscreen" toggles
  if(want === now){ print(`already ${now ? 'fullscreen' : 'windowed'}`, 'info'); return; }
  // the prefixed versions return undefined instead of a promise, hence the wrap.
  Promise.resolve(want ? request.call(el) : exit.call(document)).then(
    () => print(want
      ? 'fullscreen on — press esc, or type "fullscreen off", to come back.'
      : 'fullscreen off.', 'ok'),
    () => print(want
      ? 'the browser refused fullscreen — some only allow it from F11 or a click'
      : 'could not leave fullscreen', 'err')
  );
}

// ids are assigned once, at creation, and never reused while the task is still
// live — pending, active, or archived. that's what makes an id a safe thing to
// remember between commands: complete #3, and #5 is still #5, not whatever
// slides into that slot next render. a new task gets the smallest integer
// nothing in either list is currently using, rather than an ever-climbing
// counter, so the numbers stay small and typeable over the long run — deleting
// a task (or "archive rm"-ing one) frees its id back into the pool instead of
// the id space only ever growing.
function nextFreeId(){
  const used = new Set([...tasks, ...archive].map(t => t.id));
  let id = 1;
  while(used.has(id)) id++;
  return id;
}

// ---------- collected-art gallery (contact sheet) ----------
// switches the reveal panel back to the live in-progress piece, out of gallery
// view. called by anything that changes, or specifically wants to show, the
// live reveal — so that action is what you actually see next, rather than a
// gallery grid that's now stale relative to what you just did.
function showLiveReveal(){
  galleryOpen = false;
  galleryDetailIdx = null;
}
// the one list "gallery"/"gallery show <n>" both work from — sorted the same
// way every time (oldest collected first), so a number this prints keeps
// meaning the same piece across separate commands as long as nothing new gets
// collected in between. matches how "recover <n>"/"exclude <n>" already treat
// their own numbered lists: recomputed fresh, never cached.
function collectedGalleryList(){
  return [
    ...asciiTrack.collected.map(c => ({ ...c, type:'ascii' })),
    ...imageTrack.collected.map(c => ({ ...c, type:'image' })),
  ].sort((a,b) => a.collectedAt - b.collectedAt);
}
// a collected item only remembers {id, name, collectedAt} — this resolves the
// full manifest entry (file path, grid, …) needed to actually redraw it. can
// come back empty if the source file was ever removed from the manifest after
// being collected; callers show a "missing" placeholder rather than crash.
function galleryManifestEntry(item){
  const track = item.type === 'image' ? imageTrack : asciiTrack;
  const field = item.type === 'image' ? 'images' : 'artworks';
  return track.manifest && track.manifest[field] && track.manifest[field].find(e => e.id === item.id);
}
// scales el (measured at its natural size) down to fit inside box, anchored at
// the top-left corner — same technique openAsciiFullscreen uses to blow ascii
// art up to fill a screen, run in reverse to shrink it into a thumbnail instead.
function fitThumbToBox(el, box){
  el.style.transform = 'none';
  const rect = el.getBoundingClientRect(), boxRect = box.getBoundingClientRect();
  if(!rect.width || !rect.height || !boxRect.width || !boxRect.height) return;
  const scale = Math.min(boxRect.width / rect.width, boxRect.height / rect.height);
  el.style.transform = `scale(${scale})`;
  el.style.transformOrigin = 'top left';
}
function renderGalleryPanel(g){
  const all = collectedGalleryList();
  if(imageResizeObserver){ imageResizeObserver.disconnect(); imageResizeObserver = null; }
  if(all.length === 0){
    // the collection emptied out from under an open gallery view — only reachable
    // via undo/import/recover rewinding past everything you'd collected, but that's
    // exactly the kind of rewind this app makes easy, so it has to degrade cleanly
    // rather than render a detail view pointing at a piece that no longer exists.
    showLiveReveal();
    g.innerHTML = '<div class="empty-panel">no artworks collected yet — keep completing tasks!</div>';
    return;
  }
  if(galleryDetailIdx != null && all[galleryDetailIdx]) renderGalleryDetail(g, all, galleryDetailIdx);
  else renderGalleryGrid(g, all);
}
function renderGalleryGrid(g, all){
  const tiles = all.map((c, i) => {
    const entry = galleryManifestEntry(c);
    const thumb = !entry
      ? `<div class="gallery-missing">?</div>`
      : c.type === 'image'
        ? `<img class="gallery-thumb-img" src="image_art/${entry.file}" alt="${escapeHtml(c.name)}">`
        : `<pre class="gallery-thumb-ascii" data-idx="${i}"></pre>`;   // text filled in async below
    return `<div class="gallery-tile" data-idx="${i}" title="${escapeHtml(c.name)}">` +
      `<div class="gallery-thumb">${thumb}</div>` +
      `<div class="gallery-cap">${i + 1}. ${escapeHtml(c.name)}</div>` +
    `</div>`;
  }).join('');
  g.innerHTML =
    `<div class="artwork-title">your collection <span class="artwork-progress">${all.length} piece${all.length === 1 ? '' : 's'} · click one, or "gallery show &lt;n&gt;"</span></div>` +
    `<div class="gallery-grid">${tiles}</div>`;
  // ascii thumbnails need their real text loaded before there's anything to scale
  // to fit — images just hand the browser a URL and it takes care of itself.
  // fitting once, here, is enough: the grid's tracks are a fixed width (see the
  // stylesheet), so a thumb box is the same 96px square no matter how wide the
  // panel gets, and a scale computed against it stays correct. no ResizeObserver
  // for this view, unlike the live/single-piece ones — those size their frame
  // *from* the available space and genuinely have to recompute; re-measuring a
  // box that can't change would just be a forced layout per thumbnail per frame
  // for the whole length of a divider drag.
  all.forEach((c, i) => {
    if(c.type !== 'ascii') return;
    const entry = galleryManifestEntry(c);
    if(!entry) return;
    loadArtworkFile(entry).then(art => {
      const pre = g.querySelector(`.gallery-thumb-ascii[data-idx="${i}"]`);
      if(!pre) return;   // the panel moved on (re-rendered, or left gallery view) before this resolved
      pre.textContent = art.rows.join('\n');
      fitThumbToBox(pre, pre.parentElement);
    }).catch(() => { /* a missing/unreadable file just leaves the placeholder blank */ });
  });
}
function renderGalleryDetail(g, all, idx){
  const c = all[idx];
  const entry = galleryManifestEntry(c);
  const header = `<div class="artwork-title">${escapeHtml(c.name)} <span class="artwork-progress">${idx + 1}/${all.length} · collected ${new Date(c.collectedAt).toLocaleDateString()} · click the piece, or "gallery close", to go back</span></div>`;
  if(!entry){
    g.innerHTML = header + `<div class="empty-panel err">the source file for "${escapeHtml(c.name)}" is missing — it can't be redrawn, but it's still in your collection.</div>`;
    return;
  }
  if(c.type === 'image'){
    g.innerHTML = header + `<div class="image-stage"><div class="image-frame"><img class="image-base" src="image_art/${entry.file}" alt="${escapeHtml(c.name)}"></div></div>`;
    const stage = g.querySelector('.image-stage'), frame = g.querySelector('.image-frame'), img = g.querySelector('.image-base');
    if(!stage || !frame || !img) return;   // same defensive guard fitImageFrame uses — the query should never actually miss right after the innerHTML that created it
    const grid = entry.grid && entry.grid.cols ? entry.grid : { cols: 6, rows: 4 };
    img.onerror = () => {
      g.innerHTML = header + `<div class="empty-panel err">image_art/${escapeHtml(entry.file)} is missing or unreadable.</div>`;
    };
    const layout = fitFrameToAvail(frame, img, { cols: grid.cols, rows: grid.rows, file: entry.file }, () => {
      const cs = getComputedStyle(stage);
      return { w: stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
               h: stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) };
    });
    imageResizeObserver = new ResizeObserver(layout);
    imageResizeObserver.observe(stage);
  } else {
    g.innerHTML = header + '<div class="empty-panel">loading...</div>';
    loadArtworkFile(entry).then(art => {
      // still on the same detail piece? renderPanel() may have moved on (another
      // command, or leaving gallery view) by the time this resolves.
      if(!galleryOpen || galleryDetailIdx !== idx) return;
      // fully revealed, not driven by any track's live progress — a collected
      // piece is done, so every cell counts as shown regardless of order.
      const full = { order: Array.from({length: art.cellIndices.length}, (_,i)=>i), revealedCount: art.cellIndices.length };
      g.innerHTML = header + buildArtworkScene(art, full);
    }).catch(() => {
      g.innerHTML = header + `<div class="empty-panel err">could not load "${escapeHtml(c.name)}".</div>`;
    });
  }
}

function renderPanel(){
  // every task mutation already ends in renderPanel(), so hanging the split-view
  // pane's refresh off it is what keeps the always-visible list actually current.
  if(listPaneVisible()) renderListPane();
  // when the reveal panel is display:none (tasks view with split off), rendering into
  // it would measure a zero-sized box (fitImageFrame) and observe an element that can
  // never resize. skipped outright instead — whatever brings it back on screen
  // ("view art", "split on") re-renders it.
  if(!revealPaneVisible()){
    if(imageResizeObserver){ imageResizeObserver.disconnect(); imageResizeObserver = null; }
    updateStats();
    return;
  }
  const g = document.getElementById('reveal-panel');
  if(galleryOpen){
    renderGalleryPanel(g);
    updateStats();
    return;
  }
  const track = activeTrack();
  if(!track.current){
    g.innerHTML = collectionLoadError
      ? `<div class="empty-panel err">${escapeHtml(collectionLoadError)}</div>`
      : '<div class="empty-panel">loading the collection...</div>';
    updateStats();
    return;
  }
  const art = track.current, progress = track.progress;
  const total = track.totalCells();
  const pct = total ? Math.round(progress.revealedCount / total * 100) : 0;
  const scene = displayMode === 'image' ? buildImageScene(art, progress) : buildArtworkScene(art, progress);
  const pendingTxt = track.pending ? ' · COMPLETE — type "close" or "download"' : '';
  g.innerHTML =
    `<div class="artwork-title">${escapeHtml(art.name)} <span class="artwork-progress">${progress.revealedCount}/${total} pieces · ${pct}% · ${displayMode} mode${pendingTxt}</span></div>` +
    scene;
  if(displayMode === 'image'){
    fitImageFrame(g, art);
  } else if(imageResizeObserver){
    imageResizeObserver.disconnect();
    imageResizeObserver = null;
  }
  updateStats();
}

function updateStats(){
  const total = tasks.length;
  const collected = asciiTrack.collected.length + imageTrack.collected.length;
  const parts = [
    `${total} total`,
    `${archive.length} completed`,
    ...(featureOn('projects') ? [`${projects.length} project${projects.length===1?'':'s'}`] : []),
    `${collected} art collected`,
  ];
  document.getElementById('stats').textContent = parts.join(' · ');
}


// ---------- input wiring ----------
const cmdInput = document.getElementById('cmd');
// echoes + runs a line exactly as if it had been typed and Enter pressed —
// shared by the real Enter handler and the list pane's [id]-bracket click
// shortcut (see below), so a click-triggered "done 3" leaves the same echo and
// history entry a typed one would, rather than a second, silent code path.
function runCommandLine(val){
  if(val.trim() === '') return;
  printEcho(val);
  pushCmdHistory(val);
  handleCommand(val).catch(err => print(`something went wrong: ${err.message}`, 'err'));
}
// tracks an in-progress Tab cycle: `applied` is the exact value this last wrote
// into the box, and repeated Tabs only advance the cycle while the box still
// holds it — type anything at all and the next Tab starts a fresh completion
// against the new text instead of continuing a stale candidate list.
let completionState = null;
const tabHintEl = document.getElementById('tab-hint');
// the whole point of keeping `candidates` around instead of just the one Tab
// picked: this renders every option computeCompletion() found, with whichever
// one is currently sitting in the input box picked out from the rest — so
// finding out what Tab offers stops requiring pressing it repeatedly and
// watching the input box change underneath you.
function renderCompletionHint(){
  tabHintEl.innerHTML = '';
  // .open is what makes it visible at all (it's display:none otherwise), so
  // toggling the class here is also what hides the panel the moment there's
  // nothing to show — no separate teardown path to keep in step.
  tabHintEl.classList.toggle('open', !!completionState);
  if(!completionState) return;
  const { candidates, idx } = completionState;
  let activeEl = null;
  candidates.forEach((c, i) => {
    const span = document.createElement('span');
    span.textContent = c;
    if(i === idx){ span.className = 'active'; activeEl = span; }
    tabHintEl.appendChild(span);
  });
  // only the longest lists overflow the panel's max-height, but when one does,
  // cycling would otherwise walk the highlight off the bottom and leave you
  // pressing Tab against a list you can no longer see. 'nearest' scrolls the
  // minimum needed, so a candidate already on screen doesn't shift anything.
  if(activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest' });
}
function applyCompletion(){
  const { base, candidates, idx } = completionState;
  completionState.applied = base + candidates[idx];
  cmdInput.value = completionState.applied;
}
// how many columns the panel is actually showing. it can't be assumed or stored:
// the grid is auto-fill (see momentum.css), so the browser picks the count from
// the console's width at layout time, and it changes when the window or the
// dragged column divider does. reading the resolved track list back is the only
// way Up/Down can know what "one row" currently means.
function completionColumns(){
  const tracks = getComputedStyle(tabHintEl).gridTemplateColumns;
  if(!tracks || tracks === 'none') return 1;               // display:none, or a browser that didn't resolve it
  return Math.max(1, tracks.trim().split(/\s+/).length);
}
const COMPLETION_ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
// left/right step through the list in order; up/down step by a whole row. both
// wrap, because Tab already wraps and having the arrows dead-end instead would be
// two different rules for moving through one list. the wrap targets are computed
// rather than clamped so they always land on a real candidate: the last row of a
// grid is usually ragged, so "the item above" from row 0 is the bottom-most item
// *in that column*, which isn't the last item in the list.
function moveCompletion(key){
  const { candidates, idx } = completionState;
  const cols = completionColumns();
  const col = idx % cols;
  let next = idx;
  if(key === 'ArrowRight')     next = (idx + 1) % candidates.length;
  else if(key === 'ArrowLeft') next = (idx - 1 + candidates.length) % candidates.length;
  else if(key === 'ArrowDown'){
    next = idx + cols;
    if(next >= candidates.length) next = col;              // off the bottom — back to the top of this column
  }
  else if(key === 'ArrowUp'){
    next = idx - cols;
    if(next < 0) next = col + Math.floor((candidates.length - 1 - col) / cols) * cols;
  }
  completionState.idx = next;
  applyCompletion();
  renderCompletionHint();
}
function handleTab(){
  if(completionState && cmdInput.value === completionState.applied){
    completionState.idx = (completionState.idx + 1) % completionState.candidates.length;
    applyCompletion();
    renderCompletionHint();
    return;
  }
  const { base, candidates } = computeCompletion(cmdInput.value);
  if(candidates.length === 0){ completionState = null; renderCompletionHint(); return; }
  completionState = { base, candidates, idx: 0, applied: null };
  applyCompletion();
  // an unambiguous completion finishes the word and moves on: the trailing space
  // means the very next Tab completes the *next* argument rather than re-offering
  // the one just settled. dropping the state is what lets that happen.
  if(candidates.length === 1){
    cmdInput.value += ' ';
    completionState = null;
  }
  // a single, now-applied match clears completionState right above, so this
  // renders nothing for it — correct: with only one candidate there was never
  // anything to disambiguate, so there's nothing worth showing before it vanishes.
  renderCompletionHint();
}
// Up/Down search cmdHistory by the prefix you'd already typed when you first
// pressed Up, not just walk it linearly — type "do", press Up, and only past
// commands starting with "do" come back. `historyWalk` is captured on the first
// Up of a sequence (prefix + the matching entries, most-recent-first) and just
// advances on every Up/Down after that; any other key drops it (see below), so
// the next Up starts a fresh search against whatever's typed by then — the same
// behavior a real shell's Up arrow has.
function historyUp(){
  if(!historyWalk){
    const prefix = cmdInput.value;
    const matches = cmdHistory.filter(c => c.startsWith(prefix)).reverse();
    if(matches.length === 0) return;
    historyWalk = { prefix, matches, idx: 0 };
  } else if(historyWalk.idx < historyWalk.matches.length - 1){
    historyWalk.idx++;
  } else {
    return;   // already at the oldest match — nothing further back to show
  }
  cmdInput.value = historyWalk.matches[historyWalk.idx];
  cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
}
function historyDown(){
  if(!historyWalk) return;
  if(historyWalk.idx === 0){
    cmdInput.value = historyWalk.prefix;                 // walked back down past the newest match — restore what you'd typed
    historyWalk = null;
  } else {
    historyWalk.idx--;
    cmdInput.value = historyWalk.matches[historyWalk.idx];
  }
  cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
}
cmdInput.addEventListener('keydown', (e)=>{
  if(e.key === 'Tab'){
    e.preventDefault();                                  // Tab would otherwise move focus out of the input
    handleTab();
    historyWalk = null;                                  // Tab isn't history navigation — a suspended search shouldn't outlive it
    return;
  }
  // while the panel is open the arrows belong to it, not to the command history
  // (Up/Down) or the text caret (Left/Right) — the panel is the thing you're
  // looking at, so it's the thing they should move. it only opens on Tab and
  // closes on the next ordinary keystroke, so this never shadows history for
  // long, and Escape (falling through below) closes it deliberately.
  if(completionState && COMPLETION_ARROWS.includes(e.key)){
    moveCompletion(e.key);
    e.preventDefault();
    return;
  }
  completionState = null;                                // any other key invalidates the completion cycle
  renderCompletionHint();                                // ...and clears whatever candidate list was on screen for it
  if(e.key === 'ArrowUp'){
    historyUp();
    e.preventDefault();
  } else if(e.key === 'ArrowDown'){
    historyDown();
    e.preventDefault();
  } else {
    historyWalk = null;                                  // typing (or Enter) invalidates the history-search cycle
    if(e.key === 'Enter'){
      runCommandLine(cmdInput.value);
      cmdInput.value = '';
    }
  }
});
// a plain click should refocus the input, but a drag-select shouldn't lose its
// selection the moment the mouse comes up — isCollapsed is false only when text
// is actually selected, so that's the one case this backs off.
document.body.addEventListener('click', ()=> { if(window.getSelection().isCollapsed) cmdInput.focus(); });

// ---------- clicking a row in the list pane ----------
// inserts at the caret rather than always appending to the end, so clicking a row
// while you're editing mid-command lands the id where you're actually typing.
// continues an id list rather than starting a new argument whenever the caret
// sits right after a digit — that's what turns "done " + click + click into
// "done 3,7" instead of "done 3 7" (which splitIds doesn't accept) or "done 37".
function insertIdAtCaret(id){
  const val = cmdInput.value;
  const pos = cmdInput.selectionStart != null ? cmdInput.selectionStart : val.length;
  const before = val.slice(0, pos), after = val.slice(pos);
  let insert = String(id);
  if(/\d$/.test(before)) insert = ',' + insert;
  else if(before && !/\s$/.test(before)) insert = ' ' + insert;
  cmdInput.value = before + insert + after;
  cmdInput.focus();
  cmdInput.setSelectionRange(pos + insert.length, pos + insert.length);
}
document.getElementById('list-pane').addEventListener('click', (e) => {
  // a drag-select ending on a row is copying a title, not clicking it — same
  // guard the terminal's own click-to-refocus handler uses just above.
  if(!window.getSelection().isCollapsed) return;
  const row = e.target.closest('.line[data-id]');
  if(!row) return;
  const id = row.getAttribute('data-id');
  // a third click target, checked before the other two: the [+]/[–] mark that
  // opens or closes one task's metadata line. its own thing entirely — not "done
  // <id>", not an id inserted into the command line — so it returns immediately
  // rather than falling into either of those.
  if(e.target.closest('.row-toggle')){
    const numId = Number(id);
    if(expandedTaskIds.has(numId)) expandedTaskIds.delete(numId); else expandedTaskIds.add(numId);
    renderListPane();
    return;
  }
  if(e.target.closest('.row-id')){
    // pre-fills the command, doesn't run it — clicking a task is not the same
    // as deciding it's done. replaces the input outright rather than inserting,
    // since "done <id>" is a complete, ready-to-edit command on its own, not
    // something to build up the way plain row clicks accumulate ids.
    cmdInput.value = `done ${id}`;
    cmdInput.focus();
    cmdInput.setSelectionRange(cmdInput.value.length, cmdInput.value.length);
  } else {
    insertIdAtCaret(id);
  }
});

// ---------- clicking a tile in the gallery contact sheet ----------
// a tile drills into that piece's detail view; clicking the detail view (there's
// nothing else in it to click) goes back to the grid — same "click in, click out"
// pattern as the list pane's row clicks just above.
document.getElementById('reveal-panel').addEventListener('click', (e) => {
  if(!galleryOpen) return;
  const tile = e.target.closest('.gallery-tile');
  if(tile){
    const idx = parseInt(tile.getAttribute('data-idx'), 10);
    if(Number.isFinite(idx)){ galleryDetailIdx = idx; renderPanel(); }
    return;
  }
  if(galleryDetailIdx != null){ galleryDetailIdx = null; renderPanel(); }
});

// ---------- resize dividers ----------
// both positions are kept as a percentage rather than pixels, so they hold their
// proportions when the window resizes, and both are saved with the rest of the
// state so the layout you set is the layout you get back next time.
function wireDivider(el, axis, onDrag){
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();                                  // don't start a text selection while dragging
    el.setPointerCapture(e.pointerId);                   // keep receiving moves even when the cursor outruns the 7px divider
    document.body.classList.add('dragging', `dragging-${axis}`);
    const onMove = (ev) => onDrag(ev);
    const onEnd = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onEnd);
      el.removeEventListener('pointercancel', onEnd);
      document.body.classList.remove('dragging', `dragging-${axis}`);
      saveState();
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onEnd);
    el.addEventListener('pointercancel', onEnd);
  });
}

// the horizontal one: trades height between the stacked panel and the console,
// measured down from the top of the left column. whichever panel is stacked in the
// current view is the one being resized, so this reads the slot, not a fixed id.
wireDivider(document.getElementById('split-divider'), 'row', (ev) => {
  const rect = document.getElementById('term-wrap').getBoundingClientRect();
  const pane = document.querySelector('.slot-stacked');
  if(!rect.height || !pane) return;
  splitRatio = Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, ((ev.clientY - rect.top) / rect.height) * 100));
  pane.style.flex = `0 0 ${splitRatio}%`;
});

// the vertical one: trades width between the console column and the side panel, in
// either view — it's the side panel's width being set, so the measurement runs
// inward from whichever edge that panel is against, which mirroring flips. writes
// to whichever ratio belongs to the current view, so dragging one view's divider
// never disturbs the other's.
wireDivider(document.getElementById('col-divider'), 'col', (ev) => {
  const rect = document.getElementById('main').getBoundingClientRect();
  const pane = document.querySelector('.slot-side');
  if(!rect.width || !pane) return;
  const span = mirrored ? ev.clientX - rect.left : rect.right - ev.clientX;
  const pct = Math.min(SIDE_MAX, Math.max(SIDE_MIN, (span / rect.width) * 100));
  if(viewMode === 'tasks') taskPaneRatio = pct; else artPaneRatio = pct;
  pane.style.flex = `0 0 ${pct}%`;
});

// ---------- the on-screen keyboard ----------
// 100dvh (see momentum.css) sizes the app to the screen minus the browser's own
// chrome — but a phone's soft keyboard is not chrome. It slides in over the page
// without changing dvh at all, so the bottom row of a full-height layout, which
// here is the command input, ends up underneath it: hidden at exactly the moment
// you're typing into it. visualViewport is the only thing that reports the area
// genuinely left visible, so while the keyboard is up the app is pinned to that
// instead.
// Only ever active at the stacked breakpoint: the inline height is cleared the
// moment the query stops matching, so turning a phone to landscape (or any wide
// viewport) is back on the plain CSS height with nothing to undo by hand.
const smallScreenQuery = window.matchMedia('(max-width: 700px)');
function syncViewportHeight(){
  const vv = window.visualViewport;
  if(!vv || !smallScreenQuery.matches){ document.body.style.height = ''; return; }
  document.body.style.height = vv.height + 'px';
}
if(window.visualViewport) window.visualViewport.addEventListener('resize', syncViewportHeight);
// addListener is the pre-2021 Safari spelling — this is the one file in the app
// most likely to be read on an old phone, so it's worth the two extra lines.
if(smallScreenQuery.addEventListener) smallScreenQuery.addEventListener('change', syncViewportHeight);
else if(smallScreenQuery.addListener) smallScreenQuery.addListener(syncViewportHeight);
syncViewportHeight();

// ---------- boot ----------
// before loadState, so the @font-face rules exist by the time applyFont() picks a
// family out of them — otherwise the saved font renders as fallback for a frame.
installBundledFonts();
cmdHistory = loadCmdHistory();                          // outside STORAGE_KEY (see HISTORY_KEY) — restored ahead of loadState()'s own load, not part of it
// the greeting lives in loadState() rather than here: it says something different
// to a first-time visitor than to someone on their two-hundredth session, and
// which of those you are is only knowable once localStorage has been read.
loadState();
