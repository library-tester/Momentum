// ===== Momentum — app-commands.js =====
// the terminal itself plus every command: the COMMANDS table, help, tab completion,
// did-you-mean, guard rails, filters, and the cmd_* implementations with their
// task-list text rendering. Also builds outputEl/COMMAND_NAMES/ALIASES at load time.
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
  div.textContent = text;
  const stick = isNearOutputBottom();
  outputEl.appendChild(div);
  if(stick) outputEl.scrollTop = outputEl.scrollHeight;
  trimOutput();
}
// like print(), but for a single line built from differently-styled runs (e.g.
// a bright title followed by dim [tag] fields) — each segment keeps its own class.
function printSegments(segments, indentCh){
  const div = document.createElement('div');
  div.className = 'line';
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
const COMMANDS = [
  { usage: 'add <task title> [-p high|med|low] [-d YYYY-MM-DD] [-t tag1,tag2] [-proj name]', desc: 'add a new task  (quotes around the title are optional)' },
  { usage: 'rename <id> "new title"', desc: 'fix a typo — one task at a time, no delete-and-retype' },
  { usage: 'edit <id>', desc: 'load a task\'s current title into the command line to tweak, enter to save',
    extra: ['(fills in "rename <id> ...", cursor inside the quotes — for a full retype, "rename" works directly)'] },
  { usage: 'start <id[,id...]|all>', desc: 'mark task(s) active' },
  { usage: 'done <id[,id...]|all>', desc: 'complete task(s) — moves them to the archive' },
  { usage: 'rm <id[,id...]|1-4|all>', desc: 'delete task(s)  (also: remove, delete)' },
  { usage: 'undo', desc: 'undo the last command that changed anything' },
  { usage: 'priority <id[,id...]|all> <high|med|low>', desc: 'change priority' },
  { usage: 'due <id[,id...]|all> <YYYY-MM-DD|none>', desc: 'set or clear a due date' },
  { usage: 'tag <id[,id...]|all> add <tag>', desc: 'add a tag to task(s)' },
  { usage: 'tag <id[,id...]|all> rm <tag>', desc: 'remove a tag from task(s)' },
  { usage: 'tag <id[,id...]|all> set <tag1,tag2,...>', desc: "replace all of task(s)' tags" },
  { usage: 'tags', desc: 'list every tag in use' },
  { usage: 'project add <name>', desc: 'create a project' },
  { usage: 'project rm <name>', desc: 'delete a project' },
  { usage: 'project set <id[,id...]|all> <name|none>', desc: 'assign task(s) to a project' },
  { usage: 'project list', desc: 'list all projects (or: projects)' },
  { usage: 'list [all|pending|active] [-proj name] [-t tag]', desc: 'show tasks as text, once (excludes archived)' },
  { usage: 'filter [<same arguments as list>|off]', desc: 'narrow the always-visible task pane and keep it that way',
    extra: ['bare "filter" says what\'s applied; "filter off" clears it'] },
  { usage: 'archive [-proj name] [-t tag]', desc: 'show completed/archived tasks' },
  { usage: 'archive rm <id[,id...]|1-4|all>', desc: 'permanently delete archived task(s) — no coming back from this one' },
  { usage: 'restore <id[,id...]|1-4|all>', desc: 'move archived task(s) back to your list' },
  { usage: 'find <text>', desc: 'search titles + tags, pending/active and archive together' },
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
  { usage: 'set [<key>] [on|off|toggle]', desc: 'the on/off display settings — keys: title, statline, mirror, age',
    extra: ['bare "set" lists all four with their current state',
            '(title/statline/mirror/"show age" still work as their own commands)'] },
  { usage: 'theme [amber|night|day|solar|nord]', desc: 'show or switch the color theme',
    extra: ['(also: switch, and the classic nightmode/daymode)'] },
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
  { usage: 'streak', desc: "current/longest completion streak + a heatmap" },
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
const SPELLINGS = { remove:'rm', delete:'rm', image:'art', switch:'theme', save:'close', skip:'next' };
const ALIASES = { ...SHORTCUTS, ...SPELLINGS };
function resolveAlias(cmd){ return ALIASES[cmd] || cmd; }

// commands that still dispatch but no longer have a help row of their own,
// because they were folded into a broader one. they can't be plain ALIASES —
// "title on" has to become "set title on", which is an argument rewrite, not a
// word swap, so dispatch handles the call and this only points help at the row
// that now documents them. keeps "help title" useful instead of answering "no
// help for that" about a command that demonstrably works.
const HELP_ALIASES = { title:'set', statline:'set', mirror:'set', show:'set', age:'set', exclude:'folders', include:'folders' };

// the dispatchable command word a help row documents: the first token of its
// usage, which is exactly what dispatch() switches on. "archive [-proj name]"
// and "archive rm <ids>" are both the "archive" command; the three "tag" rows
// and both "block" rows likewise collapse to one name each. derived rather than
// declared on every row, so a row can't drift out of sync with the command it
// documents.
function commandNameOf(usage){ return usage.split(' ')[0]; }
const COMMAND_NAMES = [...new Set(COMMANDS.map(c => commandNameOf(c.usage)))];

// ---------- help groups ----------
// the full command list is ~70 printed lines, which is a wall you have to read
// end-to-end to find one thing. grouping lets bare "help" be a five-line menu
// and pushes the detail behind "help <group>". membership is keyed by command
// *name*, so every row of a multi-row command travels together automatically.
const HELP_GROUPS = [
  { name:'tasks',  desc:'add, edit, finish and find tasks',
    members:['add','rename','edit','start','done','rm','undo','priority','due','tag','tags','project','list','filter','archive','restore','find'] },
  { name:'art',    desc:'the reward art — modes, reveal pace, gallery',
    members:['gallery','mode','folders','art','next','reveal','hide','block','close','download','copy','display'] },
  { name:'layout', desc:'panels, themes, and what shows on screen',
    members:['view','split','set','theme','fullscreen'] },
  { name:'data',   desc:'backups, and restoring from them',
    members:['export','import','recover'] },
  { name:'other',  desc:'stats, streak, and the rest',
    members:['stats','streak','clear','help'] },
];
// anything not explicitly placed lands in "other" rather than vanishing from
// help entirely — a new command with no group is still findable.
function commandsInGroup(groupName){
  const group = HELP_GROUPS.find(g => g.name === groupName);
  if(!group) return [];
  const placed = new Set(HELP_GROUPS.flatMap(g => g.members));
  return COMMANDS.filter(c => {
    const name = commandNameOf(c.usage);
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
function buildHelpRows(list){
  const fitting = list.map(c => c.usage.length).filter(n => n <= HELP_MAX_USAGE);
  // capped to what this console can actually show. the description column is only
  // worth having if real width is left over for the description; when it isn't, col
  // shrinks, and more rows fall through the "usage too long" branch below and stack
  // instead — the layout that does fit. note both branches indent by col, so this
  // one cap fixes the stacked rows as well. at a comfortable width nothing changes.
  const room = Math.max(0, outputColumns() - HELP_MIN_DESC);
  const col = Math.min((fitting.length ? Math.max(...fitting) : 0) + 2, room);
  const indent = col + 2;   // "  " + the usage column — where desc/extra text actually starts
  const rows = [];
  list.forEach(c => {
    if(c.usage.length > col - 2){
      rows.push({ text: '  ' + c.usage, indent: 0 });
      rows.push({ text: '  ' + ' '.repeat(col) + c.desc, indent });
    } else {
      rows.push({ text: '  ' + c.usage.padEnd(col) + c.desc, indent });
    }
    (c.extra || []).forEach(e => rows.push({ text: '  ' + ' '.repeat(col) + e, indent }));
  });
  return rows;
}
function printHelpRows(rows){
  rows.forEach(r => r.indent ? printHanging(r.text, r.indent) : print(r.text));
}
// printed from the same map dispatch uses, so the advertised shortcuts are
// exactly the ones that work.
function printShortcutsRow(){
  printHanging('  shortcuts:  ' + Object.entries(SHORTCUTS).map(([k,v]) => `${k} = ${v}`).join('   '), 2);
}

function cmd_help(arg){
  const raw = (arg || '').toLowerCase();

  // bare "help": a menu, not the manual.
  if(!raw){
    print('momentum — commands are grouped; open one with "help <group>".');
    print('');
    HELP_GROUPS.forEach(g => {
      const n = commandsInGroup(g.name).length;
      printHanging(`  help ${g.name.padEnd(8)}${g.desc}  (${n} line${n === 1 ? '' : 's'})`, 14);
    });
    printHanging('  help all     every command at once, the long way', 14);
    print('');
    print('  "help <command>" explains just that one, e.g. help done', 'info');
    print('  Tab completes command names and their options; press it again to cycle.', 'info');
    print('');
    printShortcutsRow();
    return;
  }

  if(raw === 'all'){
    print('commands:');
    printHanging('  (most commands below accept multiple ids: done 3,5,6  |  ranges: rm 1-4  |  or: rm all)', 2);
    print('');
    printHelpRows(buildHelpRows(COMMANDS));
    print('');
    printShortcutsRow();
    return;
  }

  if(HELP_GROUPS.some(g => g.name === raw)){
    const group = HELP_GROUPS.find(g => g.name === raw);
    print(`${raw} — ${group.desc}:`);
    print('');
    printHelpRows(buildHelpRows(commandsInGroup(raw)));
    return;
  }

  // a single command — aliases resolve first, so "help l" and "help d" explain
  // the real command rather than reporting that the letter is unknown, and the
  // folded-away commands ("help title") land on the row that now covers them.
  const name = HELP_ALIASES[raw] || resolveAlias(raw);
  const rows = COMMANDS.filter(c => commandNameOf(c.usage) === name);
  if(rows.length){
    printHelpRows(buildHelpRows(rows));
    const alias = [...Object.entries(ALIASES), ...Object.entries(HELP_ALIASES)]
      .filter(([k,v]) => v === name).map(([k]) => k);
    if(alias.length) print(`  also: ${alias.join(', ')}`, 'info');
    print(`  group: ${groupOfCommand(name)}  ("help ${groupOfCommand(name)}" for its neighbours)`, 'info');
    return;
  }

  const guess = suggestCommand(raw);
  print(`no help for "${raw}"${guess ? ` — did you mean "${guess}"?` : ''}`, 'err');
  print(`  groups: ${HELP_GROUPS.map(g => g.name).join(', ')}, all`, 'info');
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
const SUGGESTABLE = [...new Set([...COMMAND_NAMES, 'projects', ...Object.keys(SPELLINGS), ...Object.keys(HELP_ALIASES)])].filter(n => n.length > 1);
function suggestCommand(cmd){
  let best = null, bestDist = Infinity;
  SUGGESTABLE.forEach(name => {
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
  set:        pos => pos === 0 ? Object.keys(SETTINGS) : SETTING_VALUES,
  mode:       () => ['ascii', 'image'],
  view:       () => VIEW_MODES,
  split:      ON_OFF,
  fullscreen: ON_OFF,
  // folded into "set", but still typed out of habit — completing them keeps the
  // old spellings first-class rather than quietly second-rate.
  mirror:     ON_OFF,
  title:      ON_OFF,
  statline:   ON_OFF,
  show:       pos => pos === 0 ? ['age'] : ON_OFF(),
  list:       () => ['all', 'pending', 'active'],
  filter:     () => ['all', 'pending', 'active', 'off'],
  done:       () => ['all'],
  start:      () => ['all'],
  rm:         () => ['all'],
  restore:    () => ['all'],
  archive:    pos => pos === 0 ? ['rm'] : ['all'],
  gallery:    pos => pos === 0 ? ['list', 'show', 'display', 'close', 'rm'] : [],
  project:    pos => pos === 0 ? ['add', 'rm', 'list', 'set'] : [],
  recover:    pos => pos === 0 ? ['list'] : [],
  tag:        pos => pos === 1 ? ['add', 'rm', 'set'] : [],
  block:      (pos, prior) => pos === 0 ? ['size', 'count']
                : prior[0] === 'size'  ? BLOCK_SIZE_NAMES
                : prior[0] === 'count' ? ['auto']
                : [],
  help:       pos => pos === 0 ? [...HELP_GROUPS.map(g => g.name), 'all', ...COMMAND_NAMES] : [],
};

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
  if(prior.length === 0){
    // canonical names first, so Tab teaches the vocabulary the app actually
    // documents. the still-working older spellings ("switch", "title", "exclude"
    // …) are a fallback tier rather than part of that list: they only surface when
    // nothing canonical matches, which keeps them typeable from muscle memory
    // without padding out every ordinary completion with retired synonyms.
    pool = COMMAND_NAMES.filter(c => c.toLowerCase().startsWith(prefix));
    if(pool.length === 0) pool = LEGACY_COMMAND_NAMES;
  } else {
    const fn = ARG_COMPLETIONS[resolveAlias(prior[0].toLowerCase())];
    pool = fn ? fn(prior.length - 1, prior.slice(1)) : [];
  }
  return { base: value.slice(0, start), candidates: pool.filter(c => c.toLowerCase().startsWith(prefix)) };
}

// one worked example per flag, so the "you left this dangling" message below can
// show the shape that was missing instead of just naming the flag. shared by both
// argument parsers (add's flags, and list/filter/archive's) so the two can't drift
// into describing the same flag differently.
const FLAG_EXAMPLES = { '-p': '-p high', '-d': '-d 2026-01-31', '-t': '-t urgent,home', '-proj': '-proj work' };
function missingFlagError(flag){
  return { text: `${flag} needs a value after it — e.g. ${FLAG_EXAMPLES[flag]}`, cls: 'err' };
}

function parseFlags(tokens){
  const args = { _: [] };
  const flagKeys = { '-p':'p', '-d':'d', '-t':'t', '-proj':'proj' };
  for(let i=0;i<tokens.length;i++){
    const tk = tokens[i];
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
  let priority = null, due = null, tags = [], project = null;
  if(args.p){
    const p = args.p.toLowerCase();
    if(!['high','med','low'].includes(p)){ print('priority must be high, med, or low', 'err'); return; }
    priority = p;
  }
  if(args.d){
    if(!/^\d{4}-\d{2}-\d{2}$/.test(args.d)){ print('due date must look like YYYY-MM-DD', 'err'); return; }
    due = args.d;
  }
  if(args.t){
    tags = args.t.split(',').map(s=>s.trim()).filter(Boolean);
  }
  if(args.proj){
    project = args.proj;
    if(!projects.includes(project)){
      projects.push(project);
      print(`note: created new project "${project}"`, 'info');
    }
  }
  const t = { id: nextFreeId(), title, status:'pending', priority, due, tags, project, createdAt: Date.now() };
  tasks.push(t);
  const priTxt = priority ? ` [${priority}]` : '';
  const dueTxt = due ? ` due ${due}` : '';
  const projTxt = project ? ` proj:${project}` : '';
  const tagsTxt = tags.length ? ` tags:${tags.join(',')}` : '';
  print(`added #${t.id} "${title}"${priTxt}${dueTxt}${projTxt}${tagsTxt}`, 'ok');
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
  if(ids.length === 0){ print('due needs a task id, e.g. due 3 2026-01-01 or due 3,5,6 2026-01-01', 'err'); return; }
  if(dateStr !== 'none' && !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)){
    print('due date must look like YYYY-MM-DD, or "none"', 'err'); return;
  }
  let changed = false;
  ids.forEach(idStr => {
    const t = findTask(idStr);
    if(!t){ print(`no task #${idStr}`, 'err'); return; }
    if(dateStr === 'none'){ t.due = null; print(`#${t.id} due date cleared`, 'ok'); }
    else { t.due = dateStr; print(`#${t.id} due ${dateStr}`, 'ok'); }
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
    if(tk === '-proj' || tk === '-t'){
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
  if(f.proj) out = out.filter(t => t.project === f.proj);
  if(f.tag){
    const wanted = f.tag.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
    out = out.filter(t => (t.tags||[]).some(x => wanted.includes(x.toLowerCase())));
  }
  return out;
}
// null when the spec is usable, otherwise the message to print. "done" gets its own
// wording (and info, not err) because it's a reasonable thing to ask for — the
// tasks exist, they just live in the archive now.
function listArgsError(f){
  if(f.missingFlag) return missingFlagError(f.missingFlag);
  if(f.status === 'done') return { text: 'completed tasks are archived — try the "archive" command', cls: 'info' };
  if(!['all','pending','active'].includes(f.status)) return { text: `unknown filter "${f.status}" (use all|pending|active)`, cls: 'err' };
  return null;
}
function isFilterActive(f){ return !!f && (f.status !== 'all' || !!f.proj || !!f.tag); }
// compact, for the pane's badge and the command's own read-out
function describeFilter(f){
  const parts = [];
  if(f.status !== 'all') parts.push(f.status);
  if(f.proj) parts.push(`proj=${f.proj}`);
  if(f.tag) parts.push(`tag=${f.tag}`);
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
  rows.forEach(r => r.segments ? printSegments(r.segments, r.indent) : printHanging(r.text, r.indent, r.cls));
  if(closingRule) print(rule, 'info rule');
  if(summary) print(summary, 'info');
}

// the [priority] [project] [tag] [due] [age] tags that trail a task — returned
// separately so callers can skip appending anything when there's nothing in it.
function detailFields(t, extra){
  const fields = [];
  if(t.priority) fields.push(`[${t.priority}]`);
  if(t.project) fields.push(`[${t.project}]`);
  if(t.tags) t.tags.forEach(tag => fields.push(`[${tag}]`));
  if(t.due) fields.push(`[due:${t.due}]`);
  if(showAge && t.createdAt) fields.push(`[${taskAgeText(t.createdAt)}]`);
  (extra || []).forEach(f => fields.push(f));
  return fields;
}

// every row this feeds (task list, archive) starts life as "  [<id>] <title>…" —
// the hanging-indent column a wrapped title's continuation should land on, one
// past the closing bracket's own space, so it picks up under the title's first
// letter instead of sliding back under the id.
function bracketIndent(text){
  return text.indexOf(']') + 2;
}
// packs each row's tag fields onto the same line as its title instead of a row
// underneath, right where the title ends. items: [{ left, fields, cls }] — cls,
// if set, makes the whole row one color (e.g. overdue); otherwise the title
// stays bright and the trailing fields render dim via a separate segment.
function buildAlignedRows(items){
  return items.map(({ left, fields, cls }) => {
    const fieldsText = fields.join(' ');
    const indent = bracketIndent(left);
    if(!fieldsText) return { text: left, cls, indent };
    return {
      text: `${left} ${fieldsText}`,
      cls,
      indent,
      segments: cls ? null : [{ text: `${left} ` }, { text: fieldsText, cls: 'info' }]
    };
  });
}

// the id *is* the marker now — there's no checkbox, since everything still in the
// list is by definition not done yet (finishing a task moves it to the archive).
// ids are right-aligned to the widest one so titles stay in a straight column.
// shared by "list", the split-view pane, and "find" (the only caller that passes
// archivedIds — a Set of ids drawn from the archive, mixed in alongside pending/
// active ones, since ids are unique across both: a task lives in exactly one of
// the two arrays at a time).
function buildTaskRows(list, archivedIds){
  const idWidth = Math.max(...list.map(t => String(t.id).length));
  const items = list.map(t=>{
    const archived = !!(archivedIds && archivedIds.has(t.id));
    const overdue = !archived && isOverdue(t);
    const extra = overdue ? ['[OVERDUE]'] : [];
    if(archived) extra.push('[archived]');
    const fields = detailFields(t, extra);
    if(!archived && t.status === 'active') fields.unshift('[active]');   // the one thing the old [~] mark said that the id doesn't
    return { left: `  [${String(t.id).padStart(idWidth)}] ${t.title}`, fields, cls: overdue ? 'err' : undefined };
  });
  return buildAlignedRows(items);
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
  return [isOverdue(t) ? 0 : 1, t.status === 'active' ? 0 : 1, t.priority ? PRIORITY_RANK[t.priority] : 3];
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
  const overdueCount = list.filter(isOverdue).length;
  const hiding = total !== undefined && total !== list.length;
  const parts = [hiding ? `${list.length} of ${total} shown` : `${list.length} task${list.length === 1 ? '' : 's'}`];
  if(activeCount) parts.push(`${activeCount} active`);
  if(overdueCount) parts.push(`${overdueCount} overdue`);
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
  const matches = t => t.title.toLowerCase().includes(q) || (t.tags||[]).some(tag => tag.toLowerCase().includes(q));
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
// task never finishes it on its own; click anywhere else on the row and the id
// gets appended into whatever's being typed instead. the row always starts with
// "  [<id>] " (see buildTaskRows), so slicing off through the first "]" reliably
// isolates the bracket without needing buildTaskRows to hand back id/title as
// separate fields — rows printed to the terminal (list/find/archive) go through
// buildTaskRows too, so that shape has to stay a single string for those callers.
function rowHtml(r, id){
  const raw = r.segments ? r.segments[0].text : r.text;
  const bracketEnd = raw.indexOf(']') + 1;
  const idHtml = `<span class="row-id" data-id="${id}">${escapeHtml(raw.slice(0, bracketEnd))}</span>`;
  const restHtml = r.segments
    ? escapeHtml(raw.slice(bracketEnd)) + r.segments.slice(1).map(seg =>
        seg.cls ? `<span class="${seg.cls}">${escapeHtml(seg.text)}</span>` : escapeHtml(seg.text)).join('')
    : escapeHtml(raw.slice(bracketEnd));
  // same hanging-indent trick as printHanging/printFramed: a title long enough to
  // wrap in the pane's own column picks its continuation up under its own first
  // letter, not back at the pane's left edge behind the [id].
  const style = `padding-left:${r.indent}ch;text-indent:-${r.indent}ch`;
  return `<div class="line row${r.cls ? ' ' + r.cls : ''}" data-id="${id}" style="${style}">${idHtml}${restHtml}</div>`;
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
      `<div class="line info">no tasks yet — add one:  add "organize your desk"</div>`;
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
  const rows = buildTaskRows(sorted).map((r, i) => rowHtml(r, sorted[i].id)).join('');
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
    left: `  [${String(t.id).padStart(idWidth)}] ${t.title}`,
    fields: detailFields(t, t.completedAt ? [`[completed:${new Date(t.completedAt).toLocaleDateString()}]`] : [])
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
    ['overdue', overdue], ['projects', projects.length],
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
function describeLayout(){
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
  print(`view: ${viewMode} — ${sideName()} now has the ${sideEdge()}-hand column.`, 'ok');
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
    apply: v => { mirrored = v; applyView(); },
    said: v => v
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

function cmd_set(key, value){
  const keys = Object.keys(SETTINGS);

  // bare "set" — the whole point of folding these together: one place that shows
  // every display flag and its current state at once.
  if(!key){
    print('display settings  —  change one with:  set <key> on|off');
    const w = Math.max(...keys.map(k => k.length));
    keys.forEach(k => printHanging(`  ${k.padEnd(w)}  ${SETTINGS[k].get() ? 'on ' : 'off'}   ${SETTINGS[k].label}`, w + 9));
    return;
  }

  key = key.toLowerCase();
  const setting = SETTINGS[key];
  if(!setting){
    // same did-you-mean treatment unknown commands get — a mistyped key is the
    // same kind of mistake and deserves the same help.
    let guess = null, best = Infinity;
    keys.forEach(k => { const d = editDistance(key, k); if(d < best){ best = d; guess = k; } });
    if(best > (key.length <= 4 ? 1 : 2)) guess = null;
    print(`no display setting "${key}"${guess ? ` — did you mean "${guess}"?` : ''}`, 'err');
    print(`  keys: ${keys.join(', ')}   ("set" alone shows them with their current state)`, 'info');
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
const MUTATING = new Set(['add','rename','start','done','rm','priority','due','tag','project','recover','close','next','reveal','hide','block','archive','restore','gallery']);

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
  switch(cmd){
    case 'help': cmd_help(rest[0]); break;
    case 'add': cmd_add(parseFlags(rest)); break;
    case 'rename': cmd_rename(rest[0], rest.slice(1).join(' ')); break;
    case 'edit': cmd_edit(rest[0]); break;
    case 'start': cmd_start(rest[0]); break;
    case 'done': return cmd_done(rest[0]);
    case 'rm': cmd_rm(rest[0]); break;
    case 'priority': cmd_priority(rest[0], rest[1]); break;
    case 'due': cmd_due(rest[0], rest[1]); break;
    case 'tag': cmd_tag(rest[0], rest[1], rest[2]); break;
    case 'tags': cmd_tags(); break;
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
    case 'theme': cmd_theme(rest[0]); break;
    // the four display toggles "set" absorbed. they rewrite into it rather than
    // having their own implementations, so there's one code path per setting —
    // the same rule the SHORTCUTS map follows. bare "mirror" keeps toggling, which
    // is what it always did and what "set mirror toggle" now spells explicitly.
    case 'title': cmd_set('title', rest[0]); break;
    case 'statline': cmd_set('statline', rest[0]); break;
    case 'mirror': cmd_set('mirror', rest[0] || 'toggle'); break;
    case 'show':
      if((rest[0] || '').toLowerCase() !== 'age'){ print('usage: show age on|off   (or: set age on|off)', 'err'); break; }
      cmd_set('age', rest[1]);
      break;
    case 'art': cmd_art(); break;
    case 'next': return cmd_next();
    case 'reveal': return cmd_reveal();
    case 'hide': cmd_hide(); break;
    case 'block': return cmd_block(rest[0], rest.slice(1));
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

