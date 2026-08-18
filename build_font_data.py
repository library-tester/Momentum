#!/usr/bin/env python3
"""
Regenerates font-data.js by scanning fonts/ for webfont files.

Same reason build_art_data.py exists: a browser can't list a directory, and
under file:// it can't fetch() one either, so "every font in fonts/" has to be
written down somewhere the app can read with a plain <script src>. Run this
after adding/removing files in fonts/ and the "font" command picks them up.

Naming convention, which is all the grouping is based on:

    <family-name>-<weight>.woff2       ibm-plex-mono-400.woff2
    <family-name>-<weight>-italic.woff2
    <family-name>.woff2                weight defaults to 400

Files sharing a family stem become one entry in the font list, so a family's
regular and bold are one choice rather than two. The display name is the stem
title-cased ("ibm-plex-mono" -> "IBM Plex Mono"), with a small table of
initialisms below so acronyms don't come out as "Ibm".

Usage: python3 build_font_data.py
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).parent
FONT_DIR = ROOT / 'fonts'
# woff2 first by preference, but the others are all things a browser will take —
# no point refusing a .ttf someone dropped in when @font-face loads it fine.
FORMATS = {
    '.woff2': 'woff2',
    '.woff': 'woff',
    '.ttf': 'truetype',
    '.otf': 'opentype',
}
# tokens that are an acronym rather than a word, so title-casing leaves them alone.
INITIALISMS = {'ibm', 'jb', 'sf', 'dm', 'ia', 'vt', 'pt', 'sn'}
# families whose real name simply isn't derivable from a lowercase slug — internal
# capitals ("JetBrains") and letter-number runs ("VT323") both survive the trip *to*
# a filename and neither survives the trip back. worth spelling out rather than
# guessing at, since this is the name shown in the list and the name a system-
# installed copy of the same font would have to match.
NAME_OVERRIDES = {
    'jetbrains-mono': 'JetBrains Mono',
    'vt323': 'VT323',
    'dm-mono': 'DM Mono',
    'b612-mono': 'B612 Mono',
    'ibm-plex-mono': 'IBM Plex Mono',
    'pt-mono': 'PT Mono',
    'sf-mono': 'SF Mono',
}
DEFAULT_WEIGHT = 400


def parse_stem(stem):
    """'ibm-plex-mono-700-italic' -> ('ibm-plex-mono', 700, 'italic')"""
    parts = stem.lower().split('-')
    style = 'normal'
    if parts and parts[-1] in ('italic', 'oblique'):
        style = 'italic'
        parts = parts[:-1]
    weight = DEFAULT_WEIGHT
    if len(parts) > 1 and re.fullmatch(r'[1-9]00', parts[-1]):
        weight = int(parts[-1])
        parts = parts[:-1]
    # a named weight is as likely as a numeric one from a font vendor's zip
    elif parts and parts[-1] in ('regular', 'normal', 'book'):
        parts = parts[:-1]
    elif parts and parts[-1] == 'bold':
        weight, parts = 700, parts[:-1]
    elif parts and parts[-1] in ('light', 'thin'):
        weight, parts = 300, parts[:-1]
    elif parts and parts[-1] in ('medium',):
        weight, parts = 500, parts[:-1]
    return '-'.join(parts) or stem.lower(), weight, style


def humanize(family_id):
    if family_id in NAME_OVERRIDES:
        return NAME_OVERRIDES[family_id]
    out = []
    for word in family_id.split('-'):
        if not word:
            continue
        out.append(word.upper() if word in INITIALISMS else word[:1].upper() + word[1:])
    return ' '.join(out) or family_id


def main():
    families = {}
    if FONT_DIR.is_dir():
        for path in sorted(FONT_DIR.rglob('*')):
            if not path.is_file() or path.suffix.lower() not in FORMATS:
                continue
            family_id, weight, style = parse_stem(path.stem)
            # a subfolder is a category, exactly as it is in ascii_art/ and
            # image_art/ — the app groups the font list under these headings, which
            # is what keeps two dozen entries navigable instead of a wall. files
            # sitting loose at the top level have no category and list first.
            rel_parent = path.relative_to(FONT_DIR).parent
            category = rel_parent.as_posix() if rel_parent != Path('.') else None
            fam = families.setdefault(family_id, {
                'id': family_id,
                # the CSS font-family name the app will reference. the humanized
                # form rather than the slug, so it matches what the font actually
                # calls itself and a system copy of the same family can satisfy it.
                'family': humanize(family_id),
                'name': humanize(family_id),
                'category': category,
                'files': [],
            })
            fam['files'].append({
                'file': path.relative_to(ROOT).as_posix(),
                'format': FORMATS[path.suffix.lower()],
                'weight': weight,
                'style': style,
            })

    for fam in families.values():
        fam['files'].sort(key=lambda f: (f['weight'], f['style']))

    entries = [families[k] for k in sorted(families)]

    data = {
        # same staleness marker art-data.js carries, and for the same reason: if
        # you add a font and forget to rerun this, the date is the thing that
        # tells you how old the list you're looking at actually is.
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'families': entries,
    }

    out_path = ROOT / 'font-data.js'
    js = (
        '// Generated by build_font_data.py — do not edit by hand.\n'
        '// Re-run "python3 build_font_data.py" after adding or removing files in\n'
        '// fonts/, so the "font" command sees them (and so the app still works\n'
        '// offline, opened directly as a file:// with no server running).\n'
        'window.FONT_DATA = ' + json.dumps(data, indent=2, ensure_ascii=False) + ';\n'
    )
    out_path.write_text(js, encoding='utf-8')
    total = sum(len(f['files']) for f in entries)
    print(f'wrote {out_path} ({len(entries)} font families, {total} files)')


if __name__ == '__main__':
    main()
