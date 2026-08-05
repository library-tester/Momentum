A. Real bugs I found  — ALL THREE DONE (2026-08-04)
x 1. Completing several tasks at once silently throws away reward progress.
In momentum.html:1043-1048, done 1,2,3 reveals art for task 1, but if that completes the piece, tasks 2 and 3 just print "waiting for you" and their reveal credit vanishes. For an app whose entire premise is "every completed task earns reward progress," that's the one thing that must never leak. Fix: bank the unspent reveals and apply them to the next piece after close.

x 2. rm all and done all are instant and irreversible.
No confirmation anywhere in the file, no undo. Given you already lost your task list once to the localStorage issue, one mistyped command is the same outcome. Fix: require confirmation when a destructive command hits more than ~3 tasks, plus an undo command restoring the last mutation snapshot.

x 3. Help columns aren't aligned — your own todo item ("in help file is not everything on a vertical line"). I measured it: descriptions start at column 55, 56, 57, and 58 depending on the line. Fix: generate HELP_TEXT from a command array with computed padding, so it can never drift again.

B. Your todo.md items worth doing now  — 4, 5, 6 DONE (2026-08-04); 7, 8, 9 DONE (2026-08-05)
x 4. Remove the · dots from unrevealed ASCII art (momentum.html:714) — they leak the artwork's shape before you've earned it, undercutting the reveal. Blank space instead.

x 5. Make display work for ASCII art too, not just images. Right now cmd_display hard-refuses in ascii mode, which is arbitrary — a fullscreen ASCII piece is just a <pre> scaled up.

x 6. Exit fullscreen on Enter and Space, not only Escape/click.
   (also fixed while in here: typing "display" twice used to orphan the first overlay,
    leaving a black screen no key or click could dismiss)

x 7. Command shortcuts — l=list, a=add, d=done, rm, s=split, g=gallery. Cheap, and directly serves "think of some shortcuts of commands."
   (aliases are resolved once, before undo bookkeeping and dispatch, so a shortcut
    can't become a second code path. rm/remove/delete went through the same door.
    2026-08-05: extended with u=undo, n=next, r=reveal, x=close, f=fullscreen,
    c=clear. close got x rather than c since clear is typed far more often and
    wanted the letter first; hide was left with no letter — rarest of the three
    reveal-cheats, and h reads as "help" on reflex.)

x 8. Rename the image command to art (keeping image as an alias). image reveal while in ascii mode is genuinely confusing since it acts on whichever track is active.
   (2026-08-05: went further — art next/reveal/hide are now bare top-level commands
    "next"/"reveal"/"hide", since those were among the most-typed commands in the
    app. "art" alone now only reports status. the old "art next" sub-command form
    no longer works — this was a deliberate replacement, not an additive alias.)

x 9. fullscreen command for a real F11-style browser fullscreen via the Fullscreen API.
   (bare "fullscreen" toggles; on|off are explicit. distinct from "display", which
    only enlarges the artwork inside the page.)

? 10. Better day theme. Current day mode is pure #000 on #fff with zero accent — it reads as broken rather than minimal. I'd give it a warm off-white background and a restrained accent so it feels like a deliberate sibling of amber.

x 11. Scrollbar treatment in night/dark themes — currently the thumb uses --line, which in night mode is pure red and looks harsh. Outline-only thumb instead.
   (2026-08-05: night-mode thumb is now var(--bg-dark) fill with a 1px var(--line)
    border — black with a red outline, per your steer. scoped to [data-theme="night"]
    only; the other themes keep the solid --line thumb since none of them have this
    "loud accent color" problem.)

x (your request, 2026-08-05) Editable block size and block count for image reveal.
   First pass was a general "grid <cols>x<rows>|<n>|<n>px|auto" command; you asked
   for something simpler, so it became:
     - "block size <tier>" — very small, small, medium (manifest default), big, very
       big, full (one block — a single task finishes the piece).
     - "block count <n>|auto" — direct blocks-per-completed-task, capped at 10 ("a
       maximum of 10 blocks at the same time").
   Both are image-mode only (ascii uncovers character by character, no block grid).

   Real bug, found from your report: block size initially measured blocks in
   source-image *pixels* (small=80px, big=300px per block). Broke exactly on this
   project's own SVG art — a viewBox-only SVG with no width/height attribute reports
   a tiny, arbitrary browser-fallback "natural size" (often ~300x150) that has
   nothing to do with the artwork's real detail, so a fixed px target produced a
   near-empty grid on the images it was meant to divide finely: your "small" landed
   at 4 blocks, smaller than "medium"'s 20, and "big" collapsed to 1. Rewrote size
   as a target *block count* instead (aspect-adjusted, square-ish blocks) — it only
   needs the image's aspect ratio, which survives that fallback intact even when the
   absolute pixel numbers don't. Tiers: full=1, very big=4, big=10, medium=manifest
   (~20-40 here), small=100, very small=300 — matches the ordering and rough
   magnitudes you asked for. Verified against both a normal-sized source and a
   simulated tiny SVG-fallback source so this specific failure can't come back.

   Regridding a part-uncovered image still keeps it — the revealed area is treated as
   a region of the picture, each new block scored by exact-rectangle-overlap with
   that region, most-covered blocks come up uncovered. Two guards on the rounding:
   progress can never round down to zero, and a size change can never round *up* into
   completing a piece for you.
   Also fixed while in here: cmd_import never called resync(), so importing a backup
   whose current piece differed drew the old art against the new progress.

x (your request, 2026-08-05) Three defaults changed:
   1. block size now defaults to small (was medium/manifest), block count now
      defaults to 10 (was null/each piece's own manifest pace).
   2. split view is on by default (was off).
   3. block count's cap raised from 10 to 20.
   All three are boot-time defaults only — they change what a brand-new save starts
   as, not what an existing save already has. If you've played with this app before
   today, your current localStorage state keeps whatever you last set; these apply
   the next time there's no saved state at all (a fresh browser profile, or after
   "rm" on the storage key).

x (your request, 2026-08-05) Title bar toggle, then a statline toggle for the
   summary line too, and "organize your desk" restored after a brief detour.
   "title [on|off]" hides/shows the "MOMENTUM — yet another task manager" banner.
   "statline [on|off]" hides/shows the "N total · N completed · ..." line under
   it — kept as a separate command from "stats" (which prints a one-off summary
   into the terminal log and is unrelated). Both are display preferences in the
   split/switch family: not undo-tracked, saved with the rest of state, and a save
   from before either setting existed boots with both visible, matching the old
   unconditional behaviour. With both off the whole header (and its border) collapses
   rather than leaving an empty bar.
   I'd briefly genericized the empty-task-list message to drop the "organize your
   desk" example — you asked for it back, so both copies (the terminal boot message
   and the split-view pane's empty state) are restored to
   add one:  add "organize your desk"`.

C. Design and UX improvements
12. Responsive layout. There are no media queries at all, and the two panes have 280px + 240px minimums — so on a phone the app is unusable. Add a breakpoint that stacks the art panel above the terminal below ~700px.

13. Show relative age on tasks. You already store createdAt and never display it. [3d ago] on the details line quietly creates useful pressure on stale tasks.

14. A rename command. There's currently no way to fix a typo in a task title short of delete-and-retype.

15. Text search — find groceries / list -s report. Once you have 40 tasks, scanning is the bottleneck.

16. Streak tracking + a completion heatmap. This is the biggest motivational addition and fits the project's stated purpose better than any feature currently in it: "you've completed tasks 6 days running." You already store completedAt on every archived task, so the data is sitting there unused.

17. Sort the list meaningfully — overdue first, then active, then by priority. Right now it's pure insertion order.

D. Robustness
18. Detect a stale art-data.js. If you add art and forget python3 build_art_data.py, the offline app silently shows the old set. A build timestamp + a gentle notice when served-mode discovery finds files the snapshot doesn't know about would close that trap.

19. Handle broken/missing image files. If a manifest entry points at a deleted file you get a broken-image icon inside the tile frame with no explanation. An onerror fallback should say so and skip to the next piece.

20. Add a .gitignore. There's none, and your exported backup is sitting untracked at backup/momentum-backup-2026-08-04.json. I'd ignore __pycache__/ and decide deliberately whether backups belong in git (I'd say yes, actually — it's the durable copy of your tasks).

21. Auto-export safety net. Given the persistence problem, the app could keep the last N states in a second localStorage key and nudge you to export if you haven't in a while.

E. Bigger bets (worth discussing before building)
22. The simplification you already wrote down — "remove priority, project, due functionality completely." This is the single biggest change available: it would delete roughly 200 lines, collapse add's flag parsing to nothing, and make every task a clean one-liner. I'd stage it: hide those fields from display first, confirm you don't miss them for a week, then delete the code. I'd rather not rip it out irreversibly on day one.

23. A tiny test suite. I've been testing your app each round by extracting the script and driving it in jsdom, then throwing that away. Committing it as test.js (~100 lines, node test.js) would make regressions visible — the multi-task reveal bug in item 1 is exactly the kind of thing a test catches.

24. Document the commands in the README. It's 7 lines and doesn't mention a single command; help only exists once you're already running.

25. Multi-user / server persistence — your user-management todo. Real scope: a small backend, accounts, per-user state. Worth planning properly rather than bolting on, and it would also permanently solve the localStorage loss.

If you want a recommended first batch: items 1, 2, 3, 4 — one genuine reward-system bug, one data-loss risk, and two quick wins straight off your own list. Say which numbers you want and I'll implement them.