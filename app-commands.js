// ===== Momentum — app-commands.js =====
// the terminal itself plus every command: the COMMANDS table, help, tab completion,
// did-you-mean, guard rails, filters, and the cmd_* implementations with their
// task-list text rendering. Also builds outputEl/ALIASES at load time.
// Loaded by index.html as a plain <script src> (no modules: ES imports are blocked
// under file://, which this app has to keep working). Everything here is a global,
// shared across the four app-*.js files. Load order is fixed: app-state.js -> app-art.js -> app-commands.js -> app-render.js

// ---------- terminal ----------
const outputEl = document.getElementById('output');
// output only ever grows — print()/printSegments()/printHanging()/printEcho() and
// gallery's <pre>/<img> inserts all append, nothing removes a line except "clear".
// capped so a long-running session doesn't quietly turn the DOM node into
// thousands of live elements; trimmed from the top, since the lines worth keeping
// around are the recent ones, not the oldest.
const OUTPUT_MAX_LINES = 2000;
function trimOutput(){
  while(outputEl.childElementCount > OUTPUT_MAX_LINES) outputEl.removeChild(outputEl.firstChild);
}
// force-scrolling to the bottom on every print is right most of the time — but not
// when you've scrolled up to read backlog, where it yanks you back down before
// you've finished. checked *before* the append (appendChild changes scrollHeight
// out from under a check taken after), and only re-pins the view if you were
// already within a hair of the bottom — standard terminal behavior.
const AUTOSCROLL_THRESHOLD_PX = 50;
function isNearOutputBottom(){
  return outputEl.scrollHeight - outputEl.scrollTop - outputEl.clientHeight < AUTOSCROLL_THRESHOLD_PX;
}
function print(text, cls){
  const div = document.createElement('div');
  div.className = 'line' + (cls ? ' '+cls : '');
  // a div holding the empty string gets no line box at all, so it renders at zero
  // height — which meant every print('') written as a blank separator (the help
  // screens are full of them) quietly produced nothing, and the sections they were
  // meant to space apart ran together. one space is preserved by the pre-wrap these
  // lines already use and comes out exactly one line tall, which is what was asked
  // for at each of those call sites.
  div.textContent = text === '' ? ' ' : text;
  const stick = isNearOutputBottom();
  outputEl.appendChild(div);
  if(stick) outputEl.scrollTop = outputEl.scrollHeight;
  trimOutput();
}
// like print(), but for a single line built from differently-styled runs (e.g.
// a bright title followed by dim [tag] fields) — each segment keeps its own class.
function printSegments(segments, indentCh, cls){
  const div = document.createElement('div');
  div.className = 'line' + (cls ? ' ' + cls : '');
  if(indentCh){ div.style.paddingLeft = indentCh + 'ch'; div.style.textIndent = '-' + indentCh + 'ch'; }
  segments.forEach(seg => {
    const span = document.createElement('span');
    if(seg.cls) span.className = seg.cls;
    span.textContent = seg.text;
    div.appendChild(span);
  });
  const stick = isNearOutputBottom();
  outputEl.appendChild(div);
  if(stick) outputEl.scrollTop = outputEl.scrollHeight;
  trimOutput();
}
// like print(), but for a line whose column-aligned text (leading spaces baked
// in, same as everywhere else in this file) might be too wide for the terminal.
// padding-left pushes the whole line right by the indent, and text-indent pulls
// just the first line back by the same amount — so line 1 lands exactly where
// its own leading spaces already put it, but if it's too long to fit and wraps,
// the overflow (which isn't affected by text-indent) picks up at the padding
// edge instead of sliding back to column 0. 'ch' is exact here since the
// terminal is monospace throughout — 1ch is 1 character, same as a real space.
function printHanging(text, indentCh, cls){
  const div = document.createElement('div');
  div.className = 'line' + (cls ? ' '+cls : '');
  if(indentCh){ div.style.paddingLeft = indentCh + 'ch'; div.style.textIndent = '-' + indentCh + 'ch'; }
  div.textContent = text;
  const stick = isNearOutputBottom();
  outputEl.appendChild(div);
  if(stick) outputEl.scrollTop = outputEl.scrollHeight;
  trimOutput();
}
function printEcho(text){
  const div = document.createElement('div');
  div.className = 'line echo';
  div.textContent = text;
  const stick = isNearOutputBottom();
  outputEl.appendChild(div);
  if(stick) outputEl.scrollTop = outputEl.scrollHeight;
  trimOutput();
}

// how many characters fit across the output column right now. measured from a probe
// rather than derived from font-size: 1ch depends on the font that actually loaded,
// and the fallback has different metrics (see the @font-face note in momentum.css).
// memoized on the element's width so a 70-line help dump costs one layout instead of
// one per line — and it can't just be computed once at startup either, since both
// dividers resize this column live.
let outputColsCache = { width: -1, cols: 80 };
function outputColumns(){
  const width = outputEl.clientWidth;
  if(outputColsCache.width === width) return outputColsCache.cols;
  const probe = document.createElement('span');
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre;';
  probe.textContent = '0'.repeat(50);
  outputEl.appendChild(probe);
  const charWidth = probe.getBoundingClientRect().width / 50;
  probe.remove();
  const cs = getComputedStyle(outputEl);
  const inner = width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  // a console that's hidden or not yet laid out measures zero — 80 is a plain
  // terminal's width, and a safe thing to format for until it's actually measurable.
  const cols = (charWidth > 0 && inner > 0) ? Math.floor(inner / charWidth) : 80;
  outputColsCache = { width, cols };
  return cols;
}

function tokenize(str){
  const re = /"([^"]*)"|(\S+)/g;
  const out = [];
  let m;
  while((m = re.exec(str)) !== null){ out.push(m[1] !== undefined ? m[1] : m[2]); }
  return out;
}

function findTask(idStr){
  const id = parseInt(idStr, 10);
  return tasks.find(t => t.id === id);
}
// archive's counterpart — used by "restore" and "archive rm", which act on ids
// that have already left `tasks`.
function findArchived(idStr){
  const id = parseInt(idStr, 10);
  return archive.find(t => t.id === id);
}

// splits "3,5,6" -> ["3","5","6"], expands ranges like "1-4" -> ["1","2","3","4"],
// and "all" expands to every id in `source` (tasks by default; pass `archive` for
// restore/archive-rm, where "all" has to mean every archived task instead).
function splitIds(idsStr, source){
  const raw = (idsStr || '').trim();
  if(!raw) return [];
  const list = source || tasks;
  if(raw.toLowerCase() === 'all') return list.map(t => String(t.id));
  // the bound a range gets clamped to below — the highest id actually in play,
  // not the task *count*. those used to be the same number when ids were
  // recomputed from position on every render, but ids are now stable and only
  // reused once genuinely freed (see nextFreeId), so deleting a task without
  // adding a replacement leaves a gap: 7 tasks can easily carry ids up to 9.
  // clamping to list.length instead of this would silently drop real, currently-
  // listed ids off the top of a range — "rm 2-8" quietly becoming "rm 2-7" and
  // leaving id 8 behind, which is a worse bug than the one this guard exists to
  // prevent.
  const maxId = list.length ? Math.max(...list.map(t => t.id)) : 0;
  const out = [];
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
    const m = tok.match(/^(\d+)-(\d+)$/);
    if(m){
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if(a > b) [a, b] = [b, a];
      // clamped before the loop runs, not filtered after — an unbounded "rm
      // 1-9999999" would otherwise build a multi-million-entry array (and hang
      // the tab) before findTask ever gets a chance to say most of those ids
      // don't exist.
      b = Math.min(b, maxId);
      for(let i = a; i <= b; i++) out.push(String(i));
    } else {
      out.push(tok);
    }
  });
  // deduplicated, because every caller treats this as a set of tasks rather than a
  // list of mentions. "done 2,2,2,2" and overlapping ranges like "rm 1-3,2-4" name
  // the same task more than once, which used to cost twice: the confirmation prompt
  // counted "done 2,2,2,2" as four tasks, and the second pass over an id the first
  // pass had already archived printed a spurious "no task #2" right after saying it
  // was done. one entry per id makes both read correctly.
  return [...new Set(out)];
}

// the help screen is generated from this table rather than hand-spaced, because
// hand-spacing drifts: the descriptions had crept out to four different columns
// (55/56/57/58) as commands were added over time. one source of truth, padding
// computed, so a new command can't misalign the block.
// a row's `feat`, when set, ties it to a feature flag: the row disappears from
// help — and its command from Tab and did-you-mean — while that feature is off,
// so nothing is ever advertised that would only refuse. `usage` may be a function
// for the rows that *list* the optional flags, since which flags exist depends on
// which features are on; usageOf() below resolves either form.
const COMMANDS = [
  { usage: () => `add <task title>${addFlagsHint()}`, desc: 'add a new task  (quotes around the title are optional)',
    extra: () => [...(featureOn('due') ? ['-d takes today, tomorrow, friday, +3d, eom …  ("help dates" for the full list)'] : []), ...legacyFlagsNote()] },
  { usage: 'rename <id> "new title"', desc: 'fix a typo — one task at a time, no delete-and-retype' },
  { usage: 'edit <id>', desc: 'load a task\'s current title into the command line to tweak, enter to save',
    extra: ['(fills in "rename <id> ...", cursor inside the quotes — for a full retype, "rename" works directly)'] },
  { usage: 'start <id[,id...]|all>', desc: 'mark task(s) active' },
  { usage: 'stop <id[,id...]|all>', desc: 'put active task(s) back to pending' },
  { usage: 'done <id[,id...]|all>', desc: 'complete task(s) — moves them to the archive' },
  { usage: 'rm <id[,id...]|1-4|all>', desc: 'delete task(s)  (also: remove, delete)' },
  { usage: 'undo', desc: 'undo the last command that changed anything' },
  { usage: 'priority <id[,id...]|all> <high|med|low>', desc: 'change priority', feat: 'priority' },
  // lazy: DATE_HELP is declared further down, alongside the parser it describes,
  // and this array is built at load time — read eagerly it would be a dead-zone
  // error. the same function form the flag hints above already use.
  { usage: 'due <id[,id...]|all> <date|none>', desc: 'set or clear a due date', feat: 'due',
    extra: () => ['takes today, tomorrow, friday, +3d, eom, none …  ("help dates" for the full list)'] },
  { usage: 'est <id[,id...]|all> <time|none>', desc: 'set or clear how long you think it\'ll take', feat: 'est',
    extra: () => ['takes 45m, 2h, 1h30, 1.5h, 90 (bare = minutes), 2d (a day is 8h), none',
                  '("-dur", "-duration" and "-time" work as flag spellings too)']},
  { usage: 'tag <id[,id...]|all> add <tag>', desc: 'add a tag to task(s)', feat: 'tags' },
  { usage: 'tag <id[,id...]|all> rm <tag>', desc: 'remove a tag from task(s)', feat: 'tags' },
  { usage: 'tag <id[,id...]|all> set <tag1,tag2,...>', desc: "replace all of task(s)' tags", feat: 'tags' },
  { usage: 'tags', desc: 'list every tag in use', feat: 'tags' },
  { usage: 'mark <id[,id...]|all> [off]', desc: 'put the • mark in the margin  (bare form marks, "off" clears)', feat: 'tags',
    extra: ['a shorthand for the tag it writes, so "list +mark" still finds them  ("help marks" for the whole column)'] },
  { usage: 'project add <name>', desc: 'create a project', feat: 'projects' },
  { usage: 'project rm <name>', desc: 'delete a project', feat: 'projects' },
  { usage: 'project set <id[,id...]|all> <name|none>', desc: 'assign task(s) to a project', feat: 'projects' },
  { usage: 'project list', desc: 'list all projects (or: projects)', feat: 'projects' },
  { usage: () => `list [all|pending|active]${filterFlagsHint()}`, desc: 'show tasks as text, once (excludes archived)' },
  { usage: 'filter [<same arguments as list>|off]', desc: 'narrow the always-visible task pane and keep it that way',
    extra: ['bare "filter" says what\'s applied; "filter off" clears it'] },
  { usage: () => `archive${filterFlagsHint()}`, desc: 'show completed/archived tasks' },
  { usage: 'archive rm <id[,id...]|1-4|all>', desc: 'permanently delete archived task(s) — no coming back from this one' },
  { usage: 'restore <id[,id...]|1-4|all>', desc: 'move archived task(s) back to your list' },
  { usage: 'find <text>', desc: () => `search titles${featureOn('tags') ? ' + tags' : ''}, pending/active and archive together` },
  { usage: 'gallery', desc: 'your collection, as a contact sheet in the side panel' },
  { usage: 'gallery show <n|name>', desc: 'open one piece full-size — or just click its tile',
    extra: ['(the number is whatever "gallery" is showing on screen)'] },
  { usage: 'gallery display [<n|name>]', desc: 'fullscreen a collected piece — bare form uses whatever "gallery show" has open',
    extra: ['left/right arrow steps to the next/previous piece without leaving fullscreen'] },
  { usage: 'gallery close', desc: 'back to the live reveal' },
  { usage: 'gallery rm <n|name|n,n,...|n-m|all>', desc: 'remove piece(s) from your collection  (also: remove, delete)',
    extra: ['numbers are the same ones "gallery" shows on screen; "download" it first if you want to keep the file'] },
  { usage: 'mode [ascii|image]', desc: 'show or switch the reveal mode' },
  { usage: 'folders [<numbers>]', desc: 'list the image_art folders, or flip one in/out of the random pool',
    extra: ['(exclude <numbers> / include <numbers> force a direction instead)'] },
  { usage: 'view [art|tasks]', desc: 'which panel gets the right-hand column: the reward art, or your task list',
    extra: ['(the tasks view\'s column boundary is draggable too)'] },
  { usage: 'split [on|off]', desc: 'pin the *other* panel above the console — the task list in the art',
    extra: ['view, the reward art in the tasks view',
            '(drag the divider between them to resize)'] },
  { usage: 'set [<key>] [on|off|toggle]', desc: 'every on/off switch, display and feature alike',
    extra: ['bare "set" (or "help set") lists them all with their current state',
            '(title/statline/mirror still work as their own commands)'] },
  { usage: 'theme [amber|night|day|solar|nord]', desc: 'show or switch the color theme',
    extra: ['(also: switch, and the classic nightmode/daymode)'] },
  { usage: 'font [<number>|<name>]', desc: 'show the available fonts, or switch to one',
    extra: ['bare "font" lists them numbered — "font 3" picks the third',
            '(also: "switch font". add your own by dropping a .woff2 in fonts/',
            'and running "python3 build_font_data.py")'] },
  { usage: 'font next | font prev', desc: 'step to the next/previous font, wrapping at the ends',
    extra: ['for trying them on without looking the numbers up  (also: "next font")'] },
  { usage: 'font info', desc: 'what the current font is — name, style, size, where it came from' },
  { usage: () => `font size [<${FONT_SIZE_MIN}-${FONT_SIZE_MAX}>|+2|-2|reset]`, desc: 'how big the text is — everything scales together',
    extra: ['bare form says what it\'s set to now'] },
  { usage: 'art', desc: "info on the current piece (whichever mode you're in)",
    extra: ['(also: image — same command either way)'] },
  { usage: 'next', desc: 'skip to a new piece (no credit for it)  (also: skip)',
    extra: ['works on a just-completed piece too — discards it instead of close/download'] },
  { usage: 'reveal', desc: 'cheat: instantly finish revealing it' },
  { usage: 'hide', desc: 'cheat: re-mask it back to 0%' },
  { usage: 'block size [<tier>]', desc: 'show or set the image reveal block size',
    extra: ['tiers: very small, small, medium, big, very big, full',
            'redrawn at the new block size  (image mode only)'] },
  { usage: 'block count [<1-20>|auto]', desc: 'blocks uncovered per completed task  (image mode only)' },
  { usage: `character count [<1-${CHAR_COUNT_MAX}>|all|auto]`, desc: 'characters uncovered per completed task  (ascii mode only)',
    extra: ['"all" fully reveals the piece every completed task, whatever its size'] },
  { usage: 'close', desc: 'once complete: save it + start a new one  (also: save)' },
  { usage: 'download [<n|name>]', desc: 'once complete: save the file to your computer',
    extra: ['with a gallery number or name instead ("download 3"), downloads an already-collected piece'] },
  { usage: 'copy [<n|name>]', desc: 'copy an ascii piece\'s text to your clipboard  (ascii only)',
    extra: ['bare form copies whatever\'s in view — an open gallery piece, or the live piece once it\'s fully revealed',
            'with a gallery number or name instead ("copy 3"), copies an already-collected piece'] },
  { usage: 'display', desc: 'blow up the current piece — ascii or image, however',
    extra: ['much of it is revealed  (esc, enter, space or click to exit)',
            '(for a collected piece instead, see "gallery display")'] },
  { usage: 'fullscreen [on|off]', desc: 'put the whole app fullscreen, like F11  (esc to leave)' },
  { usage: 'stats', desc: 'task summary' },
  { usage: 'streak', desc: "current/longest completion streak + a heatmap", feat: 'streak' },
  { usage: 'export', desc: 'download a backup of all your tasks + progress' },
  { usage: 'import', desc: 'restore tasks + progress from a backup file' },
  { usage: 'recover [list|<n>]', desc: 'restore an automatic in-browser backup',
    extra: ['(a bonus safety net alongside export, not a replacement for it —',
            'it lives in this browser and is lost along with everything else',
            'if its site data ever gets cleared)'] },
  { usage: 'clear', desc: 'clear the terminal' },
  { usage: 'help [<group>|<command>|all]', desc: 'bare: the group menu. "help done" explains one command;',
    extra: ['"help all" prints every command at once'] },
];

// one-letter shortcuts for the commands typed most often. these are rewrites of
// what you typed, applied before anything else looks at the command name — so a
// shortcut can never drift into being a second implementation of the command.
// close gets 'x' rather than 'c' because 'clear' wanted 'c' first and is typed far
// more often; 'hide' has no letter — it's the rarest of the three reveal-cheats
// and 'h' reads as "help" on reflex, so it's safer left unassigned.
const SHORTCUTS = { a:'add', d:'done', l:'list', s:'split', g:'gallery', u:'undo', n:'next', r:'reveal', x:'close', f:'fullscreen', c:'clear' };
// longer spellings of the same commands, kept working out of habit/compatibility.
// they're not advertised as shortcuts; the command they resolve to says "also: ..."
// in its own help line.
// the estimate spellings are here for the same reason EST_FLAGS exists on the flag
// side: "duration" and "time" are what people reach for first, and the command
// should answer to them rather than send you to did-you-mean.
const SPELLINGS = { remove:'rm', delete:'rm', image:'art', switch:'theme', save:'close', skip:'next',
                    estimate:'est', duration:'est', dur:'est', time:'est' };
const ALIASES = { ...SHORTCUTS, ...SPELLINGS };
function resolveAlias(cmd){ return ALIASES[cmd] || cmd; }

// commands that still dispatch but no longer have a help row of their own,
// because they were folded into a broader one. they can't be plain ALIASES —
// "title on" has to become "set title on", which is an argument rewrite, not a
// word swap, so dispatch handles the call and this only points help at the row
// that now documents them. keeps "help title" useful instead of answering "no
// help for that" about a command that demonstrably works.
const HELP_ALIASES = { title:'set', statline:'set', mirror:'set', age:'set', exclude:'folders', include:'folders' };

// the dispatchable command word a help row documents: the first token of its
// usage, which is exactly what dispatch() switches on. "archive [-proj name]"
// and "archive rm <ids>" are both the "archive" command; the three "tag" rows
// and both "block" rows likewise collapse to one name each. derived rather than
// declared on every row, so a row can't drift out of sync with the command it
// documents.
function commandNameOf(usage){ return usage.split(' ')[0]; }
// the flag lists the "add" and "list"/"archive" usage rows advertise. built from
// whichever features are on rather than written out, so help can't offer a flag
// that parseFlags would turn around and reject.
function addFlagsHint(){
  return [
    featureOn('projects') ? ' [#project]'        : '',
    featureOn('tags')     ? ' [+tag ...]'        : '',
    featureOn('priority') ? ' [-p high|med|low]' : '',
    featureOn('due')      ? ' [-d <date>]'       : '',
    featureOn('est')      ? ' [-est <time>]'     : '',
  ].join('');
}
function filterFlagsHint(){
  return (featureOn('projects') ? ' [#project]' : '') + (featureOn('tags') ? ' [+tag]' : '');
}
// the older -proj/-t spellings still parse everywhere the marks do; this is the one
// line that says so, shown only while there's a feature left for them to act on.
function legacyFlagsNote(){
  const both = featureOn('projects') && featureOn('tags');
  if(!featureOn('projects') && !featureOn('tags')) return [];
  return [`(${featureOn('projects') ? '-proj name' : ''}${both ? ' and ' : ''}${featureOn('tags') ? '-t tag1,tag2' : ''} still work${both ? '' : 's'} too)`];
}
function usageOf(c){ return typeof c.usage === 'function' ? c.usage() : c.usage; }
// false only for a command word whose feature is switched off. commands with no
// feature attached (the great majority) are always allowed.
function featureAllows(cmd){
  const feat = FEATURE_OF_COMMAND[cmd];
  return !feat || featureOn(feat);
}
// every help/completion path reads this rather than COMMANDS directly, so a
// switched-off feature drops out of all of them at once. a function, not a const:
// the answer changes the moment "set tags off" runs.
function activeCommands(){ return COMMANDS.filter(c => !c.feat || featureOn(c.feat)); }
function commandNames(){ return [...new Set(activeCommands().map(c => commandNameOf(usageOf(c))))]; }
// which feature a dispatchable command word belongs to — the gate in dispatch()
// and the one thing that has to list the alias spellings too, since "projects"
// and "tags" reach the same features by a different word than their help row.
const FEATURE_OF_COMMAND = {
  priority: 'priority', due: 'due', est: 'est',
  tag: 'tags', tags: 'tags', mark: 'tags',   // mark writes a tag, so it lives or dies with them
  project: 'projects', projects: 'projects',
  streak: 'streak',
};

// ---------- help topics ----------
// help for something that isn't a command. the date vocabulary is shared by "-d"
// and "due" and belongs to neither, and it's too long to sit in a help row without
// turning that row into the wall the grouped help exists to avoid — so it gets its
// own page, listed in the bare "help" menu and pointed at from both rows.
// a topic can carry a `feat` like a command row does, so "help dates" stops being
// offered at all when due dates are switched off.
const HELP_TOPICS = {
  dates: {
    desc: 'what "-d" and "due" accept',
    feat: 'due',
    print(){
      print('dates — every form "-d" and "due" understand:');
      // both columns measured across every group, not per group, so the notes line
      // up in one straight column down the whole page instead of stepping in and
      // out as each section's longest entry changes.
      const all = DATE_FORMS.flatMap(([, rows]) => rows);
      const formW = Math.max(...all.map(([form]) => form.length));
      const altW = Math.max(...all.map(([, alt]) => alt.length));
      // the alt column collapses to nothing when no group uses it, rather than
      // leaving a fixed gap of blank space between form and note.
      const altGap = altW ? altW + 2 : 0;
      const indent = 2 + formW + 2 + altGap;
      // the same accommodation buildHelpRows makes for the command table: keep the
      // note beside its form only while the console is actually wide enough to give
      // it a readable column, and stack it underneath when it isn't — otherwise a
      // narrow console frays every note into a one-word-per-line ribbon.
      const sideBySide = outputColumns() - indent >= HELP_MIN_DESC;
      DATE_FORMS.forEach(([heading, rows]) => {
        print('');
        printSectionRule(heading);
        rows.forEach(([form, alt, note]) => {
          const left = `  ${form.padEnd(formW)}  ${altGap ? alt.padEnd(altW) + '  ' : ''}`;
          if(!note){ print(left.trimEnd()); return; }
          if(sideBySide) printSegments([{ text: left }, { text: note, cls: 'info' }], indent);
          else { print(left.trimEnd()); printHanging(`    ${note}`, 4, 'info'); }
        });
      });
      print('');
      // separated by blank lines rather than stacked: three consecutive wrapped
      // paragraphs read as one block of prose, which is the thing this page was
      // rewritten to stop doing.
      printHanging('  whichever you type, it lands on one calendar day — and that day is echoed back, so "due 3 friday" answers with the date itself.', 2, 'info');
      print('');
      printHanging('  two-word forms need quotes behind -d, which can\'t tell where the date ends and the title picks up again:  -d "2 days"', 2, 'info');
      printHanging('  after "due" they\'re fine as they are:  due 3 in 2 weeks', 2, 'info');
      print('');
      printHanging('  the list reads them back the same way — "tomorrow", "in 3 days" — until they\'re over a week out, where it shows the date instead.', 2, 'info');
    },
  },
  // deliberately its own page rather than a note under "tag": these tag names do
  // something the others don't, and a special meaning nobody can discover is the
  // same as no meaning at all.
  marks: {
    desc: 'the symbols in the margin, and what earns one',
    print(){
      // marks read out of SPECIAL_TAGS rather than typed again here, so the page
      // can't end up advertising a symbol the list doesn't actually draw.
      const symbolOf = name => (SPECIAL_TAGS.find(e => e[0] === name) || [])[1];
      const rows = [
        [symbolOf('very urgent'), 'very urgent',            'tag 3 add "very urgent"'],
        [symbolOf('urgent'),      'urgent',                 '+urgent'],
        [ACTIVE_MARK,             "started — you're on it", 'start 3'],
        [symbolOf('next'),        'next up',                '+next'],
        [symbolOf('important'),   'important / focus',      '+important'],
        [symbolOf(MARK_TAG),      'marked — a plain flag',  'mark 3      ("mark 3 off" clears)'],
      ];
      print('marks — the column just left of each [id]:');
      print('');
      printSectionRule('what puts one there');
      const markW = Math.max(...rows.map(([m]) => m.length));
      const whatW = Math.max(...rows.map(([, w]) => w.length));
      rows.forEach(([mark, what, how]) => {
        printSegments([
          { text: `  ${mark.padStart(markW)}   ${what.padEnd(whatW)}   ` },
          { text: how, cls: 'info' },
        ], markW + whatW + 8);
      });
      print('');
      printHanging('  all but the started one are ordinary tags underneath — "mark 3" just writes the "marked" one for you — so they filter and clear like any other tag ("list +marked", "tag 3 rm urgent").', 2, 'info');
      print('');
      printHanging('  a task shows one mark, never two: the order above is the order they win in, so something both urgent and marked reads as urgent.', 2, 'info');
      print('');
      printHanging('  spelling is forgiving — "very urgent", "very-urgent" and "Very_Urgent" all count. only the spaced form needs the "tag" command, since "+very urgent" would split into two tags.', 2, 'info');
    },
  },
};
function activeTopics(){
  return Object.keys(HELP_TOPICS).filter(k => !HELP_TOPICS[k].feat || featureOn(HELP_TOPICS[k].feat));
}

// ---------- help groups ----------
// the full command list is ~70 printed lines, which is a wall you have to read
// end-to-end to find one thing. grouping lets bare "help" be a five-line menu
// and pushes the detail behind "help <group>". membership is keyed by command
// *name*, so every row of a multi-row command travels together automatically.
// the two big groups are split again into labelled sections, for the same reason
// the groups exist at all: "help tasks" was nineteen commands in one undivided
// column, mixing making a task, finishing one, tagging one and finding one — four
// different jobs you'd never be doing at the same moment. the small groups keep a
// single unlabelled section ('') because three or five rows have nothing to
// navigate; a heading over them would be scaffolding around nothing.
//
// sections are also where membership is now *declared* — `members` is derived from
// them below, so a command can't be listed in a group and missing from its
// sections (which would silently drop it off the page it belongs to).
const HELP_GROUPS = [
  { name:'tasks',  desc:'add, edit, finish and find tasks', sections:[
    ['making and changing them', ['add','rename','edit']],
    ['getting them done',        ['start','stop','done','rm','undo']],
    ['details you can put on them', ['priority','due','est','tag','tags','mark','project']],
    ['finding and reviewing',    ['list','filter','archive','restore','find']],
  ]},
  { name:'art',    desc:'the reward art — modes, reveal pace, gallery', sections:[
    ['the piece in progress', ['art','next','reveal','hide']],
    ['how fast it uncovers',  ['block','character']],
    ['once it\'s finished',   ['close','download','copy','display']],
    ['your collection',       ['gallery']],
    ['which pieces come up',  ['mode','folders']],
  ]},
  { name:'layout', desc:'panels, themes, and what shows on screen', sections:[
    ['', ['view','split','set','theme','font','fullscreen']],
  ]},
  { name:'data',   desc:'backups, and restoring from them', sections:[
    ['', ['export','import','recover']],
  ]},
  { name:'other',  desc:'stats, streak, and the rest', sections:[
    ['', ['stats','streak','clear','help']],
  ]},
];
HELP_GROUPS.forEach(g => { g.members = g.sections.flatMap(([, names]) => names); });
// anything not explicitly placed lands in "other" rather than vanishing from
// help entirely — a new command with no group is still findable.
function commandsInGroup(groupName){
  const group = HELP_GROUPS.find(g => g.name === groupName);
  if(!group) return [];
  const placed = new Set(HELP_GROUPS.flatMap(g => g.members));
  return activeCommands().filter(c => {
    const name = commandNameOf(usageOf(c));
    return group.members.includes(name) || (groupName === 'other' && !placed.has(name));
  });
}

// usages longer than this get their description on the next line instead of
// pushing every other description off to the right.
const HELP_MAX_USAGE = 46;
// the width a description needs before it's worth setting beside its usage instead
// of under it. narrower than this and the words break up into a one-per-line ribbon
// — which is exactly what the whole help screen used to collapse into whenever the
// console column was small, because the layout was computed purely from the widest
// usage in the table and never asked how much room the console actually had.
const HELP_MIN_DESC = 26;

// each row remembers where its description text starts (in characters) via
// `indent`, so cmd_help() can give a row that's too wide for the terminal a
// hanging indent when it soft-wraps — the overflow lines up under the
// description, not back under the left edge. indent 0 means there's nothing to
// hang (plain prose or a blank line). the usage column is measured from the
// subset being printed, so a single group's block is as tight as it can be
// rather than padded out to the widest usage in the whole app.
// where the description column starts for a given set of rows. split out so a
// group page can measure once across all of its sections and hand the same number
// to each — measured per section instead, every section would find its own widest
// usage and the descriptions would step in and out down the page.
function helpUsageColumn(list){
  const fitting = list.map(c => usageOf(c).length).filter(n => n <= HELP_MAX_USAGE);
  // capped to what this console can actually show. the description column is only
  // worth having if real width is left over for the description; when it isn't, col
  // shrinks, and more rows fall through the "usage too long" branch in
  // buildHelpRows and stack instead — the layout that does fit. both branches
  // indent by col, so this one cap fixes the stacked rows as well. at a comfortable
  // width nothing changes.
  const room = Math.max(0, outputColumns() - HELP_MIN_DESC);
  return Math.min((fitting.length ? Math.max(...fitting) : 0) + 2, room);
}
// skipExtra drops each command's follow-up detail lines, keeping one row per
// command. that's what a group page wants: an index you can take in at a glance,
// where the extras roughly doubled its length ("help tasks" ran ~50 lines for 19
// commands) and turned a menu into a manual. nothing is lost — "help <command>"
// prints the same row *with* its extras, and "help all" keeps them throughout.
function buildHelpRows(list, colOverride, skipExtra){
  // resolve the dynamic rows once, before anything measures them: usage and desc
  // may both be functions of the current feature flags (see the COMMANDS comment).
  const col = colOverride != null ? colOverride : helpUsageColumn(list);
  list = list.map(c => ({
    ...c,
    usage: usageOf(c),
    desc: typeof c.desc === 'function' ? c.desc() : c.desc,
    extra: typeof c.extra === 'function' ? c.extra() : c.extra,
  }));
  const lead = '  ';
  const indent = col + 2;   // the margin + the usage column — where desc/extra text actually starts
  const rows = [];
  list.forEach(c => {
    if(c.usage.length > col - 2){
      rows.push({ text: lead + c.usage, indent: 0 });
      rows.push({ text: lead + ' '.repeat(col) + c.desc, indent });
    } else {
      rows.push({ text: lead + c.usage.padEnd(col) + c.desc, indent });
    }
    if(!skipExtra) (c.extra || []).forEach(e => rows.push({ text: lead + ' '.repeat(col) + e, indent }));
  });
  return rows;
}
function printHelpRows(rows){
  rows.forEach(r => r.indent ? printHanging(r.text, r.indent) : print(r.text));
}
// a section divider: the label at full strength, then a dashed rule running out to
// the right margin behind it, dim. the "- " vocabulary is the one printFramed
// already draws task lists with, so a help page reads as the same app rather than
// as a document that wandered in — and putting the label *on* the rule costs no
// extra line, where a rule above or below the heading would have cost one per
// section (eight of them on "help tasks" alone, which is the opposite of calmer).
//
// the 'rule' class clips instead of wrapping, the same guard printFramed's rules
// use: outputColumns() is measured, not guessed, but a rule that overshoots by one
// character and folds onto a second line stops reading as a border and starts
// reading as content.
function printSectionRule(label){
  const tail = Math.max(0, outputColumns() - label.length - 3);
  const dashes = '- '.repeat(Math.ceil(tail / 2)).slice(0, tail).trimEnd();
  printSegments([{ text: label + '  ' }, { text: dashes, cls: 'info' }], 0, 'rule');
}
// printed from the same map dispatch uses, so the advertised shortcuts are
// exactly the ones that work.
function printShortcutsRow(labelled){
  const pairs = Object.entries(SHORTCUTS).map(([k,v]) => `${k} = ${v}`).join('   ');
  // labelled where it stands on its own (help all), bare where a section rule
  // directly above it already carries the word.
  printHanging(labelled ? `  shortcuts:  ${pairs}` : `  ${pairs}`, 2);
}

function cmd_help(arg){
  const raw = (arg || '').toLowerCase();

  // bare "help": a menu, not the manual.
  if(!raw){
    print('momentum — commands are grouped; open one with "help <group>".');
    print('');
    printSectionRule('the groups');
    HELP_GROUPS.forEach(g => {
      // topics are reference material, not a command group — "other" is the
      // catch-all group and reads as the natural end of the specific-groups list,
      // so topics print immediately above it rather than tacked on after "all".
      if(g.name === 'other') activeTopics().forEach(t => printHanging(`  help ${t.padEnd(8)}${HELP_TOPICS[t].desc}`, 14));
      const n = commandsInGroup(g.name).length;
      printHanging(`  help ${g.name.padEnd(8)}${g.desc}  (${n} line${n === 1 ? '' : 's'})`, 14);
    });
    printHanging('  help all     every command at once, the long way', 14);
    print('');
    printSectionRule('typing them');
    print('  "help <command>" explains just that one, e.g. help done', 'info');
    print('  Tab completes command names and their options; press it again to cycle,', 'info');
    print('  or use the arrow keys to move through the choices it lists.', 'info');
    print('');
    printSectionRule('one-letter shortcuts');
    printShortcutsRow(false);
    return;
  }

  if(raw === 'all'){
    print('commands:');
    printHanging('  (most commands below accept multiple ids: done 3,5,6  |  ranges: rm 1-4  |  or: rm all)', 2);
    // the exhaustive view keeps every extra line — that's what "the long way" means
    // on the menu — but it's still walked group by group under the same rules the
    // group pages use, so scrolling it lands somewhere recognisable instead of in
    // the middle of one undivided seventy-line column.
    const active = activeCommands();
    const col = helpUsageColumn(active);
    HELP_GROUPS.forEach(g => {
      const items = commandsInGroup(g.name);
      if(!items.length) return;
      print('');
      printSectionRule(g.name);
      printHelpRows(buildHelpRows(items, col));
    });
    print('');
    printSectionRule('one-letter shortcuts');
    printShortcutsRow(false);
    return;
  }

  if(activeTopics().includes(raw)){ HELP_TOPICS[raw].print(); return; }

  if(HELP_GROUPS.some(g => g.name === raw)){
    const group = HELP_GROUPS.find(g => g.name === raw);
    print(`${raw} — ${group.desc}:`);
    const all = commandsInGroup(raw);
    // one measurement for the whole page, handed to every section, so the
    // descriptions hold a single straight column instead of stepping in and out
    // as each section's widest usage changes.
    const col = helpUsageColumn(all);
    const nameOf = c => commandNameOf(usageOf(c));
    group.sections.forEach(([label, names]) => {
      const items = all.filter(c => names.includes(nameOf(c)));
      // a section can empty out entirely when its feature is switched off (all of
      // "details you can put on them" disappears with priority/due/tags/projects
      // off) — printing its heading over nothing would be worse than dropping it.
      if(!items.length) return;
      print('');
      // the divider sits at column 0 and the rows at 2 — the man-page arrangement.
      // indenting the rows under the heading instead would read the same, but it
      // costs two columns off a console that's already only half the window wide,
      // and those two were enough to push several usages over the width where
      // their description stops fitting beside them.
      if(label) printSectionRule(label);
      printHelpRows(buildHelpRows(items, col, true));
    });
    // "other" collects commands no group claimed, which by definition no section
    // lists either — they'd vanish off their own page without this.
    const claimed = new Set(group.members);
    const rest = all.filter(c => !claimed.has(nameOf(c)));
    if(rest.length){
      print('');
      printHelpRows(buildHelpRows(rest, col, true));
    }
    print('');
    printHanging(`  "help <command>" spells any one of these out in full — try "help ${nameOf(all[0])}".`, 2, 'info');
    return;
  }

  // a single command — aliases resolve first, so "help l" and "help d" explain
  // the real command rather than reporting that the letter is unknown, and the
  // folded-away commands ("help title") land on the row that now covers them.
  const name = HELP_ALIASES[raw] || resolveAlias(raw);
  const rows = activeCommands().filter(c => commandNameOf(usageOf(c)) === name);
  if(rows.length){
    printHelpRows(buildHelpRows(rows));
    const alias = [...Object.entries(ALIASES), ...Object.entries(HELP_ALIASES)]
      .filter(([k,v]) => v === name).map(([k]) => k);
    if(alias.length) print(`  also: ${alias.join(', ')}`, 'info');
    print(`  group: ${groupOfCommand(name)}  ("help ${groupOfCommand(name)}" for its neighbours)`, 'info');
    // "set" is the one command whose useful detail is a list of what it can act on
    // and where each of those currently stands — which the help table can't render
    // (fixed two columns) and would go stale in anyway. so "help set" hands over to
    // the same overview bare "set" prints, live state and all. last, after the row's
    // own also/group footer, so that footer stays attached to the row it describes.
    if(name === 'set') printSettingsOverview();
    return;
  }

  const guess = suggestCommand(raw);
  print(`no help for "${raw}"${guess ? ` — did you mean "${guess}"?` : ''}`, 'err');
  print(`  groups: ${HELP_GROUPS.map(g => g.name).join(', ')}, all`, 'info');
  if(activeTopics().length) print(`  topics: ${activeTopics().join(', ')}`, 'info');
}
function groupOfCommand(name){
  const g = HELP_GROUPS.find(g => g.members.includes(name));
  return g ? g.name : 'other';
}

// ---------- did you mean ----------
// plain Levenshtein over a two-row buffer — the candidate set is a few dozen
// short words, so there's nothing to optimize past that.
function editDistance(a, b){
  if(a === b) return 0;
  let prev = Array.from({length: b.length + 1}, (_, i) => i);
  for(let i = 1; i <= a.length; i++){
    const cur = [i];
    for(let j = 1; j <= b.length; j++){
      cur[j] = Math.min(
        prev[j] + 1,                                        // deletion
        cur[j-1] + 1,                                       // insertion
        prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1)             // substitution
      );
    }
    prev = cur;
  }
  return prev[b.length];
}
// single-letter shortcuts are excluded as candidates: every 1-char typo would
// "match" one of them at distance 1, which is noise rather than a suggestion.
// the tolerance scales with length so short words don't get wild guesses —
// "lst" -> "list" is worth offering, "abc" -> "add" is not.
function suggestable(){
  const off = new Set(Object.entries(FEATURE_OF_COMMAND).filter(([, f]) => !featureOn(f)).map(([w]) => w));
  return [...new Set([...commandNames(), 'projects', ...Object.keys(SPELLINGS), ...Object.keys(HELP_ALIASES)])]
    .filter(n => n.length > 1 && !off.has(n));
}
function suggestCommand(cmd){
  let best = null, bestDist = Infinity;
  suggestable().forEach(name => {
    const d = editDistance(cmd, name);
    if(d < bestDist){ bestDist = d; best = name; }
  });
  return bestDist <= (cmd.length <= 4 ? 1 : 2) ? best : null;
}

// ---------- tab completion ----------
// what each command offers for the argument you're currently typing. the
// function gets (position, earlier args) so a subcommand can steer what comes
// next — "block size <Tab>" offers tiers, "block count <Tab>" offers auto.
// values are the same literals the commands themselves parse, so anything
// completed here is guaranteed to be accepted.
const BLOCK_SIZE_NAMES = ['very small', 'small', 'medium', 'big', 'very big', 'full'];
// the multi-letter spellings that still dispatch but no longer head a help row —
// completable, but only once nothing canonical matches (see computeCompletion).
const LEGACY_COMMAND_NAMES = [...new Set([...Object.keys(SPELLINGS), ...Object.keys(HELP_ALIASES), 'projects'])];
const ON_OFF = () => ['on', 'off'];
const ARG_COMPLETIONS = {
  theme:      () => THEMES,
  // names rather than numbers: a number is only meaningful next to the printed
  // list, and Tab is what you reach for when you haven't printed it.
  font:       (pos, args) => pos === 0
    ? ['next', 'prev', 'info', 'size', ...selectableFonts().map(f => f.name)]
    : (String(args[0] || '').toLowerCase() === 'size' ? ['reset', '+2', '-2'] : []),
  set:        pos => pos === 0 ? [...Object.keys(SETTINGS), ...Object.keys(FEATURES)] : SETTING_VALUES,
  mode:       () => ['ascii', 'image'],
  // pos 0 is the id, which completion has nothing useful to say about; the value
  // slot after it gets the same ladder the "-est" flag offers.
  est:        pos => pos === 0 ? [] : EST_VALUE_WORDS,
  view:       () => VIEW_MODES,
  split:      ON_OFF,
  fullscreen: ON_OFF,
  // folded into "set", but still typed out of habit — completing them keeps the
  // old spellings first-class rather than quietly second-rate.
  mirror:     ON_OFF,
  title:      ON_OFF,
  statline:   ON_OFF,
  list:       () => ['all', 'pending', 'active'],
  filter:     () => ['all', 'pending', 'active', 'off'],
  done:       () => ['all'],
  start:      () => ['all'],
  stop:       () => ['all'],
  rm:         () => ['all'],
  restore:    () => ['all'],
  archive:    pos => pos === 0 ? ['rm'] : ['all'],
  gallery:    pos => pos === 0 ? ['list', 'show', 'display', 'close', 'rm'] : [],
  project:    pos => pos === 0 ? ['add', 'rm', 'list', 'set'] : [],
  recover:    pos => pos === 0 ? ['list'] : [],
  tag:        pos => pos === 1 ? ['add', 'rm', 'set'] : [],
  mark:       pos => pos === 0 ? ['all'] : ['off'],
  block:      (pos, prior) => pos === 0 ? ['size', 'count']
                : prior[0] === 'size'  ? BLOCK_SIZE_NAMES
                : prior[0] === 'count' ? ['auto']
                : [],
  character:  (pos, prior) => pos === 0 ? ['count']
                : prior[0] === 'count' ? ['all', 'auto']
                : [],
  help:       pos => pos === 0 ? [...HELP_GROUPS.map(g => g.name), 'all', ...activeTopics(), ...commandNames()] : [],
  due:        pos => pos === 0 ? ['all'] : [...DATE_WORDS, ymd(startOfToday()), 'none'],
};

// completion for the token *after* a flag, which the position-keyed table above
// can't express: what "-p <Tab>" should offer has nothing to do with how many
// arguments came before it. this is also the only completion "add" has ever had —
// it isn't in ARG_COMPLETIONS at all, because none of its arguments are positional.
// today's date is offered alongside the words so the format is visible at a glance,
// which is the one genuinely useful half of "just type the date in for me".
const FLAG_COMPLETIONS = {
  '-d':    () => [...DATE_WORDS, ymd(startOfToday())],
  '-p':    () => ['high', 'med', 'low'],
  '-t':    () => allTagsInUse(),
  '-proj': () => projects,
  // a fixed ladder rather than estimates already in use: unlike tags and projects,
  // what you typed before isn't a candidate set worth completing against — these
  // are just the round numbers, offered so the accepted spellings are visible.
  // lazy like the rest, which is also what lets it reach a const declared further
  // down beside the parser that defines the vocabulary.
  '-est':  () => EST_VALUE_WORDS,
};
// every tag currently on a task — the useful candidate set for "+<Tab>" and "-t",
// since a tag you've never used isn't something completion can know about.
function allTagsInUse(){
  return [...new Set([...tasks, ...archive].flatMap(t => t.tags || []))].sort();
}

// splits on plain whitespace rather than reusing tokenize(): completion only
// ever targets command names and short keyword arguments, never a quoted task
// title, and a quote-aware split would make the "where does the token I'm
// typing start" arithmetic below much harder for no gain.
function computeCompletion(value){
  const start = (value === '' || /\s$/.test(value)) ? value.length : value.lastIndexOf(' ') + 1;
  const prefix = value.slice(start).toLowerCase();
  const before = value.slice(0, start).trim();
  const prior = before ? before.split(/\s+/) : [];
  let pool;
  // the #project / +tag marks complete against what you've actually used, at any
  // position — they're not tied to an argument slot the way the table's entries are.
  // candidates carry the mark so they match the prefix already typed.
  if(prior.length > 0 && (prefix.startsWith('#') || prefix.startsWith('+'))){
    const mark = prefix[0];
    const source = mark === '#' ? projects : allTagsInUse();
    pool = featureOn(FLAG_FEATURE[mark]) ? source.map(v => mark + v) : [];
  }
  else if(prior.length > 0 && FLAG_COMPLETIONS[prior[prior.length - 1].toLowerCase()]){
    const flag = prior[prior.length - 1].toLowerCase();
    pool = featureOn(FLAG_FEATURE[flag]) ? FLAG_COMPLETIONS[flag]() : [];
  }
  else if(prior.length === 0){
    // canonical names first, so Tab teaches the vocabulary the app actually
    // documents. the still-working older spellings ("switch", "title", "exclude"
    // …) are a fallback tier rather than part of that list: they only surface when
    // nothing canonical matches, which keeps them typeable from muscle memory
    // without padding out every ordinary completion with retired synonyms.
    pool = commandNames().filter(c => c.toLowerCase().startsWith(prefix));
    if(pool.length === 0) pool = LEGACY_COMMAND_NAMES.filter(c => featureAllows(c));
  } else {
    const head = resolveAlias(prior[0].toLowerCase());
    // a switched-off command completes to nothing rather than to its subcommands:
    // it's still typeable (dispatch explains itself), but Tab shouldn't help you
    // build out an argument list for something that's only going to refuse.
    const fn = featureAllows(head) ? ARG_COMPLETIONS[head] : null;
    pool = fn ? fn(prior.length - 1, prior.slice(1)) : [];
  }
  return { base: value.slice(0, start), candidates: pool.filter(c => c.toLowerCase().startsWith(prefix)) };
}

// ---------- dates ----------
// due dates are stored as plain "YYYY-MM-DD" local calendar days — no times, no
// zones, because "due Friday" means the day, not an instant. everything here works
// in local time for the same reason: toISOString() would render a late-evening
// "today" as tomorrow's date for anyone east of UTC, which is exactly the kind of
// off-by-one nobody thinks to test.
function ymd(d){
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function startOfToday(){ const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
const WEEKDAYS = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
// the words Tab offers and the parser accepts, kept as one list so they can't drift.
const DATE_WORDS = ['today', 'tomorrow', 'yesterday', ...WEEKDAYS, 'eow', 'eom', 'eoy'];

// "-d friday" / "due 3 +2w" / "due 3 none" — one parser, shared by add and due, so
// the two can't end up accepting different vocabularies. returns exactly one of
// { date }, { clear } or { error }.
function parseDue(raw){
  const s = (raw || '').trim().toLowerCase();
  if(!s) return { error: 'no date given' };
  if(s === 'none' || s === 'clear') return { clear: true };

  // a real calendar date, not just the right shape: the old check was a regex on
  // digits alone, which happily accepted 2026-02-31 and 2026-13-01 and stored them.
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(iso){
    const [, y, m, d] = iso.map(Number);
    const probe = new Date(y, m - 1, d);
    const real = probe.getFullYear() === y && probe.getMonth() === m - 1 && probe.getDate() === d;
    return real ? { date: s } : { error: `there's no such date as ${s}` };
  }

  const base = startOfToday();
  if(s === 'today') return { date: ymd(base) };
  if(s === 'tomorrow'){ base.setDate(base.getDate() + 1); return { date: ymd(base) }; }
  if(s === 'yesterday'){ base.setDate(base.getDate() - 1); return { date: ymd(base) }; }

  // "friday" is the next one, counting today — so asking for "friday" *on* a Friday
  // means today, which is what someone typing it on a Friday afternoon means.
  const dayIdx = WEEKDAYS.findIndex(w => w === s || w.slice(0, 3) === s);
  if(dayIdx !== -1){
    base.setDate(base.getDate() + ((dayIdx - base.getDay() + 7) % 7));
    return { date: ymd(base) };
  }

  if(s === 'eow'){ base.setDate(base.getDate() + ((7 - base.getDay()) % 7)); return { date: ymd(base) }; }   // sunday
  if(s === 'eom'){ return { date: ymd(new Date(base.getFullYear(), base.getMonth() + 1, 0)) }; }             // day 0 of next month = last of this
  if(s === 'eoy'){ return { date: ymd(new Date(base.getFullYear(), 11, 31)) }; }

  // "+3d" / "+2w" / "+1m". months land on the same day number, and JS rolls a short
  // month over on its own (Jan 31 + 1m = Mar 3), which is the usual convention.
  // the "+" is optional, so "3d" works too — it can only match digits followed by
  // one of d/w/m/y, which no other date form here looks like.
  const rel = s.match(/^\+?(\d+)\s*([dwmy])$/);
  if(rel){
    const n = Number(rel[1]);
    if(rel[2] === 'd') base.setDate(base.getDate() + n);
    if(rel[2] === 'w') base.setDate(base.getDate() + n * 7);
    if(rel[2] === 'm') base.setMonth(base.getMonth() + n);
    if(rel[2] === 'y') base.setFullYear(base.getFullYear() + n);
    return { date: ymd(base) };
  }

  // the same arithmetic spelled the way people say it out loud: "2 days",
  // "in 3 weeks", "1 month". singular and plural both, since "1 days" is what you
  // get from typing fast and refusing it teaches nothing.
  const spelled = s.match(/^(?:in\s+)?(\d+)\s*(day|week|month|year)s?$/);
  if(spelled){
    const n = Number(spelled[1]), unit = spelled[2];
    if(unit === 'day') base.setDate(base.getDate() + n);
    if(unit === 'week') base.setDate(base.getDate() + n * 7);
    if(unit === 'month') base.setMonth(base.getMonth() + n);
    if(unit === 'year') base.setFullYear(base.getFullYear() + n);
    return { date: ymd(base) };
  }

  // "next week" as seven days out, not "the monday after this one" — the reading
  // that matches "+1w" and the one a task list actually wants, since the point is
  // when it's due rather than which week it falls in. "next <weekday>" is left
  // out on purpose: english genuinely disagrees about whether that means the
  // coming friday or the one after, and a due date is the wrong place to guess.
  // "friday" already covers the unambiguous half of that.
  const nextUnit = s.match(/^next\s+(week|month|year)$/);
  if(nextUnit){
    if(nextUnit[1] === 'week') base.setDate(base.getDate() + 7);
    if(nextUnit[1] === 'month') base.setMonth(base.getMonth() + 1);
    if(nextUnit[1] === 'year') base.setFullYear(base.getFullYear() + 1);
    return { date: ymd(base) };
  }

  return { error: `"${raw}" isn't a date i understand` };
}
// how many calendar days from today a stored "YYYY-MM-DD" is — negative for past.
// rounded, not floored: DST makes a day 23 or 25 hours twice a year, and a floored
// difference silently slips by one across those boundaries.
function daysUntil(dateStr){
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if(!m) return null;
  const [, y, mo, d] = m.map(Number);
  const target = new Date(y, mo - 1, d);
  target.setHours(0, 0, 0, 0);
  return Math.round((target - startOfToday()) / 86400000);
}
// a due date as a person would say it, for the "[due:...]" field. the reverse of
// parseDue: that turns "tomorrow" into a date to store, this turns the stored date
// back into "tomorrow" to read.
//
// only inside a week either way, though — past that it falls back to the calendar
// date, because the relative form stops being the more useful one. "in 3 days" is
// exactly what you want to know about something due this week; "in 412 days" tells
// you nothing you'd act on, where "2027-10-01" at least says which month. the same
// cutoff in reverse keeps an overdue task saying how late it is ("5 days ago"),
// which is the thing worth knowing about it, until that stops being actionable too.
const DUE_RELATIVE_DAYS = 7;
function dueText(dateStr){
  const n = daysUntil(dateStr);
  if(n === null) return dateStr;
  if(n === 0) return 'today';
  if(n === 1) return 'tomorrow';
  if(n === -1) return 'yesterday';
  if(n > 1 && n <= DUE_RELATIVE_DAYS) return `in ${n} days`;
  if(n < -1 && n >= -DUE_RELATIVE_DAYS) return `${-n} days ago`;
  return dateStr;
}

// the accepted spellings, written out for humans. kept right here next to the
// parser so the two get edited together — a date form the parser learns and the
// help never mentions is a form nobody uses.
// DATE_HELP is the terse one-liner errors print; DATE_FORMS is the table "help
// dates" lays out. same vocabulary, two lengths, because an error should stay on
// one line and a reference shouldn't have to.
const DATE_HELP = 'try: 2026-01-31 · today · tomorrow · a weekday (friday, fri) · "2 days", "in 3 weeks" · next week · eow/eom/eoy · +3d, +2w, +1m';

// the weekday rows, built from the parser's own WEEKDAYS rather than typed out
// again — the abbreviation column is literally the same slice(0,3) the parser
// matches on, so the two can't drift into disagreeing about what "wed" means.
// re-ordered to start on monday: "eow" resolves to sunday, which only makes sense
// on a week that starts monday, so the table should read the same way.
const WEEKDAY_ROWS = [...WEEKDAYS.slice(1), WEEKDAYS[0]].map(day => [
  day, day.slice(0, 3),
  // the one row that needs a note gets it, sitting on the example it explains
  // rather than in a paragraph underneath where you'd have to connect it yourself.
  day === 'friday' ? 'on a friday, that means today' : '',
]);

// grouped, because a flat list of twelve forms mixing calendar dates, bare words,
// weekday names and arithmetic gives you nothing to navigate by — you read all of
// it to find any of it. each row is also exactly one form now: the old table put
// two unrelated examples in a single cell ("2 days   in 3 weeks"), which ran
// together into one phrase that read like a single nonsense date.
// shape: [heading, [[form, alt, note], ...]] — alt is a second spelling of the
// same form (a weekday's abbreviation), blank where there isn't one.
const DATE_FORMS = [
  ['a day, written out', [
    ['2026-01-31', '', 'year-month-day'],
  ]],
  ['the ones with names', [
    ['today', '', ''],
    ['tomorrow', '', ''],
    ['yesterday', '', ''],
  ]],
  ['a weekday — the next one, counting today', WEEKDAY_ROWS],
  ['counting forward from today', [
    ['2 days', '', 'also 3 weeks, 1 month, 2 years'],
    ['in 2 days', '', 'the same, with "in" in front'],
    ['next week', '', '7 days out (also next month, next year)'],
    ['+3d', '', 'terse: +2w +1m +1y  (the + is optional)'],
  ]],
  ['the end of a period', [
    ['eow', '', 'end of week (sunday)'],
    ['eom', '', 'end of month'],
    ['eoy', '', 'end of year'],
  ]],
  ['clearing it again', [
    ['none', '', 'removes the due date  ("due" only)'],
  ]],
];

// ---------- estimated time ----------
// how long you think a task will take, which is a different question from when it's
// due and answered separately: "due friday" and "about two hours" constrain a day's
// plan in different directions, and a list that knows both can total the second
// against the first.
//
// deliberately an *estimate*, not a duration: nothing in the app ever times a task,
// so a field called "duration" would promise a measurement it never takes. "-dur",
// "-duration" and "-time" all still parse (see EST_FLAGS) — they're the words that
// come to hand first — but "-est" is the one the help advertises, because it's the
// one that's honest about what the number is.
//
// stored as whole minutes, on purpose: one integer with no unit attached is the
// only shape that sums cleanly for the list total, sorts without a comparator, and
// can't drift into "is this 2 hours or 2 days?" the way a stored string could.
const MINUTES_PER_HOUR = 60;
// a "day" of estimated work is a working day, not 24 hours — nobody estimating a
// task means "two calendar days of wall clock" by "2d". spelled out here rather
// than left implicit because it's the one unit with a convention behind it, and
// every echo resolves it to hours (see cmd_est) so the stored number is never a
// guess about which reading was meant.
const MINUTES_PER_WORKDAY = 8 * MINUTES_PER_HOUR;
// a week of estimates is bounded by the same reasoning the ids are: an estimate
// this large has stopped being an estimate and is almost always a typo — "2h" typed
// as "2000h" — and storing it would poison every total the list prints from then on.
const EST_MAX = 5 * MINUTES_PER_WORKDAY * 4;   // ~4 working weeks

// "-est 90m" / "est 3 1h30" / "est 3 none" — one parser, shared by add and est, the
// same way parseDue is shared by add and due, so the two entry points can't end up
// accepting different vocabularies. returns exactly one of { minutes }, { clear }
// or { error }.
function parseEstimate(raw){
  const s = (raw || '').trim().toLowerCase();
  if(!s) return { error: 'no time given' };
  if(s === 'none' || s === 'clear' || s === '0') return { clear: true };

  // the compound form first — "1h30" / "2h15m" / "1h 30m". checked before the plain
  // single-unit forms below because "1h30" would otherwise match the hours pattern
  // on its "1h" and quietly discard the 30, which is the one failure mode here that
  // loses information instead of reporting it.
  const compound = s.match(/^(\d+)\s*h(?:ours?|rs?)?\s*(\d+)\s*(?:m(?:in(?:ute)?s?)?)?$/);
  if(compound){
    const mins = Number(compound[2]);
    if(mins >= MINUTES_PER_HOUR) return { error: `"${raw}" has ${mins} minutes in it — past 59, write it as hours (${Math.floor(mins / MINUTES_PER_HOUR) + Number(compound[1])}h${mins % MINUTES_PER_HOUR || ''})` };
    return capEstimate(Number(compound[1]) * MINUTES_PER_HOUR + mins, raw);
  }

  // one number and one unit. fractions are allowed on hours and days ("1.5h",
  // "0.5d") since that's how people say a half of either; minutes are whole by
  // definition, and a fractional one rounds rather than erroring — "20.5m" is
  // someone being precise about something that doesn't need it, not a mistake.
  const single = s.match(/^(\d+(?:\.\d+)?)\s*(d(?:ays?)?|h(?:ours?|rs?)?|m(?:in(?:ute)?s?)?)?$/);
  if(single){
    const n = Number(single[1]);
    // a bare number is minutes: it's a terminal, "est 3 90" is a natural thing to
    // type, and minutes is the only reading under which the unit-less form and the
    // stored value are the same number.
    const unit = (single[2] || 'm')[0];
    const mins = unit === 'd' ? n * MINUTES_PER_WORKDAY
               : unit === 'h' ? n * MINUTES_PER_HOUR
               : n;
    if(mins <= 0) return { error: `an estimate has to be more than zero — "none" is how you clear one` };
    return capEstimate(Math.round(mins), raw);
  }

  return { error: `"${raw}" isn't a length of time i understand` };
}
function capEstimate(minutes, raw){
  if(minutes > EST_MAX) return { error: `"${raw}" is longer than ${estText(EST_MAX)} — that's past the point where an estimate means anything, so it's more likely a typo` };
  return { minutes };
}

// minutes back into something you'd say out loud, for the "[est:...]" field — the
// reverse of parseEstimate, the way dueText is the reverse of parseDue.
//
// hours are the ceiling even for a multi-day estimate: "16h" and "2d" are the same
// stored number, but only one of them is unambiguous on sight, and the display is
// exactly where that ambiguity would cost something. "2d" stays typeable; it just
// isn't what gets read back.
function estText(minutes){
  const n = Number(minutes);
  if(!Number.isFinite(n) || n <= 0) return '';
  const h = Math.floor(n / MINUTES_PER_HOUR), m = n % MINUTES_PER_HOUR;
  if(!h) return `${m}m`;
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`;
}

// the accepted spellings, written out for humans — the same job DATE_HELP does for
// dates, kept next to the parser for the same reason.
const EST_HELP = 'try: 45m · 2h · 1h30 · 1.5h · 90 (bare numbers are minutes) · 2d (a day is 8h)';
// what Tab offers after "-est" and after "est <id>" — see FLAG_COMPLETIONS/
// ARG_COMPLETIONS, both of which reach this lazily.
const EST_VALUE_WORDS = ['15m', '30m', '45m', '1h', '1h30', '2h', '4h', '1d', 'none'];

// one worked example per flag, so the "you left this dangling" message below can
// show the shape that was missing instead of just naming the flag. shared by both
// argument parsers (add's flags, and list/filter/archive's) so the two can't drift
// into describing the same flag differently.
const FLAG_EXAMPLES = { '-p': '-p high', '-d': '-d friday', '-t': '-t urgent,home', '-proj': '-proj work', '-est': '-est 90m' };
function missingFlagError(flag){
  return { text: `${flag} needs a value after it — e.g. ${FLAG_EXAMPLES[flag]}`, cls: 'err' };
}

// the four spellings of the estimate flag. "-est" is the canonical one and the only
// one help mentions; the rest are the words that come to hand first when you're
// reaching for this field, kept working for the same reason SPELLINGS exists rather
// than made to fail at someone who typed the obvious thing. they normalise to "-est"
// on the way in (see parseFlags), so nothing downstream has to know there are four.
const EST_FLAGS = ['-est', '-estimate', '-dur', '-duration', '-time'];

// which feature each flag belongs to, so a flag whose feature is off is reported
// rather than quietly swallowed into a task nobody can see the value of. the two
// inline marks below are listed under their bare punctuation.
const FLAG_FEATURE = { '-p':'priority', '-d':'due', '-t':'tags', '-proj':'projects', '#':'projects', '+':'tags', '-est':'est' };
// the alternate estimate spellings get the same feature gate and the same Tab
// completions as the canonical one. parseFlags normalises them away before either
// table is consulted for *parsing*, but completion looks up the raw token you just
// typed — so without this, "-dur <Tab>" would offer nothing and read as unsupported.
EST_FLAGS.forEach(f => { FLAG_FEATURE[f] = 'est'; FLAG_COMPLETIONS[f] = () => EST_VALUE_WORDS; FLAG_EXAMPLES[f] = `${f} 90m`; });

// ---------- the inline #project / +tag marks ----------
// "add buy milk #home +errand" instead of "add buy milk -proj home -t errand".
// the flags still work and still parse identically; these are just the spelling
// worth typing, and the one the help rows now advertise.
//
// the trailing shape is deliberately narrow — a letter first, then word characters
// or dashes — because the alternative (anything after # or +) quietly eats ordinary
// titles: "add fix bug #42" would file the task under a project called 42, and
// "add call +1 for support" would tag it "1". requiring a leading letter leaves
// every numeric form in the title where it was typed, which is where the false
// positives actually live. anything else odd is handled the way a flag-like title
// always has been: quote it, and the tokenizer hands it over intact.
// one project per task, so #project takes a single name; +tag takes a comma list
// ("+car,home,key" is three tags), matching what -t already accepted. every comma
// segment has to clear the same leading-letter bar, so "+1,2" stays a title too.
const INLINE_PROJECT = /^#([A-Za-z][\w-]*)$/;
const INLINE_TAG = /^\+([A-Za-z][\w-]*(?:,[A-Za-z][\w-]*)*)$/;

function parseFlags(tokens){
  const args = { _: [], tagList: [] };
  const flagKeys = { '-p':'p', '-d':'d', '-t':'t', '-proj':'proj', '-est':'est' };
  for(let i=0;i<tokens.length;i++){
    // the estimate flag's alternate spellings collapse to the canonical one here,
    // before anything else looks at the token — so every check below (feature gate,
    // dangling value, key lookup) sees one flag rather than five.
    const tk = EST_FLAGS.includes(tokens[i].toLowerCase()) ? '-est' : tokens[i];
    const proj = tk.match(INLINE_PROJECT), tag = tk.match(INLINE_TAG);
    if(proj || tag){
      const mark = proj ? '#' : '+';
      if(!featureOn(FLAG_FEATURE[mark])){ args.offFlag = mark; continue; }
      if(proj){
        // one project per task, so two of them is a typo rather than a request —
        // reported instead of silently keeping whichever happened to be last.
        if(args.proj && args.proj !== proj[1]){ args.twoProjects = [args.proj, proj[1]]; continue; }
        args.proj = proj[1];
      } else {
        tag[1].split(',').forEach(one => { if(!args.tagList.includes(one)) args.tagList.push(one); });
      }
      continue;
    }
    if(flagKeys[tk] && !featureOn(FLAG_FEATURE[tk])){
      args.offFlag = tk;
      i++;                                    // its value goes with it, rather than landing in the title
      continue;
    }
    if(flagKeys[tk]){
      const value = tokens[++i];
      // a flag sitting at the end with nothing after it used to store `undefined`,
      // which every check downstream reads as "not supplied" — so "add milk -p"
      // silently dropped the priority you were clearly in the middle of setting.
      // recorded instead, and reported by the command before it does anything.
      if(value === undefined){ args.missingFlag = tk; continue; }
      args[flagKeys[tk]] = value;
    }
    else { args._.push(tk); }
  }
  return args;
}

function cmd_add(args){
  // quotes are optional: "add buy groceries" and "add "buy groceries"" both give
  // one task titled "buy groceries" — every non-flag token joins the title, in the
  // order they were typed, so a title only needs quoting when it contains a flag
  // -like token it doesn't want mistaken for one (rare enough not to special-case).
  const title = args._.join(' ');
  if(!title){ print('add needs a title, e.g. add buy groceries', 'err'); return; }
  if(args.missingFlag){ const bad = missingFlagError(args.missingFlag); print(bad.text, bad.cls); return; }
  if(args.twoProjects){
    print(`a task belongs to one project, and you gave two: #${args.twoProjects[0]} and #${args.twoProjects[1]} — nothing was added.`, 'err');
    print('  pick one, or use a tag for the other:  add <title> #' + args.twoProjects[0] + ' +' + args.twoProjects[1], 'info');
    return;
  }
  if(args.offFlag){
    const feat = FLAG_FEATURE[args.offFlag];
    print(`${args.offFlag} sets ${feat}, which is switched off — nothing was added.`, 'err');
    print(`  turn it back on with:  set ${feat} on   (or drop it and add the task without)`, 'info');
    return;
  }
  let priority = null, due = null, tags = [], project = null, est = null;
  if(args.est){
    const parsed = parseEstimate(args.est);
    if(parsed.error){ print(parsed.error, 'err'); print(`  ${EST_HELP}`, 'info'); return; }
    est = parsed.clear ? null : parsed.minutes;
  }
  if(args.p){
    const p = args.p.toLowerCase();
    if(!['high','med','low'].includes(p)){ print('priority must be high, med, or low', 'err'); return; }
    priority = p;
  }
  if(args.d){
    const parsed = parseDue(args.d);
    if(parsed.error){ print(parsed.error, 'err'); print(`  ${DATE_HELP}`, 'info'); return; }
    due = parsed.clear ? null : parsed.date;
  }
  // "-t a,b" and "+a +b" are two spellings of the same field, so they add together
  // rather than one winning: "add x -t home +errand" gets both, which is the only
  // reading that isn't a silent loss of something you typed.
  tags = [...new Set([...(args.t ? args.t.split(',').map(s=>s.trim()).filter(Boolean) : []), ...args.tagList])];
  if(args.proj){
    project = args.proj;
    if(!projects.includes(project)){
      projects.push(project);
      print(`note: created new project "${project}"`, 'info');
    }
  }
  const t = { id: nextFreeId(), title, status:'pending', priority, due, est, tags, project, createdAt: Date.now() };
  tasks.push(t);
  // echoed back in the same marks the list uses, from the same function — this line
  // is where you first meet the notation, so it teaching a different one ("[high]
  // due X proj:Y") than the list shows a second later was the worst place for the
  // two to disagree. createdAt is blanked on the copy purely to drop the age mark:
  // "added ... ~today" is noise on a task created a moment ago.
  const marks = detailFields({ ...t, createdAt: null }).join(' ');
  print(`added #${t.id} "${title}"${marks ? ' ' + marks : ''}`, 'ok');
  saveState(); renderPanel();
}

// unlike priority/due/tag, rename takes exactly one task — "rename 3,5 new title"
// would give two unrelated tasks the identical title, which is never what's meant,
// so multi-id syntax is rejected outright rather than silently doing the wrong
// thing (parseInt on "3,5" would otherwise quietly resolve to just #3).
function cmd_rename(idStr, newTitle){
  if(!idStr){ print('rename needs a task id and a new title, e.g. rename 3 "buy milk"', 'err'); return; }
  if(/[,-]/.test(idStr) || idStr.toLowerCase() === 'all'){
    print('rename takes one task id at a time — e.g. rename 3 "buy milk"', 'err');
    return;
  }
  const t = findTask(idStr);
  if(!t){ print(`no task #${idStr}`, 'err'); return; }
  if(!newTitle){ print('rename needs a new title, e.g. rename 3 "buy milk"', 'err'); return; }
  const old = t.title;
  t.title = newTitle;
  print(`#${t.id} renamed: "${old}" → "${newTitle}"`, 'ok');
  saveState(); renderPanel();
}

// "edit <id>" changes nothing by itself — it loads a ready-to-submit
// "rename <id> ..." command into the input, current title and all, so fixing
// a word or two is a few keystrokes and enter instead of retyping the whole
// title blind the way bare "rename" needs. cursor lands just inside the
// closing quote (or at the very end, for the rare title that itself contains
// a `"` and so goes in unquoted) rather than after it, so anything typed next
// stays part of the title instead of trailing off as a stray extra argument.
// deferred with setTimeout(0): Enter's own keydown handler clears the input
// right after dispatch() returns, which would otherwise wipe this out the
// instant it was set — same trick used above to attach the fullscreen key
// listener only after its own triggering keystroke finishes bubbling.
function cmd_edit(idStr){
  if(!idStr){ print('edit needs a task id, e.g. edit 3', 'err'); return; }
  // the same one-id-only guard rename carries, for the same reason: this builds a
  // rename command, so anything rename refuses to accept it must refuse to produce.
  // without it, "edit 2,3" fell through to findTask's parseInt and silently offered
  // to rename #2 alone — quietly answering a different question than the one asked.
  if(/[,-]/.test(idStr) || idStr.toLowerCase() === 'all'){
    print('edit takes one task id at a time — e.g. edit 3', 'err');
    return;
  }
  const t = findTask(idStr);
  if(!t){ print(`no task #${idStr}`, 'err'); return; }
  const quotable = !t.title.includes('"');
  const prefill = quotable ? `rename ${t.id} "${t.title}"` : `rename ${t.id} ${t.title}`;
  setTimeout(() => {
    cmdInput.value = prefill;
    cmdInput.focus();
    const pos = quotable ? prefill.length - 1 : prefill.length;
    cmdInput.setSelectionRange(pos, pos);
  }, 0);
}

function cmd_start(idsStr){
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('start needs a task id, e.g. start 3 or start 3,5,6', 'err'); return; }
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    if(t.status === 'done'){ print(`#${t.id} is already done`, 'err'); return; }
    t.status = 'active';
    print(`#${t.id} "${t.title}" is now active`, 'ok');
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

// the inverse of start, and the reason it exists: "active" was a one-way door —
// once a task was started the only ways out were finishing it or deleting it, so
// picking something up to look at it left the list permanently claiming you were
// mid-way through it. this puts it back to pending.
function cmd_stop(idsStr){
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('stop needs a task id, e.g. stop 3 or stop 3,5,6', 'err'); return; }
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    // not an error: "stop" on something already pending asked for a state it's
    // already in, which is what "stop all" means when only some are active.
    if(t.status !== 'active'){ print(`#${t.id} wasn't active`, 'info'); return; }
    t.status = 'pending';
    print(`#${t.id} "${t.title}" is back to pending`, 'ok');
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

// ---------- guard rails ----------
// "rm all" used to be a single keystroke away from wiping everything, with no
// confirmation and no way back. two independent safety nets now: anything sweeping
// enough asks first, and every state-changing command is undoable afterwards.
const CONFIRM_THRESHOLD = 3;                              // affect more tasks than this and you get asked
let pendingConfirm = null;                                // { label, run } — the next line typed answers it

function askConfirm(question, label, run){
  pendingConfirm = { label, run };
  print(question, 'err');
  print('type "yes" to go ahead — anything else cancels.', 'info');
}

// how many tasks a selection actually resolves to, so the prompt can name a real
// number ("delete 12 tasks?") instead of echoing what you typed ("delete all?").
function resolveTargets(ids){
  return ids.map(findTask).filter(Boolean);
}

async function cmd_done(idsStr){
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('done needs a task id, e.g. done 3 or done 3,5,6', 'err'); return; }
  const targets = resolveTargets(ids);
  if(targets.length > CONFIRM_THRESHOLD){
    askConfirm(`complete all ${targets.length} of these tasks and move them to the archive?`, `done ${idsStr}`, () => performDone(ids));
    return;
  }
  return performDone(ids);
}

async function performDone(ids){
  let changed = false;
  for(const idStr of ids){
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); continue; }
    if(t.status === 'done'){ print(`#${t.id} is already done`, 'err'); continue; }
    t.status = 'done';
    t.completedAt = Date.now();
    print(`#${t.id} "${t.title}" done! moved to the archive.`, 'ok');
    changed = true;
    tasks = tasks.filter(x => x.id !== t.id);
    archive.push(t);
    const track = activeTrack();
    const outcome = await track.creditCompletion(art => printCompletionPrompt(art));
    if(outcome === 'banked'){
      print(`(${track.banked} completion${track.banked === 1 ? '' : 's'} banked for your next piece — type "close" or "download" to start it)`, 'info');
    }
  }
  if(changed){
    // nudge once per new day, not once per task — completing 3 tasks today
    // shouldn't print the same streak line 3 times.
    const counts = completionCounts();
    const doneToday = counts[localDateKey(new Date())];
    if(doneToday === 1){
      const { current } = computeStreaks(counts);
      if(current >= 2) print(`you've completed tasks ${current} days running.`, 'ok');
    }
    saveState(); renderPanel();
  }
}

function cmd_rm(idsStr){
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('rm needs a task id, e.g. rm 3 or rm 3,5,6', 'err'); return; }
  const targets = resolveTargets(ids);
  if(targets.length > CONFIRM_THRESHOLD){
    askConfirm(`delete ${targets.length} tasks? they don't go to the archive — they're gone.`, `rm ${idsStr}`, () => performRm(ids));
    return;
  }
  performRm(ids);
}

function performRm(ids){
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    tasks = tasks.filter(x => x.id !== t.id);
    print(`removed #${t.id} "${t.title}"`, 'ok');
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

function cmd_priority(idsStr, p){
  p = (p||'').toLowerCase();
  if(!['high','med','low'].includes(p)){ print('priority must be high, med, or low', 'err'); return; }
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('priority needs a task id, e.g. priority 3 high or priority 3,5,6 high', 'err'); return; }
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    t.priority = p;
    print(`#${t.id} priority set to ${p}`, 'ok');
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

function cmd_due(idsStr, dateStr){
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('due needs a task id, e.g. due 3 friday or due 3,5,6 2026-01-01', 'err'); return; }
  const parsed = parseDue(dateStr);
  if(parsed.error){ print(parsed.error, 'err'); print(`  ${DATE_HELP} · none`, 'info'); return; }
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    if(parsed.clear){ t.due = null; print(`#${t.id} due date cleared`, 'ok'); }
    // the resolved date is echoed rather than what was typed: "due 3 friday" is only
    // useful if it tells you which friday it landed on. the relative form trails it
    // in brackets — that's what the list will show, so this is where the two
    // spellings get introduced as the same day. dropped when it would just repeat
    // the date (anything more than a week out renders as the date itself).
    else {
      t.due = parsed.date;
      const rel = dueText(parsed.date);
      print(`#${t.id} due ${parsed.date}${rel === parsed.date ? '' : ` (${rel})`}`, 'ok');
    }
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

// the same shape as cmd_due one function up, for the same reason: setting a field
// on a range of ids is one motion, and the two fields you'd most often set that way
// should behave identically while doing it.
function cmd_est(idsStr, timeStr){
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('est needs a task id, e.g. est 3 90m or est 3,5,6 1h30', 'err'); return; }
  const parsed = parseEstimate(timeStr);
  if(parsed.error){ print(parsed.error, 'err'); print(`  ${EST_HELP} · none`, 'info'); return; }
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    if(parsed.clear){ t.est = null; print(`#${t.id} estimate cleared`, 'ok'); }
    // echoed in the canonical spelling rather than what was typed — "est 3 2d" is
    // only useful if it tells you the 16h it actually stored, which is the number
    // every total downstream will be adding up. the same reasoning as cmd_due
    // echoing the resolved date instead of the "friday" you asked for; the typed
    // form trails in brackets when it differs, so the two are introduced as one
    // length of time rather than left looking like a silent substitution.
    else {
      t.est = parsed.minutes;
      const canonical = estText(parsed.minutes);
      const typed = String(timeStr).trim().toLowerCase();
      print(`#${t.id} estimate ${canonical}${canonical === typed ? '' : ` (${typed})`}`, 'ok');
    }
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

function cmd_tag(idsStr, action, value){
  action = (action || '').toLowerCase();
  if(!['add','rm','set'].includes(action)){ print('usage: tag <id> add|rm|set <tag(s)>', 'err'); return; }
  if(!value){ print(`usage: tag <id> ${action} <tag(s)>`, 'err'); return; }
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('tag needs a task id, e.g. tag 3 add urgent or tag 3,5,6 add urgent', 'err'); return; }
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    if(!t.tags) t.tags = [];
    if(action === 'add'){
      value.split(',').map(s=>s.trim()).filter(Boolean).forEach(tag => {
        if(!t.tags.includes(tag)) t.tags.push(tag);
      });
    } else if(action === 'rm'){
      // comma-split and case-insensitive, matching "add"/"set" above and the
      // case-insensitive match filterTasks uses for "-t" — otherwise a tag you
      // can filter by ("filter -t Urgent" matching "urgent") isn't one you can
      // remove, and "rm" alone couldn't clear more than one tag per command.
      const wanted = value.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
      t.tags = t.tags.filter(x => !wanted.includes(x.toLowerCase()));
    } else {
      t.tags = value.split(',').map(s=>s.trim()).filter(Boolean);
    }
    print(`#${t.id} tags: ${t.tags.join(', ') || '(none)'}`, 'ok');
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

// "mark 3" / "mark 3,5 off" — the dot in the margin, as a command rather than a tag
// you have to spell. it writes an ordinary tag underneath (MARK_TAG) rather than a
// field of its own, so a marked task is still filterable ("list +mark"), still
// listed by "tags", and still undoable, with nothing new to store or migrate.
function cmd_mark(idsStr, arg){
  if(!featureOn('tags')){
    print('mark writes a tag, and tags are switched off — nothing was marked.', 'err');
    print('  turn them back on with:  set tags on', 'info');
    return;
  }
  const ids = splitIds(idsStr);
  if(ids.length === 0){ print('mark needs a task id, e.g. mark 3  ("mark 3 off" clears it)', 'err'); return; }
  const off = /^(off|no|none|rm|remove|clear)$/i.test((arg || '').trim());
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    if(!t.tags) t.tags = [];
    // clearing strips every spelling that counts as marked, not just the canonical
    // one — otherwise a task tagged with the older "important" would keep its dot
    // after being told to drop it.
    if(off){
      t.tags = t.tags.filter(x => !isMarkTag(x));
      print(`#${t.id} unmarked`, 'ok');
    } else {
      if(!t.tags.some(isMarkTag)) t.tags.push(MARK_TAG);
      print(`#${t.id} marked ${SPECIAL_TAGS.find(e => e[0] === MARK_TAG)[1]}`, 'ok');
    }
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

function cmd_tags(){
  const counts = {};
  tasks.forEach(t => (t.tags||[]).forEach(tag => { counts[tag] = (counts[tag]||0) + 1; }));
  const names = Object.keys(counts).sort();
  if(names.length === 0){ print('no tags in use yet.', 'info'); return; }
  names.forEach(tag => print(`${tag}  (${counts[tag]})`));
}

function cmd_project(sub, ...rest){
  sub = (sub || 'list').toLowerCase();
  if(sub === 'add'){
    const name = rest[0];
    if(!name){ print('usage: project add <name>', 'err'); return; }
    if(projects.includes(name)){ print(`project "${name}" already exists`, 'err'); return; }
    projects.push(name);
    print(`created project "${name}"`, 'ok');
    saveState();
  } else if(sub === 'rm'){
    const name = rest[0];
    if(!name || !projects.includes(name)){ print(`no such project "${name||''}"`, 'err'); return; }
    projects = projects.filter(p => p !== name);
    // archived tasks get unassigned too, and are now counted rather than done
    // silently: the old message named only the live ones, so removing a project
    // whose work was already finished reported "removed project" with no numbers
    // at all — no sign that it had just edited the archive as well.
    let moved = 0, movedArchived = 0;
    tasks.forEach(t => { if(t.project === name){ t.project = null; moved++; } });
    archive.forEach(t => { if(t.project === name){ t.project = null; movedArchived++; } });
    const unassigned = [];
    if(moved) unassigned.push(`${moved} task${moved === 1 ? '' : 's'}`);
    if(movedArchived) unassigned.push(`${movedArchived} archived`);
    print(`removed project "${name}"${unassigned.length ? ` (${unassigned.join(' + ')} unassigned)` : ''}`, 'ok');
    saveState(); renderPanel();
  } else if(sub === 'list'){
    if(projects.length === 0){ print('no projects yet. create one:  project add <name>', 'info'); return; }
    projects.forEach(p => {
      const count = tasks.filter(t => t.project === p).length;
      print(`${p}  (${count} task${count===1?'':'s'})`);
    });
  } else if(sub === 'set'){
    const idsStr = rest[0], name = rest[1];
    if(name !== 'none' && (!name || !projects.includes(name))){
      print(`no such project "${name||''}". create it first: project add ${name||'<name>'}`, 'err'); return;
    }
    const ids = splitIds(idsStr);
    if(ids.length === 0){ print('project set needs a task id, e.g. project set 3 home or project set 3,5,6 home', 'err'); return; }
    let changed = false;
    ids.forEach(idStr => {
      const t = findTask(idStr);
      if(!t){ print(`no task #${idStr}`, 'err'); return; }
      if(name === 'none'){ t.project = null; print(`#${t.id} removed from project`, 'ok'); }
      else { t.project = name; print(`#${t.id} assigned to project "${name}"`, 'ok'); }
      changed = true;
    });
    if(changed){ saveState(); renderPanel(); }
  } else {
    print('usage: project add|rm|list|set ...', 'err');
  }
}

function parseListArgs(tokens){
  const out = { status:'all', proj:null, tag:null };
  for(let i=0;i<tokens.length;i++){
    const tk = tokens[i];
    // the same #project / +tag marks "add" takes, so one spelling works everywhere
    // rather than the filters keeping a second vocabulary of their own.
    const proj = tk.match(INLINE_PROJECT), tag = tk.match(INLINE_TAG);
    if(proj || tag){
      const mark = proj ? '#' : '+';
      if(!featureOn(FLAG_FEATURE[mark])){ out.offFlag = mark; continue; }
      if(proj) out.proj = proj[1]; else out.tag = tag[1];   // filterTasks already reads a comma list as "any of these"
      continue;
    }
    if(tk === '-proj' || tk === '-t'){
      // filtering on a field that's switched off would narrow the list by something
      // you can't see and can't set — reported the same way an off flag on "add" is.
      if(!featureOn(FLAG_FEATURE[tk])){ out.offFlag = tk; i++; continue; }
      const value = tokens[++i];
      // same dangling-flag trap parseFlags guards against: left as `undefined`, this
      // read as "no filter on that field", so "filter -proj" reported setting a
      // filter and then set nothing at all. listArgsError turns this into the error.
      if(value === undefined){ out.missingFlag = tk; continue; }
      if(tk === '-proj') out.proj = value; else out.tag = value;
    }
    else { out.status = tk; }
  }
  return out;
}

// ---------- what a filter spec means ----------
// one definition of "which tasks does {status, proj, tag} select", shared by the
// "list" command and the always-visible pane. they're two different surfaces onto
// the same question, so keeping the predicate in one place is what stops them from
// quietly disagreeing about what "-proj work" includes.
function filterTasks(list, f){
  let out = list;
  if(f.status === 'pending' || f.status === 'active') out = out.filter(t => t.status === f.status);
  // a standing "filter -proj work" that's still saved when projects get switched
  // off would go on hiding tasks by a field the list no longer shows and you can
  // no longer clear — so a switched-off field simply stops narrowing. the filter
  // itself is kept, and starts applying again the moment the feature comes back.
  if(f.proj && featureOn('projects')) out = out.filter(t => t.project === f.proj);
  if(f.tag && featureOn('tags')){
    const wanted = f.tag.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    out = out.filter(t => (t.tags||[]).some(x => wanted.includes(x.toLowerCase())));
  }
  return out;
}
// null when the spec is usable, otherwise the message to print. "done" gets its own
// wording (and info, not err) because it's a reasonable thing to ask for — the
// tasks exist, they just live in the archive now.
function listArgsError(f){
  if(f.offFlag) return { text: `"${f.offFlag}" filters on ${FLAG_FEATURE[f.offFlag]}, which is switched off — turn it back on with: set ${FLAG_FEATURE[f.offFlag]} on`, cls: 'err' };
  if(f.missingFlag) return missingFlagError(f.missingFlag);
  if(f.status === 'done') return { text: 'completed tasks are archived — try the "archive" command', cls: 'info' };
  if(!['all','pending','active'].includes(f.status)) return { text: `unknown filter "${f.status}" (use all|pending|active)`, cls: 'err' };
  return null;
}
function isFilterActive(f){ return !!f && (f.status !== 'all' || (!!f.proj && featureOn('projects')) || (!!f.tag && featureOn('tags'))); }
// compact, for the pane's badge and the command's own read-out
function describeFilter(f){
  const parts = [];
  if(f.status !== 'all') parts.push(f.status);
  if(f.proj && featureOn('projects')) parts.push(`proj=${f.proj}`);
  if(f.tag && featureOn('tags')) parts.push(`tag=${f.tag}`);
  return parts.join(' · ');
}

// list/archive all print the same shape: a dashed rule, the rows, then (for most
// callers) a dim one-line summary. the rule is sized to the widest row rather than
// fixed, so it hugs its content instead of overrunning it. that alone doesn't keep
// it inside a narrow console, though — the widest *row* can be wider than the pane,
// and a rule matching it used to wrap onto a second line, which read as content
// rather than as a border and was most of what made a busy screen look untidy.
// hence the "rule" class: the stylesheet clips these to the column instead of
// wrapping them. closingRule prints a second copy of that same rule right after the
// rows — "list" wants one there since it dropped its summary line and would
// otherwise end on a bare row with nothing marking the close.
const FRAME_MIN = 30, FRAME_MAX = 66;
function printFramed(rows, summary, closingRule){
  const widths = rows.map(r => r.text.length);
  if(summary) widths.push(summary.length);
  const width = Math.max(FRAME_MIN, Math.min(FRAME_MAX, Math.max(...widths)));
  const rule = '- '.repeat(Math.ceil(width / 2)).trimEnd();
  print(rule, 'info rule');
  // hanging-indented: a title long enough to wrap picks its continuation up under
  // its own first letter, not back at column 0 behind the [id] — same technique
  // printHanging already uses for help text, applied here via each row's .indent.
  rows.forEach(r => r.segments ? printSegments(r.segments, r.indent, r.cls) : printHanging(r.text, r.indent, r.cls));
  if(closingRule) print(rule, 'info rule');
  if(summary) print(summary, 'info');
}

// the [label:value] fields that trail a task title. every field is bracketed, the
// project included — the brackets are what group a value with its label into one
// visual chunk, which is also what lets a value contain a space ("[created:3d ago]")
// without reading as two fields.
//
// labelled rather than bare: "[home] [urgent]" could never say which of the two was
// the project and which the tag, because both are just words you picked. the label
// is the only thing that can carry that, so it's worth the few characters — every
// other way of encoding it (a different bracket per field, a symbol per field) asks
// the reader to have memorised a key first.
const FIELD_LABELS = {
  priority:  'prior',
  project:   'proj',
  tag:       'tag',
  due:       'due',
  est:       'est',
  age:       'created',
  completed: 'completed',
};

// returned as a list rather than a string so callers can skip appending anything
// when there's nothing in it — a plain task stays one clean line.
function detailFields(t, extra){
  const fields = [];
  const field = (label, value) => fields.push(`[${label}:${value}]`);
  if(t.priority && featureOn('priority')) field(FIELD_LABELS.priority, t.priority);
  if(t.project && featureOn('projects')) field(FIELD_LABELS.project, t.project);
  // one bracket per tag, not one bracket for all of them: "[tag:a,b,c]" reads as a
  // single field with a comma in it, which is exactly wrong the moment those are
  // three separate tags you can remove or filter by individually — "tag 1 rm b"
  // and "list +b" both act on just one of the three. the input grammar's own
  // comma-list (+a,b,c) is a typing shorthand, not a claim that the tags it
  // creates are one thing; the display shouldn't imply otherwise.
  if(t.tags && featureOn('tags')) t.tags.forEach(tag => field(FIELD_LABELS.tag, tag));
  if(t.due && featureOn('due')) field(FIELD_LABELS.due, dueText(t.due));
  // after due rather than before it: they answer "when" and "how long", and the
  // deadline is the one you scan for first.
  if(t.est && featureOn('est')) field(FIELD_LABELS.est, estText(t.est));
  if(showAge && t.createdAt) field(FIELD_LABELS.age, taskAgeText(t.createdAt));
  (extra || []).forEach(f => fields.push(f));
  return fields;
}

// ---------- gutter marks ----------
// a handful of tag names mean something to the app rather than only to you, and
// earn a mark in the margin left of the [id]. the point is a column you can run
// your eye down without reading any of the titles — which is also why there's
// exactly one mark per task rather than a row of them: a margin with three symbols
// in it is a second thing to decode, not a signal.
//
// tag names are matched loosely (see markOfTask): "very urgent", "very-urgent" and
// "Very_Urgent" are the same tag as far as this is concerned, because the inline
// "+tag" grammar can't carry a space and "tag 1 add "very urgent"" can.
//
// marks are free to be any symbol at all, in or out of the bundled font — see the
// .row-mark span in buildAlignedRows for how that's made safe. the short version:
// the row is *measured* as if every mark were MARK_WIDTH plain cells, and *drawn*
// with the mark inside a box CSS pins to exactly that width, so a glyph the font
// has to borrow from elsewhere can't drag the [id] column off line.
// [tag name, symbol, older spellings that still count]. "important" and "marked"
// are separate tags with deliberately similar dots: the big one says this matters,
// the small one is a plain flag you put on something to find it again.
//
// the tag reads "marked" while the command is "mark" — the command is an
// instruction ("mark 3") and the tag is the state it leaves behind ("[tag:marked]"),
// which is how they'd be said out loud. "mark" is kept as an accepted spelling so
// anything tagged before the rename keeps its dot and can still be cleared.
const SPECIAL_TAGS = [
  ['very urgent', '!!'],
  ['urgent',      '!' ],
  ['next',        '>' ],
  ['important',   '●' ],
  ['marked',      '•', ['mark']],
];
const ACTIVE_MARK = '>>';   // a status rather than a tag; "start" already sets it
// the tag the "mark" command writes. named rather than inlined because the command,
// the matcher and the help page all have to agree on it.
const MARK_TAG = 'marked';
// the widest mark decides the column, so every [id] lands in the same place
// whether its task carries a mark or not.
const MARK_WIDTH = Math.max(...SPECIAL_TAGS.map(([, m]) => m.length), ACTIVE_MARK.length);
function normalizeTagName(s){ return String(s).toLowerCase().replace(/[-_\s]+/g, ' ').trim(); }
// every spelling of a special tag: its name plus any older ones it absorbed.
function specialTagNames(entry){ return [entry[0], ...(entry[2] || [])]; }
// does this tag, however it was spelled, mean "marked"? the mark tag and its older
// spellings only — "important" is its own tag with its own symbol, not a synonym.
function isMarkTag(tag){
  const entry = SPECIAL_TAGS.find(e => e[0] === MARK_TAG);
  return !!entry && specialTagNames(entry).includes(normalizeTagName(tag));
}
// first match wins, in the order written above: loudest first, so a task that's
// both urgent and merely marked reads as urgent. "active" sits between the two
// exclamation marks and the quieter tag marks — it outranks a plan or a flag
// because it's already underway, but not an actual emergency.
function markOfTask(t, archived){
  const tags = new Set((t.tags || []).map(normalizeTagName));
  const marked = name => featureOn('tags') && tags.has(name);
  if(marked('very urgent')) return '!!';
  if(marked('urgent')) return '!';
  // archived tasks keep their tag marks but never the active one — finishing a
  // task doesn't clear its status field, and a "started" mark on something already
  // done would be claiming it's in progress.
  if(!archived && t.status === 'active') return ACTIVE_MARK;
  for(const entry of SPECIAL_TAGS) if(specialTagNames(entry).some(marked)) return entry[1];
  return '';
}
// every row this feeds (task list, archive) starts life as "<mark>[<id>] <title>…"
// — the hanging-indent column a wrapped title's continuation should land on, one
// past the closing bracket's own space, so it picks up under the title's first
// letter instead of sliding back under the id.
function bracketIndent(text){
  return text.indexOf(']') + 2;
}
// each task becomes up to two rows: its title on one line, and — only when there's
// actually something to put there — its [label:value] fields on a second line
// underneath, indented to start under the title's first letter.
//
// the fields used to ride along on the title's own line, which packed more into
// less height. what killed that was labels: once a field is "[proj:home]" rather
// than "[home]", a loaded task no longer fits a normal console width, so the line
// wrapped anyway — but at whatever character the width ran out at, which put the
// same field beside one title and beneath the next, and chopped up the column of
// titles that is the thing you actually scan. a deliberate second line costs the
// same height the accidental wrap was already costing and spends it on a straight
// title column instead.
//
// items: [{ mark, body, fields, cls, id }] — cls, if set, colors both of a task's
// rows (e.g. overdue), so the pair still reads as one task.
//
// mark and body stay apart rather than pre-joined, so the mark can be *measured* as
// MARK_WIDTH plain cells while being *drawn* inside a .row-mark box CSS pins to
// exactly that width. that's what lets a mark be any symbol at all: glyphs the
// bundled font lacks get borrowed from whatever font the machine has, at whatever
// width that font feels like, and the box absorbs the difference instead of the
// [id] column doing it.
//
// two details that box depends on, both learned the hard way (see .row-mark in
// momentum.css): it must never be empty — an inline-block with no line box takes
// its baseline from its bottom edge, which drops it off the row — hence the
// non-breaking space when there's no mark. and it must not set `overflow`, for
// exactly the same reason, which is why an over-wide glyph is left to spill rather
// than being clipped.
//
// isExpanded(id) decides whether a task's own metadata line actually prints —
// defaulting to "always" keeps every existing caller (list/find/archive, all
// printed to the terminal as a snapshot of the command you just typed) exactly
// as before. the list pane is the one caller that passes something else: there,
// the fields are a click away rather than always on screen (see "row-toggle" in
// app-render.js), which is what keeps a loaded task list to one line per task
// until you actually ask to see more of one.
function buildAlignedRows(items, isExpanded){
  isExpanded = isExpanded || (() => true);
  return items.flatMap(({ mark, body, fields, cls, id }) => {
    mark = mark || '';
    // everything that counts columns downstream — the frame width, the hanging
    // indent, the metadata line's leading spaces — reads this, so they all agree on
    // where the row starts whatever the mark draws as.
    const text = mark.padStart(MARK_WIDTH) + body;
    const indent = bracketIndent(text);
    const hasFields = fields.length > 0;
    const expanded = hasFields && isExpanded(id);
    // the toggle mark itself only exists when there's something behind it to
    // toggle — a bare task (nothing in `fields`) gets no [+] at all, not a dead
    // one that opens onto nothing.
    const rows = [{ text, mark, body, cls, indent, taskId: id, meta: false, toggle: hasFields ? { expanded } : null,
      segments: [{ text: mark || ' ', cls: 'row-mark' }, { text: body }] }];
    // dimmed as a whole line rather than as a trailing segment of a mixed one:
    // there's no bright title sharing the row for it to need contrasting against.
    if(expanded){
      rows.push({ text: ' '.repeat(indent) + fields.join(' '), cls: cls || 'info', indent, taskId: id, meta: true });
    }
    return rows;
  });
}

// the id *is* the marker now — there's no checkbox, since everything still in the
// list is by definition not done yet (finishing a task moves it to the archive).
// ids are right-aligned to the widest one so titles stay in a straight column.
// shared by "list", the split-view pane, and "find" (the only caller that passes
// archivedIds — a Set of ids drawn from the archive, mixed in alongside pending/
// active ones, since ids are unique across both: a task lives in exactly one of
// the two arrays at a time).
function buildTaskRows(list, archivedIds, isExpanded){
  const idWidth = Math.max(...list.map(t => String(t.id).length));
  const items = list.map(t=>{
    const archived = !!(archivedIds && archivedIds.has(t.id));
    const overdue = !archived && featureOn('due') && isOverdue(t);
    // these three carry no label: they're flags, not key/value pairs — the word is
    // already the whole of what they say.
    const extra = overdue ? ['[OVERDUE]'] : [];
    if(archived) extra.push('[archived]');
    const fields = detailFields(t, extra);
    if(!archived && t.status === 'active') fields.unshift('[active]');   // the one thing the old [~] mark said that the id doesn't
    return { mark: markOfTask(t, archived), body: `[${String(t.id).padStart(idWidth)}] ${t.title}`, fields, cls: overdue ? 'err' : undefined, id: t.id };
  });
  return buildAlignedRows(items, isExpanded);
}

// meaningful order instead of pure insertion order: overdue first (they're the
// ones actually costing you something by sitting there), then active tasks (the
// ones you've already started), then by priority. each tier only breaks ties left
// by the one before it — a low-priority overdue task still outranks a high-priority
// task that isn't overdue, since "overdue" is the more urgent fact about it. sort()
// is stable in every engine this app runs in, so tasks tied on all three keys keep
// their original (insertion) order rather than shuffling on every render.
const PRIORITY_RANK = { high: 0, med: 1, low: 2 };
function taskSortKey(t){
  // a switched-off field drops out of the ordering as well as the display: sorting
  // by something invisible is exactly the kind of "why is this at the top?" the
  // flags exist to avoid. with both off this is a plain active-first sort, and
  // sort()'s stability leaves everything else in insertion order.
  return [
    (featureOn('due') && isOverdue(t)) ? 0 : 1,
    t.status === 'active' ? 0 : 1,
    (featureOn('priority') && t.priority) ? PRIORITY_RANK[t.priority] : 3,
  ];
}
function sortForDisplay(list){
  return [...list].sort((a, b) => {
    const ka = taskSortKey(a), kb = taskSortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

// `total`, when given and larger than the list, turns the leading count into
// "3 of 12 shown" — so any view that's hiding tasks says how many, rather than
// silently looking like that's all there is.
function taskSummaryLine(list, total){
  const activeCount = list.filter(t => t.status === 'active').length;
  const overdueCount = featureOn('due') ? list.filter(isOverdue).length : 0;
  const hiding = total !== undefined && total !== list.length;
  const parts = [hiding ? `${list.length} of ${total} shown` : `${list.length} task${list.length === 1 ? '' : 's'}`];
  if(activeCount) parts.push(`${activeCount} active`);
  if(overdueCount) parts.push(`${overdueCount} overdue`);
  // the one thing per-task estimates can say that the tasks can't say individually:
  // what the whole list adds up to. it's the reason the field is minutes rather than
  // a string, and the reason it's worth filling in — an estimate you can only read
  // back one task at a time is just a note.
  //
  // says "of N" whenever some of the shown tasks have no estimate, because a total
  // over a partly-estimated list is otherwise quietly wrong in the reassuring
  // direction: it looks like the cost of everything when it's the cost of some of it.
  if(featureOn('est')){
    const estimated = list.filter(t => t.est);
    if(estimated.length){
      const sum = estimated.reduce((n, t) => n + t.est, 0);
      const partial = estimated.length !== list.length ? ` (of ${estimated.length})` : '';
      parts.push(`${estText(sum)} estimated${partial}`);
    }
  }
  return parts.join(' · ');
}

// a one-off question, answered exactly as asked — deliberately independent of the
// pane's standing "filter", so you can look at everything without disturbing the
// view you've set up. when the two disagree, the note below says so rather than
// leaving you to wonder why the pane above shows fewer tasks than this listing.
function cmd_list(tokens){
  const spec = parseListArgs(tokens || []);
  const bad = listArgsError(spec);
  if(bad){ print(bad.text, bad.cls); return; }
  const list = filterTasks(tasks, spec);
  if(list.length === 0){ print('nothing here.', 'info'); return; }
  printFramed(buildTaskRows(sortForDisplay(list)), null, true);
  if(!isFilterActive(spec) && isFilterActive(paneFilter)){
    print(`(this is everything — the pane above is filtered to ${describeFilter(paneFilter)}. "filter off" clears it.)`, 'info');
  }
}

// the standing version of "list": same arguments, but it narrows the always-visible
// pane instead of printing once. split into its own command rather than folded into
// "list" on purpose — "list" is a question you ask, this is a view you set, and
// having a peek at "list active" silently rearrange your pane would be a surprise.
function cmd_filter(tokens){
  const raw = (tokens || []).filter(Boolean);
  const first = (raw[0] || '').toLowerCase();

  if(raw.length === 0){
    if(!isFilterActive(paneFilter)){
      print('no filter — the task pane is showing everything.', 'info');
      print('  narrow it with the same arguments "list" takes:  filter active  |  filter -proj work  |  filter -t urgent', 'info');
      return;
    }
    const shown = filterTasks(tasks, paneFilter).length;
    print(`filter: ${describeFilter(paneFilter)}  —  ${shown} of ${tasks.length} task${tasks.length === 1 ? '' : 's'} shown  ("filter off" clears it)`, 'info');
    return;
  }

  if(['off','none','clear','all'].includes(first) && raw.length === 1){
    // "filter all" lands here rather than parsing as status:all — as a filter,
    // "everything" and "no filter" are the same request, and this is the wording
    // most people reach for first.
    if(!isFilterActive(paneFilter)){ print('no filter was set.', 'info'); return; }
    paneFilter = { ...NO_FILTER };
    renderListPane();
    print(`filter cleared — the task pane shows all ${tasks.length} again.`, 'ok');
    saveState();
    return;
  }

  const spec = parseListArgs(raw);
  const bad = listArgsError(spec);
  if(bad){ print(bad.text, bad.cls); return; }
  paneFilter = spec;
  renderListPane();
  const shown = filterTasks(tasks, spec).length;
  print(`filter: ${describeFilter(spec)}  —  the task pane now shows ${shown} of ${tasks.length}.`, 'ok');
  if(shown === 0) print('  nothing matches it right now — "filter off" brings everything back.', 'info');
  // the pane this narrows can be off screen entirely (art view with split off), in
  // which case the command looks like it did nothing at all. say where to find it.
  if(!listPaneVisible()) print('  (the task pane is hidden right now — "split on" or "view tasks" shows it)', 'info');
  saveState();
}

// searches both pending/active and archived tasks at once — the point of a search
// is not remembering where you put something, so unlike "list" it doesn't stop at
// the archive boundary. title and tags are both checked (a tag is text you chose
// too); case-insensitive substring, not a fuzzy match, so it stays predictable once
// you have enough tasks that scanning by eye stopped working.
function cmd_find(tokens){
  const query = (tokens || []).join(' ').trim();
  if(!query){ print('find needs something to search for, e.g. find groceries', 'err'); return; }
  const q = query.toLowerCase();
  const matches = t => t.title.toLowerCase().includes(q) || (featureOn('tags') && (t.tags||[]).some(tag => tag.toLowerCase().includes(q)));
  const activeHits = tasks.filter(matches);
  const archivedHits = archive.filter(matches);
  const total = activeHits.length + archivedHits.length;
  if(total === 0){ print(`no tasks matching "${query}"`, 'info'); return; }

  const archivedIds = new Set(archivedHits.map(t => t.id));
  const summary = `  ${total} match${total === 1 ? '' : 'es'} for "${query}"` +
    (archivedHits.length ? `  (${activeHits.length} active/pending, ${archivedHits.length} archived)` : '');
  printFramed(buildTaskRows([...activeHits, ...archivedHits], archivedIds), summary);
}

// wraps one buildTaskRows() row for the clickable list pane. the [id] bracket
// becomes its own span — click it and the list-pane click handler below
// pre-fills "done <id>" into the command line without running it, so clicking a
// task never finishes it on its own; click anywhere else on the title and the id
// gets appended into whatever's being typed instead. the row always starts with
// "  [<id>] " (see buildTaskRows), so slicing off through the first "]" reliably
// isolates the bracket without needing buildTaskRows to hand back id/title as
// separate fields — rows printed to the terminal (list/find/archive) go through
// buildTaskRows too, so that shape has to stay a single string for those callers.
//
// a title row that has metadata (r.toggle is set) also gets a [+]/[–] span of
// its own — a third click target, distinct from both the [id] bracket and the
// title text, so opening/closing the metadata line never collides with either of
// those two existing behaviours.
function rowHtml(r, id){
  // same hanging-indent trick as printHanging/printFramed: a title long enough to
  // wrap in the pane's own column picks its continuation up under its own first
  // letter, not back at the pane's left edge behind the [id].
  const style = `padding-left:${r.indent}ch;text-indent:-${r.indent}ch`;
  const cls = `line row${r.cls ? ' ' + r.cls : ''}`;
  // a task's second row has no [id] bracket of its own to lift out — it's one run
  // of fields. it still carries data-id, so clicking the metadata targets the same
  // task as clicking its title.
  if(r.meta) return `<div class="${cls}" data-id="${id}" style="${style}">${escapeHtml(r.text)}</div>`;
  // the mark gets its own fixed-width box so whatever font ends up drawing it can't
  // shift the [id] beside it. never empty — see .row-mark for why a space matters.
  const markHtml = `<span class="row-mark">${escapeHtml(r.mark || ' ')}</span>`;
  const bracketEnd = r.body.indexOf(']') + 1;
  const idHtml = `<span class="row-id" data-id="${id}">${escapeHtml(r.body.slice(0, bracketEnd))}</span>`;
  const toggleHtml = r.toggle
    ? ` <span class="row-toggle" data-id="${id}">${r.toggle.expanded ? '[-]' : '[+]'}</span>`
    : '';
  return `<div class="${cls}" data-id="${id}" style="${style}">${markHtml}${idHtml}${escapeHtml(r.body.slice(bracketEnd))}${toggleHtml}</div>`;
}

// the always-visible task list — the pane above the console in split view, and the
// side column in "view tasks". narrowed by the standing "filter", which is why the
// header carries a badge whenever one is set: a pane that's hiding tasks has to say
// so on its face, since unlike a terminal listing it has no command echoed above it
// to explain why it looks the way it does.
function renderListPane(){
  const pane = document.getElementById('list-pane');
  if(!pane) return;
  const filtered = isFilterActive(paneFilter);
  const badge = filtered ? `<span class="filter-badge">filter: ${escapeHtml(describeFilter(paneFilter))}</span>` : '';
  const head = summary => `<div class="pane-head">TASKS ${badge}<span>${escapeHtml(summary)}</span></div>`;

  if(tasks.length === 0){
    pane.innerHTML = head('nothing yet') +
      `<div class="line info">nothing here yet</div>`;
    return;
  }
  const shown = filterTasks(tasks, paneFilter);
  // distinct from the no-tasks-at-all case above: you *have* tasks, the filter is
  // just hiding all of them, and the way out is clearing it rather than adding one.
  if(shown.length === 0){
    pane.innerHTML = head(`0 of ${tasks.length} shown`) +
      `<div class="line info">nothing matches this filter — "filter off" brings back all ${tasks.length}.</div>`;
    return;
  }
  const sorted = sortForDisplay(shown);
  // each row carries its own taskId now — a task can occupy two rows, so the old
  // index-into-sorted pairing no longer lines up. metadata starts collapsed for
  // every task (expandedTaskIds empty) and stays that way until its own [+] is
  // clicked — see the list-pane click handler in app-render.js.
  const rows = buildTaskRows(sorted, null, id => expandedTaskIds.has(id)).map(r => rowHtml(r, r.taskId)).join('');
  pane.innerHTML = head(taskSummaryLine(shown, tasks.length)) + rows;
}

function cmd_archive(...tokens){
  const first = (tokens[0] || '').toLowerCase();
  if(['rm','remove','delete'].includes(first)) return cmd_archiveRm(tokens[1]);
  const spec = parseListArgs(tokens || []);
  if(spec.missingFlag){ const bad = listArgsError(spec); print(bad.text, bad.cls); return; }
  // archive takes no status argument — everything in it is completed by definition —
  // so a bare word here is a typo worth naming rather than dropping on the floor.
  // "list" already rejects a status it doesn't recognize; this used to accept
  // anything and quietly list the whole archive as if you'd asked for that.
  if(spec.status !== 'all'){
    print(`archive doesn't take "${spec.status}" — everything in it is completed already, so there's no status to narrow by. usage: archive [-proj name] [-t tag]`, 'err');
    return;
  }
  const { proj, tag } = spec;
  let list = archive;
  if(proj){ list = list.filter(t => t.project === proj); }
  if(tag){
    const wanted = tag.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    list = list.filter(t => (t.tags||[]).some(x => wanted.includes(x.toLowerCase())));
  }
  // "the archive is empty" and "nothing in it matches what you asked for" are
  // different answers, and giving the first for the second made a filtered archive
  // look wiped — alarming for the one list in the app that "restore" reads from.
  if(archive.length === 0){ print('the archive is empty.', 'info'); return; }
  if(list.length === 0){
    print(`nothing in the archive matches ${describeFilter(spec)} — "archive" on its own shows all ${archive.length}.`, 'info');
    return;
  }

  const idWidth = Math.max(...list.map(t => String(t.id).length));
  const items = list.map(t => ({
    // archived: true, so a task that was active when it was completed doesn't keep
    // claiming to be in progress here.
    mark: markOfTask(t, true),
    body: `[${String(t.id).padStart(idWidth)}] ${t.title}`,
    fields: detailFields(t, t.completedAt ? [`[${FIELD_LABELS.completed}:${new Date(t.completedAt).toLocaleDateString()}]`] : []),
    id: t.id
  }));
  printFramed(buildAlignedRows(items), `  ${list.length} completed`, true);
}

// the inverse of "done" — pulls an archived task back into the active list.
// status resets to pending rather than trying to recall whatever it was
// (pending/active) before completion, since that isn't tracked once a task is done.
function cmd_restore(idsStr){
  const ids = splitIds(idsStr, archive);
  if(ids.length === 0){ print('restore needs an archived task id, e.g. restore 3 or restore 3,5,6', 'err'); return; }
  let changed = false;
  ids.forEach(idStr => {
    const t = findArchived(idStr);
    if(!t){ print(`no archived task #${idStr}`, 'err'); return; }
    archive = archive.filter(x => x.id !== t.id);
    t.status = 'pending';
    delete t.completedAt;
    tasks.push(t);
    print(`#${t.id} "${t.title}" restored to your task list.`, 'ok');
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

// permanently deletes from the archive. unlike "rm" on a pending task, there's no
// "restore" to come back from here — the automatic in-browser backups/export still
// have it, but nothing inside the app can bring it back once this runs, hence the
// confirmation past the usual threshold.
function cmd_archiveRm(idsStr){
  const ids = splitIds(idsStr, archive);
  if(ids.length === 0){ print('archive rm needs an id, e.g. archive rm 3 or archive rm 3,5,6', 'err'); return; }
  const targets = ids.map(findArchived).filter(Boolean);
  if(targets.length > CONFIRM_THRESHOLD){
    askConfirm(`permanently delete ${targets.length} archived tasks? "restore" can't bring these back once this runs.`, `archive rm ${idsStr}`, () => performArchiveRm(ids));
    return;
  }
  performArchiveRm(ids);
}
function performArchiveRm(ids){
  let changed = false;
  ids.forEach(idStr => {
    const t = findArchived(idStr);
    if(!t){ print(`no archived task #${idStr}`, 'err'); return; }
    archive = archive.filter(x => x.id !== t.id);
    print(`permanently deleted #${t.id} "${t.title}" from the archive`, 'ok');
    changed = true;
  });
  if(changed){ saveState(); renderPanel(); }
}

function cmd_stats(){
  const total = tasks.length;
  const active = tasks.filter(t=>t.status==='active').length;
  const pending = tasks.filter(t=>t.status==='pending').length;
  const overdue = tasks.filter(isOverdue).length;
  // each label is bound to its own number by non-breaking spaces, and the pairs are
  // separated by " · " (the same divider the header stat line uses). in a narrow
  // console this line has to wrap somewhere, and those are the only two choices:
  // between whole pairs, or — as it used to, on plain spaces — mid-pair, orphaning
  // "2" onto the next line away from the "pending:" it belongs to.
  const pairs = [
    ['total', total], ['completed', archive.length], ['active', active], ['pending', pending],
    ...(featureOn('due') ? [['overdue', overdue]] : []),
    ...(featureOn('projects') ? [['projects', projects.length]] : []),
    ['ascii collected', asciiTrack.collected.length], ['image collected', imageTrack.collected.length],
  ];
  print(pairs.map(([label, n]) => `${label.replace(/ /g, ' ')}: ${n}`).join('  ·  '));
}

// ---------- streak + completion heatmap ----------
// every archived task already carries completedAt; this just buckets those
// timestamps into local calendar days. shared by "streak" and the done-command
// nudge below, so both agree on what a "day" means.
function completionCounts(){
  const counts = {};
  archive.forEach(t => {
    if(!t.completedAt) return;
    const key = localDateKey(new Date(t.completedAt));
    counts[key] = (counts[key] || 0) + 1;
  });
  return counts;
}

// current: consecutive days of at least one completion, counting backward from
// today — or from yesterday if today has nothing yet, since today isn't over
// and a streak shouldn't read as broken before it's actually broken.
// longest: the best run ever seen in the data, independent of "current".
function computeStreaks(counts){
  const dates = Object.keys(counts).sort();
  if(dates.length === 0) return { current: 0, longest: 0 };
  const toDate = s => new Date(s + 'T00:00:00');
  let longest = 1, run = 1;
  for(let i = 1; i < dates.length; i++){
    const gap = Math.round((toDate(dates[i]) - toDate(dates[i-1])) / 86400000);
    run = gap === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  const today = new Date(); today.setHours(0,0,0,0);
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  let anchor = counts[localDateKey(today)] ? today : (counts[localDateKey(yesterday)] ? yesterday : null);
  let current = 0;
  if(anchor){
    const cursor = new Date(anchor);
    while(counts[localDateKey(cursor)]){
      current++;
      cursor.setDate(cursor.getDate() - 1);
    }
  }
  return { current, longest };
}

// GitHub-style grid, but density is carried by the glyph rather than color —
// a fair number of themes here (day/night) render every line in one color, so
// shading has to survive in monochrome. weeks run Monday-Sunday, most recent
// week ending today; any day beyond today (the tail end of this week) is left
// blank rather than drawn as "0 completions".
// three shading levels only (░▒▓) — U+2588 FULL BLOCK was dropped: it comes from
// a different part of the font (webfonts rarely ship Block Elements at all, so
// these fall back to whatever system font has them) and rendered visibly
// shorter than the three shades, which do consistently come from the same
// fallback source together.
const HEATMAP_LEVELS = [' ', '░', '▒', '▓'];
function heatmapGlyph(n){
  if(!n) return HEATMAP_LEVELS[0];
  if(n === 1) return HEATMAP_LEVELS[1];
  if(n <= 3) return HEATMAP_LEVELS[2];
  return HEATMAP_LEVELS[3];
}
const HEATMAP_WEEKS = 10;
const WEEKDAY_LABELS = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
function buildHeatmapRows(counts){
  const today = new Date(); today.setHours(0,0,0,0);
  const daysSinceMonday = (today.getDay() + 6) % 7;
  const weekEnd = new Date(today); weekEnd.setDate(today.getDate() + (6 - daysSinceMonday));   // this week's Sunday
  const start = new Date(weekEnd); start.setDate(weekEnd.getDate() - HEATMAP_WEEKS * 7 + 1);    // Monday, HEATMAP_WEEKS back

  return WEEKDAY_LABELS.map((label, wd) => {
    let line = `${label.padEnd(4)}`;
    for(let w = 0; w < HEATMAP_WEEKS; w++){
      const cell = new Date(start); cell.setDate(start.getDate() + w * 7 + wd);
      line += (cell > today) ? '  ' : `${heatmapGlyph(counts[localDateKey(cell)])} `;
    }
    return { text: line.trimEnd() };
  });
}

function cmd_streak(){
  const counts = completionCounts();
  if(Object.keys(counts).length === 0){ print('no completed tasks yet — finish one to start a streak.', 'info'); return; }
  const { current, longest } = computeStreaks(counts);
  print(current > 0
    ? `you've completed tasks ${current} day${current === 1 ? '' : 's'} running` + (current >= longest ? ' — your best yet.' : ` (longest: ${longest}).`)
    : `no active streak right now — longest ever: ${longest} day${longest === 1 ? '' : 's'}.`, 'ok');
  printFramed(buildHeatmapRows(counts), `  less ${HEATMAP_LEVELS.slice(1).join(' ')} more   (last ${HEATMAP_WEEKS} weeks)`);
}

function cmd_mode(arg){
  if(!arg){ print(`current mode: ${displayMode}  (switch with: mode ascii | mode image)`, 'info'); return; }
  arg = arg.toLowerCase();
  if(!['ascii','image'].includes(arg)){ print('usage: mode ascii|image', 'err'); return; }
  if(arg === displayMode){ print(`already in ${arg} mode`, 'info'); return; }
  displayMode = arg;
  showLiveReveal();   // switching tracks means switching what the panel shows live
  print(`switched to ${arg} mode`, 'ok');
  saveState(); renderPanel();
}

// ---------- image_art folder filtering ----------
// every folder discovered under image_art/, alphabetical — the same order the
// "exclude"/"include" numbers refer to, so a number always means the same
// folder across both commands and across repeat listings in a session.
function allImageFolders(){
  const images = (imageTrack.manifest && imageTrack.manifest.images) || [];
  return Array.from(new Set(images.map(imageFolderOf))).sort();
}

// "3,5" -> [3,5], "1-3" -> [1,2,3], out-of-range numbers are dropped rather
// than erroring — same tolerance splitIds gives task-id ranges.
function parseNumberSelection(str, max){
  const out = [];
  (str || '').split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
    const m = tok.match(/^(\d+)-(\d+)$/);
    if(m){
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if(a > b) [a, b] = [b, a];
      for(let i = a; i <= b; i++) out.push(i);
    } else {
      const n = parseInt(tok, 10);
      if(Number.isFinite(n)) out.push(n);
    }
  });
  return out.filter(n => n >= 1 && n <= max);
}

// the shared listing both bare "include" and bare "exclude" show — doubles as
// the "which folders are included" status view the numbers are picked from.
function printImageFolderList(){
  const folders = allImageFolders();
  const includedCount = folders.filter(f => !excludedImageFolders.includes(f)).length;
  const rows = folders.map((f, i) => {
    const excluded = excludedImageFolders.includes(f);
    return { text: `  ${String(i + 1).padStart(2)}. ${f}${excluded ? '  [excluded]' : ''}`, cls: excluded ? 'info' : undefined };
  });
  printFramed(rows, `  ${includedCount}/${folders.length} included  (exclude <numbers> | include <numbers>)`);
}

// "folders <n>" is the one command: it flips whichever folders you name, since
// what you actually want is nearly always "not this one" / "this one again" and
// which direction that is, is something the app already knows. "exclude"/
// "include" remain for when you want to state the direction outright (handy
// across several folders at once, where some are already in the state you want)
// — all three land here, so there's one implementation of the rule, one guard,
// and one set of messages regardless of which word you typed.
function resolveFolderArgs(tokens, verb){
  const folders = allImageFolders();
  if(folders.length === 0){ print('no image folders found under image_art/.', 'info'); return null; }
  const raw = (tokens || []).join(' ').trim();
  if(!raw){ printImageFolderList(); return null; }
  const nums = parseNumberSelection(raw, folders.length);
  if(nums.length === 0){ print(`usage: ${verb} <numbers 1-${folders.length}>  (bare "${verb}" lists them)`, 'err'); return null; }
  return { folders, chosen: Array.from(new Set(nums.map(n => folders[n - 1]))) };
}
// mode: 'toggle' flips each named folder, 'exclude'/'include' force a direction.
function applyFolderChange(folders, chosen, mode){
  const before = new Set(excludedImageFolders);
  const next = new Set(excludedImageFolders);
  chosen.forEach(f => {
    if(mode === 'exclude') next.add(f);
    else if(mode === 'include') next.delete(f);
    else if(next.has(f)) next.delete(f); else next.add(f);
  });
  // the pool can't be emptied — pickNextEntry would have nothing to choose from,
  // and its fallback (ignore the exclusions entirely) would make the setting a lie.
  if(next.size >= folders.length){ print("can't exclude every folder — at least one has to stay included.", 'err'); return; }
  const nowExcluded = folders.filter(f => next.has(f) && !before.has(f));
  const nowIncluded = folders.filter(f => !next.has(f) && before.has(f));
  if(!nowExcluded.length && !nowIncluded.length){
    print(mode === 'include' ? 'already included.' : 'already excluded.', 'info');
    return;
  }
  excludedImageFolders = folders.filter(f => next.has(f));   // rebuilt in listing order, so the numbers stay meaningful
  if(nowExcluded.length) print(`excluded: ${nowExcluded.join(', ')}`, 'ok');
  if(nowIncluded.length) print(`included: ${nowIncluded.join(', ')}`, 'ok');
  const includedCount = folders.length - excludedImageFolders.length;
  print(`  ${includedCount}/${folders.length} folder${folders.length === 1 ? '' : 's'} in the random pool now`, 'info');
  saveState();
}
function cmd_folders(tokens){
  const args = resolveFolderArgs(tokens, 'folders');
  if(args) applyFolderChange(args.folders, args.chosen, 'toggle');
}
function cmd_include(tokens){
  const args = resolveFolderArgs(tokens, 'include');
  if(args) applyFolderChange(args.folders, args.chosen, 'include');
}
function cmd_exclude(tokens){
  const args = resolveFolderArgs(tokens, 'exclude');
  if(args) applyFolderChange(args.folders, args.chosen, 'exclude');
}

// which panel gets the full-height column of its own. the other one is what
// "split" pins above the console, so the two commands together cover all four
// arrangements without either of them growing a third setting. which *edge* that
// column is against is mirror's business, hence sideEdge/consoleEdge.
function sideName(){ return viewMode === 'tasks' ? 'your task list' : 'the reward art'; }
function stackedName(){ return viewMode === 'tasks' ? 'the reward art' : 'your task list'; }
function sideEdge(){ return mirrored ? 'left' : 'right'; }
function consoleEdge(){ return mirrored ? 'right' : 'left'; }
// on a narrow screen the stylesheet stacks the columns and drops the stacked
// panel entirely (see the max-width breakpoint in momentum.css) — so every
// sentence in this file about left/right columns and what "split" pins is simply
// untrue there. rather than repeat the breakpoint's width as a second copy that
// could drift from the CSS, this asks the browser what the layout actually came
// out as: whatever the media query is doing right now is what these read.
function stackedLayout(){
  const main = document.getElementById('main');
  return !!main && getComputedStyle(main).flexDirection.startsWith('column');
}
function describeLayout(){
  if(stackedLayout()){
    const other = viewMode === 'tasks' ? 'art' : 'tasks';
    return `  ${sideName()} above the console — narrow screen, one panel at a time.`
      + `  ("view ${other}" swaps it for ${stackedName()}.)`;
  }
  return `  ${sideName()} on the ${sideEdge()}, console on the ${consoleEdge()}`
    + (splitOn ? `, ${stackedName()} above it.` : `. "split on" pins ${stackedName()} above the console.`);
}

function cmd_view(arg){
  if(!arg){
    print(`current view: ${viewMode}  (switch with: view art | view tasks)`, 'info');
    print(describeLayout(), 'info');
    return;
  }
  const target = arg.toLowerCase();
  if(!VIEW_MODES.includes(target)){ print(`usage: view <${VIEW_MODES.join('|')}>`, 'err'); return; }
  if(target === viewMode){ print(`already in the ${target} view`, 'info'); return; }
  viewMode = target;
  applyView();
  renderPanel();      // the panel that just became visible was skipped while hidden — rebuild it
  print(stackedLayout()
    ? `view: ${viewMode} — ${sideName()} is the panel above the console now.`
    : `view: ${viewMode} — ${sideName()} now has the ${sideEdge()}-hand column.`, 'ok');
  print(describeLayout(), 'info');
  if(!splitOn && viewMode === 'tasks'){
    print('(the art keeps uncovering while it\'s off screen — "art" reports where it is, "display" shows it full-screen)', 'info');
  }
  saveState();
}

// pins whichever panel *isn't* in the right-hand column above the console — so what
// it shows follows the view rather than being a second thing to keep track of.
function cmd_split(arg){
  if(!arg){
    print(`split view is ${splitOn ? 'on' : 'off'}  (turn it on/off with: split on | split off)`, 'info');
    print(`  in the ${viewMode} view it pins ${stackedName()} above the console.`, 'info');
    return;
  }
  arg = arg.toLowerCase();
  if(!['on','off'].includes(arg)){ print('usage: split on|off', 'err'); return; }
  const want = arg === 'on';
  if(want === splitOn){ print(`split view is already ${arg}`, 'info'); return; }
  splitOn = want;
  applyView();
  renderPanel();      // the panel that just appeared/vanished was skipped while hidden
  print(splitOn
    ? `split view on — ${stackedName()} now stays put above the console. drag the divider between them to resize it.`
    : 'split view off — back to the full-height console.', 'ok');
  // saved either way, so it's already set the way you want it on a wider screen —
  // but on a phone there's only room for one panel and the setting has nothing to
  // show for itself, which is worth saying rather than leaving it looking broken.
  if(stackedLayout()) print('  (no visible change on a screen this narrow — only one panel fits, so it stays hidden until there\'s room for two.)', 'info');
  saveState();
}

// ---------- the on/off display settings ----------
// title, statline, mirror and age were four top-level commands that all said the
// same thing ("show this or don't"), which made four things to remember instead
// of one. they're one registry now, driven by "set <key> on|off", with bare "set"
// printing the lot — so discovering that any of them exist means discovering all
// of them. each entry owns the three things that actually differ between them:
// where the flag lives, what has to be redrawn when it moves, and what to say.
// the old four commands still work (see dispatch) — they delegate straight in
// here rather than keeping a second copy of the logic.
const SETTINGS = {
  title: {
    label: 'the "MOMENTUM" title bar',
    get: () => titleOn,
    apply: v => { titleOn = v; applyTitle(); },
    said: v => v ? 'title bar on.' : 'title bar off — a bit more room for the terminal.',
  },
  statline: {
    // distinct from "stats", which prints a one-off summary into the terminal log:
    // this is the always-visible "N total · N completed · ..." line under the title.
    label: 'the "N total · N completed · ..." line under the title',
    get: () => statLineOn,
    apply: v => { statLineOn = v; applyStatLine(); },
    said: v => v ? 'stat line on.' : 'stat line off — a bit more room for the terminal.',
  },
  mirror: {
    // deliberately independent of "view": that decides *which* panel gets its own
    // column, this only decides which edge that column sits against, so the two
    // compose instead of multiplying into four named layouts.
    label: 'flip the two columns left-for-right',
    get: () => mirrored,
    // the side column keeps the same numeric width whichever edge it's against,
    // so flipping edges alone swings the divider from X% to (100-X)% of the
    // window — a jump. swapping in the complement here means the column that
    // lands on the new edge fills exactly the space the *other* column used to
    // fill there, so the divider itself never moves; only the two panels' contents
    // trade places across it.
    apply: v => {
      mirrored = v;
      const ratio = viewMode === 'tasks' ? taskPaneRatio : artPaneRatio;
      // the divider itself has width (see #col-divider's flex-basis in
      // momentum.css), which the plain 100-minus-ratio complement doesn't
      // account for — left uncorrected, the divider still drifts by that
      // width on every flip. measuring it here keeps the correction exact
      // instead of baking in a guessed constant.
      const main = document.getElementById('main');
      const divider = document.getElementById('col-divider');
      const totalW = main ? main.getBoundingClientRect().width : 0;
      const dividerPct = totalW && divider ? (divider.getBoundingClientRect().width / totalW) * 100 : 0;
      const flipped = Math.min(SIDE_MAX, Math.max(SIDE_MIN, 100 - ratio - dividerPct));
      if(viewMode === 'tasks') taskPaneRatio = flipped; else artPaneRatio = flipped;
      applyView();
    },
    // there are no left and right columns to trade while the layout is stacked,
    // so the flag is recorded for a wider screen and says so instead of claiming
    // a move you can't see happen.
    said: v => stackedLayout()
      ? `${v ? 'mirrored' : 'unmirrored'} — saved, but there's only one column on a screen this narrow, so nothing moves until there's room for two.`
      : v
        ? `mirrored — ${sideName()} is on the left now, the console on the right.`
        : `unmirrored — ${sideName()} is back on the right.`,
  },
  age: {
    label: '"[3d ago]" on each task\'s details line',
    get: () => showAge,
    apply: v => { showAge = v; renderPanel(); },
    said: v => v
      ? 'task age on — the details line now shows how long ago each task was created.'
      : 'task age off.',
  },
};
const SETTING_VALUES = ['on', 'off', 'toggle'];

// ---------- the on/off feature flags ----------
// same shape as SETTINGS above, and reached through the same "set" command, but a
// different kind of thing: SETTINGS decide how the app *looks*, these decide which
// halves of it *exist*. they're listed as their own block in the overview for that
// reason — switching the title bar off is cosmetic, switching due dates off changes
// what a task is.
// see the FEATURE_KEYS comment in app-state.js for the contract each one keeps;
// the short version is that nothing is deleted, so "off" is always reversible.
const FEATURES = {
  priority: {
    label: 'the [high|med|low] field — its command, -p flag, and its place in the sort',
    get: () => featureOn('priority'),
    apply: v => { features.priority = v; renderPanel(); },
    said: v => v
      ? 'priority on — every task that had one still has it.'
      : 'priority off — the command, the -p flag and the [high|med|low] field are gone from the list. nothing was deleted: switch it back on and every task has its priority again.',
  },
  due: {
    label: 'due dates — the command, -d flag, [due:…] field and the overdue marker',
    get: () => featureOn('due'),
    apply: v => { features.due = v; renderPanel(); },
    said: v => v
      ? 'due dates on — every date that was set is still set.'
      : 'due dates off — no more [due:…], no [OVERDUE], and overdue tasks stop sorting to the top. the dates themselves are kept.',
  },
  est: {
    label: 'estimates — the est command, -est flag, [est] field and the list total',
    get: () => featureOn('est'),
    apply: v => { features.est = v; renderPanel(); },
    said: v => v
      ? 'estimates on — every estimate that was set is still set.'
      : 'estimates off — no more [est:…] and no total on the list. the estimates themselves are kept.',
  },
  tags: {
    label: 'tags — the tag/tags commands, -t flag and filter, and the [tag] fields',
    get: () => featureOn('tags'),
    apply: v => { features.tags = v; renderPanel(); },
    said: v => v
      ? 'tags on — every tag that was set is still set.'
      : 'tags off — the tag commands and -t filter are gone, and tags stop showing on the list. they stay on the tasks that had them.',
  },
  projects: {
    label: 'projects — the project command, -proj flag and filter, and the [project] field',
    get: () => featureOn('projects'),
    apply: v => { features.projects = v; renderPanel(); updateStats(); },
    said: v => v
      ? 'projects on — your project list and every assignment are still there.'
      : 'projects off — the project commands and -proj filter are gone, and projects stop showing on the list or the stat line. nothing was deleted.',
  },
  streak: {
    label: 'the "streak" command and its completion heatmap',
    get: () => featureOn('streak'),
    apply: v => { features.streak = v; },
    said: v => v ? 'streak on.' : 'streak off — your completion history is untouched, just not reported.',
  },
};

// "set" covers both registries, so there's one command and one overview rather
// than two near-identical ones. a key can't sit in both — this is the guard that
// says so out loud if one ever gets added to both by mistake.
function settingEntry(key){ return SETTINGS[key] || FEATURES[key]; }

// the one rendering of "here is every switch and where it stands", printed by bare
// "set" and by "help set" alike — so the two can't drift into describing the same
// switches differently, and so the help row doesn't have to carry a list of keys
// that goes stale the moment one is added.
//
// state reads first, in a fixed-width bracket, because that's the column you scan:
// down the left edge, every [on ]/[off] lines up regardless of how long the key
// next to it is. brackets rather than bare words to match the [tag]/[active]/
// [OVERDUE] fields the task list already uses. an off row prints dim, so the
// switched-on half reads first — the same brightness ranking the rest of the
// terminal uses, and the only one available when a theme is a single colour.
function printSettingsOverview(){
  const w = Math.max(...[...Object.keys(SETTINGS), ...Object.keys(FEATURES)].map(k => k.length));
  const block = (heading, note, registry) => {
    print('');
    printSegments([{ text: `  ${heading}` }, ...(note ? [{ text: `   ${note}`, cls: 'info' }] : [])]);
    Object.keys(registry).forEach(k => {
      const on = registry[k].get();
      printSegments([
        { text: `    [${on ? 'on ' : 'off'}]  ${k.padEnd(w)}   `, cls: on ? undefined : 'info' },
        { text: registry[k].label, cls: 'info' },
      ], w + 12);
    });
  };
  block('display', 'how the app looks', SETTINGS);
  block('features', 'switching one off hides its commands and fields, but deletes nothing', FEATURES);
}

function cmd_set(key, value){
  const keys = [...Object.keys(SETTINGS), ...Object.keys(FEATURES)];

  // bare "set" — the whole point of folding these together: one place that shows
  // every flag and its current state at once. the two registries print as separate
  // blocks because they answer different questions ("how does it look" vs "what's
  // switched on"), and an off row prints dim so the on ones read first — the same
  // brightness ranking the rest of the terminal uses, and the only one available
  // when every theme is a single colour.
  if(!key){
    print('settings  —  change one with:  set <key> on|off');
    printSettingsOverview();
    return;
  }

  key = key.toLowerCase();
  const setting = settingEntry(key);
  if(!setting){
    // same did-you-mean treatment unknown commands get — a mistyped key is the
    // same kind of mistake and deserves the same help.
    let guess = null, best = Infinity;
    keys.forEach(k => { const d = editDistance(key, k); if(d < best){ best = d; guess = k; } });
    if(best > (key.length <= 4 ? 1 : 2)) guess = null;
    print(`no setting "${key}"${guess ? ` — did you mean "${guess}"?` : ''}`, 'err');
    print(`  display:  ${Object.keys(SETTINGS).join(', ')}`, 'info');
    print(`  features: ${Object.keys(FEATURES).join(', ')}`, 'info');
    print('  ("set" alone shows them all with their current state)', 'info');
    return;
  }

  const current = setting.get();
  if(!value){
    print(`${key} is ${current ? 'on' : 'off'}  —  ${setting.label}  (change with: set ${key} ${current ? 'off' : 'on'})`, 'info');
    return;
  }
  const v = value.toLowerCase();
  if(!SETTING_VALUES.includes(v)){ print(`usage: set ${key} <${SETTING_VALUES.join('|')}>`, 'err'); return; }
  const want = v === 'toggle' ? !current : v === 'on';
  if(want === current){ print(`${key} is already ${current ? 'on' : 'off'}`, 'info'); return; }
  setting.apply(want);
  print(setting.said(want), 'ok');
  saveState();
}

// renamed from "switch": every other setting command in the app is named after
// the thing it changes, and "switch" was named after the act of changing. the old
// word still works (see SPELLINGS), as do the classic nightmode/daymode.
function cmd_theme(arg){
  if(!arg){ print(`current theme: ${theme}  (change with: theme <${THEMES.join('|')}>, or the classic theme nightmode|daymode)`, 'info'); return; }
  const target = THEME_ALIASES[arg.toLowerCase()] || arg.toLowerCase();
  if(!THEMES.includes(target)){ print(`usage: theme <${THEMES.join('|')}>`, 'err'); return; }
  if(target === theme){ print(`already in ${target} mode`, 'info'); return; }
  theme = target;
  applyTheme();
  print(`switched to ${theme} mode.`, 'ok');
  saveState();
}

// ---------- font ----------
// "font" alone prints a numbered menu and "font 3" picks from it, rather than
// "font <name>" only: the names are the one thing you can't be expected to know
// (which of these does this machine even have?), so the command has to answer that
// before it can ask you to choose. the number is a handle onto the list you're
// looking at, exactly like "gallery show 3" is.
//
// the list is filtered to fonts that are actually present and actually fixed-width
// — see fontAvailable/isMonospace. offering one that isn't installed would mean
// picking it silently changed nothing, and offering a proportional one would mean
// picking it broke the ascii art; neither is a choice worth putting in front of
// someone. a name typed directly still works for anything the browser can resolve,
// which is the escape hatch for a font this list didn't think to include.
//
// bundled families skip the availability probe, and have to: a browser only
// downloads a webfont once something on the page is actually rendered in it, so
// measuring one you haven't selected yet returns the *fallback's* metrics and reads
// as "not installed" — which would have hidden every bundled font except the one
// already in use, i.e. exactly the ones you'd want to switch to. the manifest is
// the authority for those anyway: they ship in the folder, so they exist.
// isMonospace still applies to them, and is truthful because installBundledFonts
// pre-loads the faces at boot.
function selectableFonts(){
  return allFonts().filter(f => (f.bundled || fontAvailable(f.family)) && isMonospace(f.family));
}

function cmd_font(arg){
  const list = selectableFonts();

  // "font size ..." is a subcommand rather than its own top-level word, for the
  // reason "block size"/"block count" already are: face and size are the two halves
  // of one question ("what does the text look like"), and splitting them across two
  // commands means finding out about one of them tells you nothing about the other.
  const words = String(arg || '').trim().split(/\s+/);
  const sub = (words[0] || '').toLowerCase();
  if(sub === 'size') return cmd_fontSize(words.slice(1).join(' '));
  if(sub === 'info') return cmd_fontInfo();
  // stepping, both directions. cycling forward is the whole point — trying fonts on
  // is a browsing motion, not a lookup one, and "font next" a dozen times is how you
  // find the one you like — but overshooting by one is then the obvious next
  // frustration, so back is here too rather than making you go round again.
  if(['next','n','forward','+'].includes(sub)) return stepFont(1);
  if(['prev','previous','p','back','-'].includes(sub)) return stepFont(-1);

  if(!arg){
    print('fonts  —  pick one with:  font <number>');
    // headings from the fonts/ subfolders, plus one for whatever the machine
    // brought. two dozen names in a single column is a wall you read all of to
    // find any of it — the same reason "help" is grouped rather than flat — and
    // these categories are the axis you'd actually choose along ("something
    // retro") rather than an alphabet you'd have to already know your way around.
    const w = String(list.length).length;
    let heading = null;
    list.forEach((f, i) => {
      const group = f.bundled ? (f.category || 'bundled') : 'on this computer';
      if(group !== heading){
        heading = group;
        print('');
        print(`  ${group}`, 'info');
      }
      const here = f.id === fontId;
      printSegments([
        { text: `  ${String(i + 1).padStart(w)}.  `, cls: here ? undefined : 'info' },
        { text: f.name, cls: here ? 'ok' : undefined },
        { text: here ? '   ← current' : '', cls: 'info' },
      ], w + 6);
    });
    print('');
    printHanging('the grouped ones ship with the app and look the same everywhere; the last group is whatever this computer already has.', 0, 'info');
    // the folder is the point of the feature, so the list says how to grow it
    // rather than leaving that in the README only.
    printHanging('to add your own: drop a .woff2 into fonts/, run "python3 build_font_data.py", reload.', 0, 'info');
    printHanging('text too big or small? "font size 16".', 0, 'info');
    return;
  }

  const raw = String(arg).trim();
  // a number is an index into what was just printed; anything else is a name.
  const n = /^\d+$/.test(raw) ? Number(raw) : null;
  if(n !== null){
    if(n < 1 || n > list.length){
      print(`there's no font ${n} — the list runs 1 to ${list.length}. "font" prints it.`, 'err');
      return;
    }
    return setFont(list[n - 1]);
  }

  const key = raw.toLowerCase();
  const found = allFonts().find(f => f.id === key || f.name.toLowerCase() === key);
  if(found){
    if(!fontAvailable(found.family)){
      print(`"${found.name}" isn't installed on this computer, so picking it would change nothing.`, 'err');
      print('  "font" lists the ones that are.', 'info');
      return;
    }
    return setFont(found);
  }

  // not in the list, but the browser may still know it — a font this app has never
  // heard of is a perfectly good answer to "what do you want to read in", so it's
  // tried rather than refused. the two checks it has to clear are the same two the
  // list is filtered on, just reported instead of silently applied.
  if(!fontAvailable(raw)){
    // the same did-you-mean bar suggestCommand and cmd_set use, over the font
    // names instead of the command names.
    let guess = null, best = Infinity;
    list.forEach(f => { const d = editDistance(key, f.name.toLowerCase()); if(d < best){ best = d; guess = f.name; } });
    if(best > (key.length <= 4 ? 1 : 2)) guess = null;
    print(`no font "${raw}" here${guess ? ` — did you mean "${guess}"?` : ' — and this computer doesn\'t have one by that name either.'}`, 'err');
    if(!guess) print('  "font" lists what\'s available.', 'info');
    return;
  }
  // recorded as *the* custom font before setFont runs, since that's what makes
  // fontEntry able to resolve it a moment later — and what makes it survive a
  // reload. the name keeps the capitalisation you typed; only the id is lowered,
  // so picking the same font twice is recognised however you spell it.
  customFont = { id: key, name: raw, family: raw };
  setFont(customFont, !isMonospace(raw));
}

// "font size" — the number is the app's body text size in px, which is the one you
// actually read; everything else on screen is drawn in proportion to it and moves
// with it (see --font-scale). relative steps are here too because "a bit bigger" is
// the actual thought most of the time, and making you first find out what the
// current number is just to add two to it is a step for nothing.
function cmd_fontSize(arg){
  const raw = String(arg || '').trim().toLowerCase();

  if(!raw){
    print(`font size: ${fontSize}px${fontSize === FONT_SIZE_DEFAULT ? ' (the default)' : ''}`, 'info');
    printHanging(`  set it with:  font size <${FONT_SIZE_MIN}-${FONT_SIZE_MAX}>  ·  font size +2  ·  font size -2  ·  font size reset`, 2, 'info');
    return;
  }

  if(['reset','default','auto'].includes(raw)) return setFontSize(FONT_SIZE_DEFAULT, 'reset');

  // "+2" / "-2" step from where you are; a bare number is the size itself. the sign
  // is what tells them apart, so "+13" and "13" mean genuinely different things —
  // which is why the relative form requires the + rather than accepting it either way.
  const rel = raw.match(/^([+-])\s*(\d+)$/);
  if(rel){
    const delta = Number(rel[2]) * (rel[1] === '-' ? -1 : 1);
    const target = fontSize + delta;
    // clamping silently would make a repeated "font size +2" look like it stopped
    // working for no reason, so hitting the end of the range says so.
    if(target < FONT_SIZE_MIN || target > FONT_SIZE_MAX){
      const edge = target < FONT_SIZE_MIN ? FONT_SIZE_MIN : FONT_SIZE_MAX;
      if(fontSize === edge){ print(`already at ${edge}px, which is as ${target < FONT_SIZE_MIN ? 'small' : 'large'} as it goes.`, 'info'); return; }
      return setFontSize(edge);
    }
    return setFontSize(target);
  }

  const n = raw.match(/^(\d+)(?:px)?$/);
  if(!n){
    print(`"${arg}" isn't a font size — give a number, e.g. font size 16 (or +2 / -2 / reset)`, 'err');
    return;
  }
  const size = Number(n[1]);
  if(size < FONT_SIZE_MIN || size > FONT_SIZE_MAX){
    print(`font size runs ${FONT_SIZE_MIN} to ${FONT_SIZE_MAX} — ${size} is outside it.`, 'err');
    print(`  below ${FONT_SIZE_MIN} the details line stops being legible; above ${FONT_SIZE_MAX} task titles stop fitting the pane.`, 'info');
    return;
  }
  setFontSize(size);
}

function setFontSize(size, how){
  if(size === fontSize){
    print(how === 'reset' ? `already at the default ${size}px.` : `already at ${size}px.`, 'info');
    return;
  }
  fontSize = size;
  applyFontScale();
  print(`font size: ${size}px${how === 'reset' ? ' (the default)' : ''}`, 'ok');
  // the reveal grid is measured in character cells, so a size change moves every
  // one of them — the panel has to be rebuilt at the new metrics rather than left
  // showing a grid computed for the old size.
  renderPanel();
  saveState();
}

// the one place the font actually changes, so every route in (number, name, or a
// family only the browser knows about) leaves the same state behind and says the
// same thing.
// one step through the list "font" prints, wrapping at both ends. wrapping rather
// than stopping because there's no meaningful "last" font — the order is alphabetical
// within folders, so an end of the list isn't a destination, it's just where the
// alphabet ran out, and stopping dead there would read as broken.
//
// the number is echoed along with the name so a browse leaves you knowing where you
// landed: after eight "font next" presses, "12/25" is what lets you type "font 12"
// tomorrow instead of pressing it eight more times.
function stepFont(dir){
  const list = selectableFonts();
  if(list.length < 2){ print('there\'s only one font available, so there\'s nothing to step to.', 'info'); return; }
  // a font set by name that isn't in the list has no position to step from, so a
  // step lands at the start rather than nowhere.
  const at = list.findIndex(f => f.id === fontId);
  const next = at === -1 ? 0 : (at + dir + list.length) % list.length;
  const entry = list[next];
  fontId = entry.id;
  applyFont();
  printSegments([
    { text: `font: ${entry.name}` },
    { text: `   ${next + 1}/${list.length}${entry.category ? ` · ${entry.category}` : ''}`, cls: 'info' },
  ]);
  renderPanel();
  saveState();
}

// "font info" — what you're looking at right now, in one block. the category is
// here because it's the half of a font's identity the name doesn't carry: "Nova
// Mono" tells you nothing about it being the futuristic one, and that's exactly
// the thing you'd want to know when deciding whether to keep browsing.
function cmd_fontInfo(){
  const list = selectableFonts();
  const entry = fontEntry(fontId) || { id: fontId, name: fontId, family: fontId };
  const at = list.findIndex(f => f.id === fontId);
  // "is it in the list" has to be asked of allFonts directly rather than through
  // fontEntry, which also resolves the typed-in custom font — the whole point of
  // this row is telling those two apart.
  const listed = allFonts().some(f => f.id === fontId);
  const rows = [
    ['name', entry.name],
    ['style', entry.category || (entry.bundled ? 'uncategorised' : 'no category — a plain system face')],
    ['source', entry.bundled ? 'bundled with the app (fonts/)'
             : listed        ? 'installed on this computer'
             :                 'installed on this computer, typed in by name (not in the list)'],
    ['size', `${fontSize}px${fontSize === FONT_SIZE_DEFAULT ? '  (the default)' : ''}`],
  ];
  // weights only when there's more than one, since "weights: 400" is a fact about
  // every font that has ever existed and tells you nothing.
  const files = ((window.FONT_DATA && window.FONT_DATA.families) || []).find(f => f.id === entry.id);
  if(files && files.files && files.files.length > 1){
    rows.push(['weights', [...new Set(files.files.map(f => f.weight))].sort((a,b)=>a-b).join(', ')]);
  }
  if(at !== -1) rows.push(['in the list', `${at + 1} of ${list.length}   ("font ${at + 1}" comes back here)`]);
  if(!isMonospace(entry.family)) rows.push(['note', 'not fixed-width — the ascii art and [id] columns will look ragged']);

  const w = Math.max(...rows.map(r => r[0].length));
  rows.forEach(([k, v]) => printSegments([
    { text: `  ${k.padEnd(w)}   `, cls: 'info' },
    { text: v, cls: k === 'note' ? 'err' : undefined },
  ], w + 5));
}

function setFont(entry, proportional){
  if(entry.id === fontId){ print(`already using ${entry.name}.`, 'info'); return; }
  fontId = entry.id;
  applyFont();
  print(`font: ${entry.name}.`, 'ok');
  // a warning rather than a refusal — it's your app to make ugly if you want. but
  // it has to be said out loud, because the damage shows up in the reveal panel
  // rather than in the text you were looking at when you typed this, and "my ascii
  // art went crooked" is a hard thing to connect back to a font you set earlier.
  if(proportional){
    printHanging(`heads up: ${entry.name} isn't fixed-width, so the ascii art and the aligned [id] columns will look ragged. "font 1" puts it back.`, 0, 'err');
  }
  renderPanel();
  saveState();
}

// "art ..." acts on whichever track is currently active (ascii or image) — same
// command regardless of mode, per the user's own framing: it just targets whatever
// you're currently looking at. it's called "art" rather than "image" precisely
// because of that: "image reveal" while in ascii mode read as a mode mismatch when
// it was really doing the right thing. "image" still works as an alias.
function printCompletionPrompt(art){
  const kind = displayMode === 'image' ? 'Image' : 'Artwork';
  print(`${kind} completed! "${art.name}" is fully revealed.`, 'ok');
  print('What do you want to do?', 'info');
  print('  close     (save it, start a new one — also: save)', 'info');
  print('  skip      (discard it, no gallery credit, start a new one)', 'info');
  print('  download  (save the file to your computer)', 'info');
  if(displayMode === 'ascii') print('  copy      (copy the ascii text to your clipboard)', 'info');
  print('  display   (see it fullscreen — esc/click to exit)', 'info');
}

function slugify(name){
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'artwork';
}

function triggerDownload(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// "art" only reports status now — next/reveal/hide used to be sub-commands of it
// ("art next", "art reveal", "art hide") but that made three of the most-typed
// commands in the app three keystrokes longer than they needed to be, so they're
// top-level commands of their own. all four still act on whichever track (ascii or
// image) is currently active.
function cmd_art(){
  const track = activeTrack();
  if(!track.current){ print(`the ${displayMode} collection is still loading...`, 'info'); return; }
  const total = track.totalCells();
  const unit = displayMode === 'image' ? 'tiles' : 'characters';
  const pct = total ? Math.round(track.progress.revealedCount / total * 100) : 0;
  const pendingTxt = track.pending ? '  —  COMPLETE, waiting on close/download' : '';
  const gridTxt = displayMode === 'image' ? `  —  grid ${track.current.cols}x${track.current.rows}` : '';
  print(`[${displayMode}] ${track.current.name}  —  ${track.progress.revealedCount}/${total} ${unit} (${pct}%)${gridTxt}  —  category:${track.current.category || '-'}  —  ${track.tasksToFullyReveal()} tasks to fully reveal${pendingTxt}`);
}
async function cmd_next(){
  const track = activeTrack();
  if(!track.current){ print(`the ${displayMode} collection is still loading...`, 'info'); return; }
  const was = track.current.name;
  await track.startNew();
  showLiveReveal();   // you're skipping to a new piece — that's the thing to show
  print(`skipped "${was}" without collecting it — now revealing "${track.current.name}"`, 'info');
  const spent = await track.applyBanked(art => printCompletionPrompt(art));
  if(spent) print(`(spent ${spent} banked completion${spent === 1 ? '' : 's'} on it)`, 'info');
  saveState(); renderPanel();
}
async function cmd_reveal(){
  const track = activeTrack();
  if(!track.current){ print(`the ${displayMode} collection is still loading...`, 'info'); return; }
  const total = track.totalCells();
  if(track.pending){ print(`"${track.current.name}" is already fully revealed — type "close" or "download"`, 'err'); return; }
  showLiveReveal();
  await track.reveal(total - track.progress.revealedCount, art => {
    print('(cheat)', 'info');
    printCompletionPrompt(art);
  });
  saveState(); renderPanel();
}
function cmd_hide(){
  const track = activeTrack();
  if(!track.current){ print(`the ${displayMode} collection is still loading...`, 'info'); return; }
  track.progress.revealedCount = 0;
  track.pending = false;
  showLiveReveal();
  print(`"${track.current.name}" hidden again — back to 0%`, 'ok');
  saveState(); renderPanel();
}

// ---------- reveal grid ----------
// how big the blocks are and how many there are are the same setting seen from two
// sides — cols x rows fixes both — so this is one command with three notations
// rather than three commands that could disagree with each other.
// ---------- block size / block count ----------
// "block <size|count> ..." — two settings for how the image reveal is divided up.
// size is how many blocks the image is cut into (six named tiers, computed per
// image); count is how many blocks one completed task uncovers. both are
// image-only: ascii uncovers character by character and has no block grid to tune.
function cmd_block(sub, args){
  sub = (sub || '').toLowerCase();
  if(sub === 'size') return cmd_blockSize(args);
  if(sub === 'count') return cmd_blockCount(args[0]);
  print('usage: block size <tier>  |  block count <n>', 'err');
}

function describeBlockSize(){
  if(!blockSizePref) return 'medium (the manifest default)';
  const tier = Object.values(BLOCK_SIZE_TIERS).find(t => t.n === blockSizePref.n);
  return tier ? tier.label : `custom (${blockSizePref.n} blocks)`;
}
async function printBlockSizeInfo(art){
  const dims = await imageDims(art.file);
  const total = art.cols * art.rows;
  const srcW = Math.round(dims.w / art.cols), srcH = Math.round(dims.h / art.rows);
  print(`block size: ${describeBlockSize()}  —  ${art.cols}x${art.rows} grid  —  ${total} block${total === 1 ? '' : 's'}  —  each ${srcW}x${srcH}px of the source image`);
}
// names come in with or without a space/hyphen ("very small", "very-small",
// "verysmall") — collapsing that before matching means the tokenizer splitting
// "very small" into two words costs nothing extra here.
function cmd_blockSize(args){
  if(displayMode !== 'image'){
    print('block size is an image-mode setting — ascii art uncovers character by character, so it has no blocks. switch with "mode image".', 'err');
    return;
  }
  const track = imageTrack;
  if(!track.current){ print('the image collection is still loading...', 'info'); return; }
  const art = track.current;
  if(!args.length) return printBlockSizeInfo(art);

  const norm = args.join(' ').toLowerCase().replace(/[\s-]+/g, '');
  let pref;
  if(['medium','auto','reset','default'].includes(norm)) pref = null;
  else if(BLOCK_SIZE_TIERS[norm]) pref = { n: BLOCK_SIZE_TIERS[norm].n };
  else { print('usage: block size <very small|small|medium|big|very big|full>', 'err'); return; }

  return applyBlockSize(pref, art, track);
}
async function applyBlockSize(pref, art, track){
  const wasPref = blockSizePref;
  blockSizePref = pref;
  const from = { cols: art.cols, rows: art.rows };
  const to = await resolveGrid({ file: art.file, grid: art.declaredGrid });
  if(to.cols === from.cols && to.rows === from.rows){
    // the preference can move without this particular image moving with it — "big"
    // and this image's own manifest grid can land on the same numbers. saying only
    // "nothing to change" would be a lie by omission the moment the next image loads.
    if(JSON.stringify(wasPref) !== JSON.stringify(blockSizePref)){
      saveState();
      print(`this image was already ${from.cols}x${from.rows}, so it looks unchanged — but block size is now ${describeBlockSize()}, and other images will follow it.`, 'ok');
    } else {
      print(`block size is already ${describeBlockSize()} — nothing to change`, 'info');
    }
    return;
  }

  const beforeCount = track.progress.revealedCount, beforeTotal = from.cols * from.rows;
  const oldOrder = materializeOrder(track.progress, beforeTotal);
  art.cols = to.cols; art.rows = to.rows;
  Object.assign(track.progress, remapReveal(oldOrder, beforeCount, from, to, track.pending));
  showLiveReveal();   // the whole point of resizing the grid is to look at the result
  saveState(); renderPanel();

  const afterTotal = to.cols * to.rows;
  const pct = (n, d) => d ? Math.round(n / d * 100) : 0;
  print(`block size: ${describeBlockSize()}  —  ${from.cols}x${from.rows} → ${to.cols}x${to.rows}  (${beforeTotal} → ${afterTotal} blocks)`, 'ok');
  if(beforeCount > 0){
    print(`kept what you'd uncovered: ${beforeCount}/${beforeTotal} (${pct(beforeCount, beforeTotal)}%) → ${track.progress.revealedCount}/${afterTotal} (${pct(track.progress.revealedCount, afterTotal)}%) — same region, new block size`, 'info');
  }
}

function cmd_blockCount(arg){
  if(displayMode !== 'image'){
    print('block count is an image-mode setting — ascii art uncovers character by character, so it has no blocks. switch with "mode image".', 'err');
    return;
  }
  const track = imageTrack;
  if(!track.current){ print('the image collection is still loading...', 'info'); return; }
  const describe = () => {
    const per = track.cellsPerCompletion();
    const src = blockCountOverride ? 'your setting, for every image' : "this image's own pace, from the manifest";
    print(`${per} block${per === 1 ? '' : 's'} uncovered per completed task  —  ${track.tasksToFullyReveal()} tasks to fully reveal "${track.current.name}"  (${src})`);
  };
  if(!arg){ describe(); return; }

  arg = arg.toLowerCase();
  let next;
  if(/^(auto|reset|off|manifest|default)$/.test(arg)) next = null;
  else if(/^\d+$/.test(arg) && +arg >= 1) next = Math.min(BLOCK_COUNT_MAX, +arg);
  else { print(`usage: block count <1-${BLOCK_COUNT_MAX}> | auto`, 'err'); return; }
  if(/^\d+$/.test(arg) && +arg > BLOCK_COUNT_MAX){
    print(`capped at ${BLOCK_COUNT_MAX} — past that one task clears too much of the image at once`, 'info');
  }

  blockCountOverride = next;
  showLiveReveal();
  saveState(); renderPanel();
  print(next ? `block count set: ${next} block${next === 1 ? '' : 's'} per completed task` : "block count back to each image's own pace", 'ok');
  describe();
}

// ---------- character count ----------
// ascii's equivalent of "block count": how many characters one completed task
// uncovers. no "character size" alongside it — a block's size is a choice (how
// finely to grid the image), but an ascii piece's cells are just its own non-space
// characters, nothing to tune there.
function cmd_character(sub, args){
  sub = (sub || '').toLowerCase();
  if(sub === 'count') return cmd_charCount(args[0]);
  print(`usage: character count <1-${CHAR_COUNT_MAX}>|all|auto`, 'err');
}
function cmd_charCount(arg){
  if(displayMode !== 'ascii'){
    print('character count is an ascii-mode setting — images uncover in blocks, tuned with "block count". switch with "mode ascii".', 'err');
    return;
  }
  const track = asciiTrack;
  if(!track.current){ print('the art collection is still loading...', 'info'); return; }
  const describe = () => {
    const per = track.cellsPerCompletion();
    const src = charCountOverride === 'all' ? 'your setting: every completed task fully reveals the piece'
      : charCountOverride ? 'your setting, for every piece'
      : "this piece's own pace, from the manifest";
    print(`${per} character${per === 1 ? '' : 's'} uncovered per completed task  —  ${track.tasksToFullyReveal()} tasks to fully reveal "${track.current.name}"  (${src})`);
  };
  if(!arg){ describe(); return; }

  arg = arg.toLowerCase();
  let next;
  if(/^(auto|reset|off|manifest|default)$/.test(arg)) next = null;
  else if(arg === 'all') next = 'all';
  else if(/^\d+$/.test(arg) && +arg >= 1) next = Math.min(CHAR_COUNT_MAX, +arg);
  else { print(`usage: character count <1-${CHAR_COUNT_MAX}>|all|auto`, 'err'); return; }
  if(/^\d+$/.test(arg) && +arg > CHAR_COUNT_MAX){
    print(`capped at ${CHAR_COUNT_MAX} — past that use "character count all" to fully reveal every task instead`, 'info');
  }

  charCountOverride = next;
  showLiveReveal();
  saveState(); renderPanel();
  print(next === 'all' ? 'character count set: every completed task fully reveals the piece'
    : next ? `character count set: ${next} character${next === 1 ? '' : 's'} per completed task`
    : "character count back to each piece's own pace", 'ok');
  describe();
}

async function cmd_close(){
  const track = activeTrack();
  if(!track.pending){ print('nothing to close right now', 'err'); return; }
  const finished = await track.closePending();
  showLiveReveal();   // the new piece just started is the thing to look at now
  print(`closed "${finished.name}" — added to your collection. now revealing "${track.current.name}".`, 'ok');
  const spent = await track.applyBanked(art => printCompletionPrompt(art));
  if(spent) print(`...and spent ${spent} banked completion${spent === 1 ? '' : 's'} on it right away.`, 'ok');
  saveState(); renderPanel();
}

// shared by "download" (the in-progress piece) and "download <n|name>" (an
// already-collected one) — same two file shapes either way. for an image,
// `source` is its path under image_art/, downloaded via a direct <a download>
// to that path rather than a fetch()+blob round trip — fetch() of a local file
// is blocked outright when this page is opened via file:// (see art-data.js),
// but the browser's native download of a same-origin/local resource works
// either way. for ascii, `source` is the already-loaded, rectangle-padded text.
function triggerArtDownload(type, name, source){
  if(type === 'image'){
    const ext = source.split('.').pop();
    const a = document.createElement('a');
    a.href = 'image_art/' + source;
    a.download = `${slugify(name)}.${ext}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } else {
    const blob = new Blob([source], { type:'text/plain' });
    triggerDownload(blob, `${slugify(name)}.txt`);
  }
}

// downloads a piece already sitting in the gallery, resolved the same way
// "gallery show"/"gallery display" resolve their own argument — a number first
// (whatever "gallery" last showed on screen), a name as the fallback.
async function downloadCollected(arg){
  const all = collectedGalleryList();
  if(all.length === 0){ print('no artworks collected yet — keep completing tasks!', 'info'); return; }
  const idx = resolveGalleryArg(arg, all);
  if(idx === -1){ print(`"${arg}" isn't in your collection yet — "gallery" lists what you've got, by number.`, 'err'); return; }
  const item = all[idx];
  const entry = galleryManifestEntry(item);
  if(!entry){ print(`the source file for "${item.name}" is missing — it can't be downloaded.`, 'err'); return; }
  try{
    if(item.type === 'image'){
      triggerArtDownload('image', item.name, entry.file);
    } else {
      const art = await loadArtworkFile(entry);
      triggerArtDownload('ascii', item.name, asciiArtText(art));
    }
    print(`downloading "${item.name}"...`, 'ok');
  }catch(e){
    print('could not download the file', 'err');
  }
}

async function cmd_download(arg){
  const argTrim = (arg || '').trim();
  if(argTrim) return downloadCollected(argTrim);
  const track = activeTrack();
  if(!track.pending){ print('nothing to download right now — or pass a gallery number/name, e.g. "download 3"', 'err'); return; }
  const art = track.current;
  try{
    triggerArtDownload(displayMode, art.name, displayMode === 'image' ? art.file : asciiArtText(art));
    print(`downloading "${art.name}"... type "close" when you're ready for a new one.`, 'ok');
  }catch(e){
    print('could not download the file', 'err');
  }
}

// ---------- copy ascii art to clipboard ----------
// text only — an image has nothing sensible to "copy" as text, "download" is
// its equivalent. tries the modern async Clipboard API first, and falls back
// to the old execCommand('copy') trick (a temporary, off-screen, selected
// <textarea>) when that's missing or refuses — some file:// origins, older
// browsers, or a permission the user's declined. returns whether it worked
// rather than throwing, so callers report success/failure without a try/catch
// of their own.
async function copyTextToClipboard(text){
  if(navigator.clipboard && navigator.clipboard.writeText){
    try{ await navigator.clipboard.writeText(text); return true; }catch(e){ /* fall through to the legacy path below */ }
  }
  try{
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    cmdInput.focus();
    return ok;
  }catch(e){
    return false;
  }
}
async function copyTextAndReport(text, name){
  const ok = await copyTextToClipboard(text);
  if(ok) print(`copied "${name}" to your clipboard.`, 'ok');
  else print('could not copy to clipboard — your browser may be blocking clipboard access here.', 'err');
}
// shared by bare "copy" (when a gallery detail view is open) and "copy <n|name>" —
// same type check and missing-file guard "download" uses on the same item.
async function copyGalleryItem(item){
  if(item.type !== 'ascii'){ print('only ascii pieces can be copied as text — "download" saves an image file instead.', 'err'); return; }
  const entry = galleryManifestEntry(item);
  if(!entry){ print(`the source file for "${item.name}" is missing — it can't be copied.`, 'err'); return; }
  const art = await loadArtworkFile(entry);
  await copyTextAndReport(asciiArtText(art), item.name);
}
async function copyCollected(arg){
  const all = collectedGalleryList();
  if(all.length === 0){ print('no artworks collected yet — keep completing tasks!', 'info'); return; }
  const idx = resolveGalleryArg(arg, all);
  if(idx === -1){ print(`"${arg}" isn't in your collection yet — "gallery" lists what you've got, by number.`, 'err'); return; }
  await copyGalleryItem(all[idx]);
}
// bare "copy" acts on whatever ascii piece is actually in view: an open gallery
// detail view first (it's always fully revealed, so there's no "wait until
// it's done" gate there), otherwise the live piece — which does need that gate,
// same as "download" — a partial reveal is mostly blank space, not something
// worth putting on the clipboard.
async function cmd_copy(arg){
  const argTrim = (arg || '').trim();
  if(argTrim) return copyCollected(argTrim);
  if(galleryOpen && galleryDetailIdx != null){
    const all = collectedGalleryList();
    const item = all[galleryDetailIdx];
    if(!item){ print('nothing to copy right now', 'err'); return; }
    return copyGalleryItem(item);
  }
  if(displayMode !== 'ascii'){
    print('copy only works for ascii art — switch with "mode ascii", or pass a gallery number/name, e.g. "copy 3".', 'err');
    return;
  }
  const track = activeTrack();
  if(!track.current){ print('the ascii collection is still loading...', 'info'); return; }
  if(!track.pending){
    print(`"${track.current.name}" isn't fully revealed yet — keep completing tasks, "reveal" it (cheat), or pass a gallery number to copy an already-collected piece instead.`, 'err');
    return;
  }
  await copyTextAndReport(asciiArtText(track.current), track.current.name);
}

// resolves "gallery show"/"gallery display"'s argument the same way — a number
// first (matching what's actually on screen), a name as the fallback. returns
// -1 rather than null on no match, so callers can test it without a second
// null-check.
function resolveGalleryArg(arg, all){
  if(/^\d+$/.test(arg)){
    const n = parseInt(arg, 10);
    if(n >= 1 && n <= all.length) return n - 1;
  }
  return all.findIndex(c => c.name.toLowerCase() === arg.toLowerCase());
}

// "gallery rm"'s counterpart to splitIds — the same n[,n...]/n-m/all vocabulary
// used everywhere else in the app, but over collectedGalleryList()'s 1-based
// display numbers (or names) instead of task ids, since a collected piece has
// no id of its own that's ever shown on screen. returns the matched items
// (not indices) so the caller can remove them by identity regardless of how
// the list re-sorts/re-numbers after any of them are gone.
function resolveGalleryTargets(argsStr, all){
  const raw = (argsStr || '').trim();
  if(!raw) return [];
  if(raw.toLowerCase() === 'all') return all.slice();
  const out = [];
  const seen = new Set();
  const add = item => { if(item && !seen.has(item)){ seen.add(item); out.push(item); } };
  raw.split(',').map(s => s.trim()).filter(Boolean).forEach(tok => {
    const m = tok.match(/^(\d+)-(\d+)$/);
    if(m){
      let a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if(a > b) [a, b] = [b, a];
      b = Math.min(b, all.length);
      for(let i = a; i <= b; i++){ if(i >= 1) add(all[i - 1]); }
    } else {
      const idx = resolveGalleryArg(tok, all);
      if(idx !== -1) add(all[idx]);
    }
  });
  return out;
}

// removes already-resolved gallery items from whichever track each belongs to,
// matched by id + collectedAt (a collected item has no other stable identity —
// the same piece can be collected again later with a fresh timestamp). undoable
// like everything else MUTATING covers ("gallery" is in that set), but there's
// no dedicated "restore" for it the way archived tasks get one, hence the
// confirmation past the usual threshold in cmd_gallery below.
function performGalleryRm(targets){
  let changed = false;
  targets.forEach(item => {
    const track = item.type === 'image' ? imageTrack : asciiTrack;
    const i = track.collected.findIndex(c => c.id === item.id && c.collectedAt === item.collectedAt);
    if(i === -1) return;
    track.collected.splice(i, 1);
    print(`removed "${item.name}" from your gallery.`, 'ok');
    changed = true;
  });
  if(changed){
    if(galleryDetailIdx != null) galleryDetailIdx = null;   // whatever it pointed at may now be a different piece — back out to the grid
    saveState(); renderPanel();
  }
}

// the collection lives in the reveal panel now (see renderGalleryGrid/Detail),
// not the terminal log — a numbered dump you then had to re-type the exact
// humanizeName'd name back into "show" was never actually usable off its own
// output. "gallery show"/"gallery display" both take a number OR a name (number
// first, since that's what's actually on screen once the grid's up); name
// lookup stays as the fallback for anyone who'd rather type "gallery show li
// moly 2091" from memory than look at the panel first.
function cmd_gallery(sub, ...rest){
  sub = (sub || 'list').toLowerCase();
  if(['rm','remove','delete'].includes(sub)){
    const argsStr = rest.join(' ').trim();
    if(!argsStr){ print('usage: gallery rm <n|name|n,n,...|n-m|all>', 'err'); return; }
    const all = collectedGalleryList();
    if(all.length === 0){ print('no artworks collected yet — keep completing tasks!', 'info'); return; }
    const targets = resolveGalleryTargets(argsStr, all);
    if(targets.length === 0){ print(`"${argsStr}" isn't in your collection — "gallery" lists what you've got, by number.`, 'err'); return; }
    if(targets.length > CONFIRM_THRESHOLD){
      askConfirm(`remove ${targets.length} pieces from your gallery? "download" first if you want to keep any of the files.`, `gallery rm ${argsStr}`, () => performGalleryRm(targets));
      return;
    }
    performGalleryRm(targets);
    return;
  }
  if(sub === 'list'){
    const all = collectedGalleryList();
    if(all.length === 0){ print('no artworks collected yet — keep completing tasks!', 'info'); return; }
    galleryOpen = true;
    galleryDetailIdx = null;
    renderPanel();
    print(`${all.length} piece${all.length === 1 ? '' : 's'} collected — showing your collection in the panel.`, 'ok');
    print('  click a tile for a closer look, or "gallery show <n>"  —  "gallery close" returns to the live reveal.', 'info');
    if(!revealPaneVisible()) print('  (the panel is hidden right now — "split on" or "view art" shows it)', 'info');
    return;
  }
  if(sub === 'close'){
    if(!galleryOpen){ print('the gallery view isn\'t open.', 'info'); return; }
    showLiveReveal();
    renderPanel();
    print('back to the live reveal.', 'ok');
    return;
  }
  if(sub === 'show'){
    const arg = rest.join(' ').trim();
    if(!arg){ print('usage: gallery show <n|name>', 'err'); return; }
    const all = collectedGalleryList();
    if(all.length === 0){ print('no artworks collected yet — keep completing tasks!', 'info'); return; }
    const idx = resolveGalleryArg(arg, all);
    if(idx === -1){ print(`"${arg}" isn't in your collection yet — "gallery" lists what you've got, by number.`, 'err'); return; }
    galleryOpen = true;
    galleryDetailIdx = idx;
    renderPanel();
    if(!revealPaneVisible()) print('  (the panel is hidden right now — "split on" or "view art" shows it)', 'info');
    return;
  }
  if(sub === 'display'){
    const all = collectedGalleryList();
    if(all.length === 0){ print('no artworks collected yet — keep completing tasks!', 'info'); return; }
    const arg = rest.join(' ').trim();
    let idx;
    if(!arg){
      if(galleryDetailIdx == null){ print('usage: gallery display <n|name>  (or open one first — "gallery show <n>")', 'err'); return; }
      idx = galleryDetailIdx;
    } else {
      idx = resolveGalleryArg(arg, all);
      if(idx === -1){ print(`"${arg}" isn't in your collection yet — "gallery" lists what you've got, by number.`, 'err'); return; }
    }
    openGalleryFullscreen(idx);
    return;
  }
  print('usage: gallery [list|show <n|name>|display [<n|name>]|rm <n|name|...>|close]', 'err');
}

// commands that can change saved state. each one gets a snapshot taken before it
// runs, kept only if the state actually ended up different (pushUndo checks). view
// preferences (mode/split/switch) are deliberately left out — they're one keystroke
// to reverse, and cluttering the undo stack with them would bury the real mistakes.
// listed by canonical name only — aliases are resolved away before this is consulted.
// "import" is deliberately NOT here: it changes nothing while it runs (it opens a
// file picker and returns), so a snapshot taken around the command would always be
// of an unchanged state. it records its own undo entry from inside the FileReader
// callback that does the actual replacing — see cmd_import.
const MUTATING = new Set(['add','rename','start','stop','done','rm','priority','due','tag','mark','project','recover','close','next','reveal','hide','block','character','archive','restore','gallery']);

async function handleCommand(raw){
  const trimmed = raw.trim();

  // a pending confirmation owns the next line you type, but only if that line
  // actually looks like an answer to it. the undo snapshot is taken here rather
  // than when the question was asked, since that's the moment anything actually
  // changes.
  if(pendingConfirm){
    const { label, run } = pendingConfirm;
    pendingConfirm = null;
    if(/^(y|yes)$/i.test(trimmed)){
      const before = JSON.stringify(buildStateSnapshot());
      await run();
      pushUndo(label, before);
      return;
    }
    print('cancelled — nothing changed.', 'info');
    if(trimmed === '' || /^(n|no)$/i.test(trimmed)) return;
    // anything else typed here wasn't an answer at all — it's the next thing you
    // meant to do (type "rm all", get distracted, type "add buy milk"). running it
    // instead of discarding it is what stops that add from silently vanishing into
    // the "cancelled" line above.
    return handleCommand(raw);
  }

  const tokens = tokenize(trimmed);
  if(tokens.length === 0) return;
  // aliases collapse to the real command name here, before the undo bookkeeping and
  // dispatch below — so "d 3", "done 3" and a future rename all take one path.
  const cmd = resolveAlias(tokens[0].toLowerCase());
  const rest = tokens.slice(1);

  const before = MUTATING.has(cmd) ? JSON.stringify(buildStateSnapshot()) : null;
  await dispatch(cmd, rest);
  // if the command ended by *asking* something, it hasn't changed anything yet —
  // its snapshot gets taken above when the answer arrives.
  if(before !== null && !pendingConfirm) pushUndo(trimmed, before);
}

function dispatch(cmd, rest){
  // a command belonging to a switched-off feature is refused here, before the
  // switch, rather than being removed from it. typing "due 3 friday" with due off
  // should say what's actually true — the feature is off, here's the one line that
  // brings it back — instead of falling through to "unknown command", which reads
  // like the app forgot how to do something it did yesterday.
  if(!featureAllows(cmd)){
    const feat = FEATURE_OF_COMMAND[cmd];
    print(`"${cmd}" is part of the ${feat} feature, which is switched off.`, 'err');
    print(`  turn it back on with:  set ${feat} on   (nothing was deleted — every task is exactly as you left it)`, 'info');
    return;
  }
  switch(cmd){
    case 'help': cmd_help(rest[0]); break;
    case 'add': cmd_add(parseFlags(rest)); break;
    case 'rename': cmd_rename(rest[0], rest.slice(1).join(' ')); break;
    case 'edit': cmd_edit(rest[0]); break;
    case 'start': cmd_start(rest[0]); break;
    case 'stop': cmd_stop(rest[0]); break;
    case 'done': return cmd_done(rest[0]);
    case 'rm': cmd_rm(rest[0]); break;
    case 'priority': cmd_priority(rest[0], rest[1]); break;
    // everything after the ids is the date, joined rather than just the next token,
    // so the spelled-out forms ("due 3 in 2 weeks") work unquoted here. the "-d"
    // flag can't do that — it has no way to know where the date ends and the title
    // resumes — so there it's "-d "2 weeks"", which tokenize() already handles.
    case 'due': cmd_due(rest[0], rest.slice(1).join(' ')); break;
    // joined for the same reason "due" joins: "est 3 1h 30m" and "est 3 90 minutes"
    // are spellings the parser accepts, and only the command form has an unambiguous
    // end-of-value to let them through unquoted.
    case 'est': cmd_est(rest[0], rest.slice(1).join(' ')); break;
    case 'tag': cmd_tag(rest[0], rest[1], rest[2]); break;
    case 'tags': cmd_tags(); break;
    case 'mark': cmd_mark(rest[0], rest[1]); break;
    case 'project': cmd_project(rest[0], ...rest.slice(1)); break;
    case 'projects': cmd_project('list'); break;
    case 'list': cmd_list(rest); break;
    case 'filter': cmd_filter(rest); break;
    case 'archive': cmd_archive(...rest); break;
    case 'restore': cmd_restore(rest[0]); break;
    case 'find': cmd_find(rest); break;
    case 'gallery': return cmd_gallery(rest[0], ...rest.slice(1));
    case 'mode': cmd_mode(rest[0]); break;
    case 'folders': cmd_folders(rest); break;
    case 'include': cmd_include(rest); break;
    case 'exclude': cmd_exclude(rest); break;
    case 'view': cmd_view(rest[0]); break;
    case 'split': cmd_split(rest[0]); break;
    case 'set': cmd_set(rest[0], rest[1]); break;
    // "switch font" is the phrasing that comes to mind first, and "switch" is
    // already an old spelling of "theme" — so it lands here rather than on the font
    // command, and would otherwise answer "usage: theme <amber|night|...>" to a
    // request that has nothing to do with themes. handed straight over instead.
    // "theme font" gets the same treatment for the same one line.
    case 'theme':
      if((rest[0] || '').toLowerCase() === 'font'){ cmd_font(rest.slice(1).join(' ')); break; }
      cmd_theme(rest[0]); break;
    // joined, not rest[0]: font names are mostly two and three words ("DejaVu Sans
    // Mono", "Courier New"), and requiring quotes around the thing the list just
    // printed at you would be its own small insult. same reasoning as "due".
    case 'font': cmd_font(rest.join(' ')); break;
    // the display toggles "set" absorbed. they rewrite into it rather than having
    // their own implementations, so there's one code path per setting — the same
    // rule the SHORTCUTS map follows. bare "mirror" keeps toggling, which is what
    // it always did and what "set mirror toggle" now spells explicitly.
    // "show age" used to live here too, as the one two-word member of the set; it's
    // gone in favour of "set age on|off" alone, since a whole command word existing
    // to introduce a single key earned nothing that "set" didn't already do.
    case 'title': cmd_set('title', rest[0]); break;
    case 'statline': cmd_set('statline', rest[0]); break;
    case 'mirror': cmd_set('mirror', rest[0] || 'toggle'); break;
    case 'art': cmd_art(); break;
    // "next font" reads as one phrase and lands here, because "next" is already the
    // skip-this-artwork command (and 'n'). handed over rather than skipping a piece
    // at someone who was asking about typefaces — the same one-line interception
    // "switch font" needs just above, for the same reason.
    case 'next':
      if((rest[0] || '').toLowerCase() === 'font'){ cmd_font('next'); break; }
      return cmd_next();
    case 'reveal': return cmd_reveal();
    case 'hide': cmd_hide(); break;
    case 'block': return cmd_block(rest[0], rest.slice(1));
    case 'character': return cmd_character(rest[0], rest.slice(1));
    case 'close': return cmd_close();
    case 'undo': return cmd_undo();
    case 'download': return cmd_download(rest.join(' '));
    case 'copy': return cmd_copy(rest.join(' '));
    case 'display': cmd_display(); break;
    case 'fullscreen': cmd_fullscreen(rest[0]); break;
    case 'stats': cmd_stats(); break;
    case 'streak': cmd_streak(); break;
    case 'export': cmd_export(); break;
    case 'import': cmd_import(); break;
    case 'recover': cmd_recover(rest[0]); break;
    case 'clear': outputEl.innerHTML = ''; break;
    default: {
      const guess = suggestCommand(cmd);
      print(`unknown command "${cmd}"${guess ? ` — did you mean "${guess}"?` : ''}`, 'err');
      if(!guess) print('  try "help" for the command groups', 'info');
      break;
    }
  }
}

