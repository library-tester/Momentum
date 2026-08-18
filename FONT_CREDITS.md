# Font credits

Every font bundled in `fonts/` and offered by the `font` command, with who made it
and under what licence. All of them are **SIL Open Font License 1.1**, which permits
bundling and redistribution — including inside this app — provided the fonts stay
under the OFL and the attribution below travels with them. That is what this file is
for. Full licence text: <https://openfontlicense.org>

The files themselves are the `latin` subsets served by Google Fonts, fetched the same
way `momentum.css` documents for IBM Plex Mono. Last updated: 2026-08-18.

IBM Plex Mono (Mike Abbink & Bold Monday, SIL OFL 1.1) ships as the default and is
listed first by the `font` command.

### Retro & typewriter

| font | designer(s) | licence | |
| --- | --- | --- | --- |
| **Courier Prime** | Alan Dague-Greene | SIL OFL 1.1 | Courier redrawn properly, for screenplays |
| **Cutive Mono** | Vernon Adams | SIL OFL 1.1 | typewriter, light and airy |
| **Share Tech Mono** | Carrois Apostrophe | SIL OFL 1.1 | techy, narrow, high-contrast |
| **Space Mono** | Colophon Foundry | SIL OFL 1.1 | retro-futurist with real quirks |
| **VT323** | Peter Hull | SIL OFL 1.1 | a CRT terminal, glyph for glyph |

### Futuristic & geometric

| font | designer(s) | licence | |
| --- | --- | --- | --- |
| **B612 Mono** | Nicolas Chauveau, Thomas Paillot, Jonathan Favre-Lamarine, Jean-Luc Vinot | SIL OFL 1.1 | designed for aircraft cockpit displays |
| **Kode Mono** | Isa Ozler | SIL OFL 1.1 | sharp, technical, modern-futurist |
| **Martian Mono** | Roman Shamin, Evil Martians | SIL OFL 1.1 | wide and heavy, engineered |

### Modern coding faces

| font | designer(s) | licence | |
| --- | --- | --- | --- |
| **Anonymous Pro** | Mark Simonson | SIL OFL 1.1 | a terminal font with warmth |
| **Fira Code** | The Mozilla Foundation, Telefonica S.A., Nikita Prokopov | SIL OFL 1.1 | Mozilla’s workhorse |
| **Inconsolata** | Raph Levien | SIL OFL 1.1 | a classic; humanist and compact |
| **JetBrains Mono** | JetBrains, Philipp Nurullin, Konstantin Bulenkov | SIL OFL 1.1 | tall x-height, built for long reading |
| **Roboto Mono** | Christian Robertson | SIL OFL 1.1 | neutral and even |
| **Source Code Pro** | Paul D. Hunt | SIL OFL 1.1 | Adobe’s, quietly excellent |

### Elegant & odd

| font | designer(s) | licence | |
| --- | --- | --- | --- |
| **Azeret Mono** | Displaay, Martin Vácha | SIL OFL 1.1 | contemporary, slightly severe |
| **DM Mono** | Colophon Foundry | SIL OFL 1.1 | low-contrast and calm |
| **Syne Mono** | Bonjour Monde, Lucas Descroix | SIL OFL 1.1 | artful and odd, in a good way |
| **Xanh Mono** | Yellow Type, Lâm Bảo, Duy Dao | SIL OFL 1.1 | a serif monospace — unusual and elegant |

## Removing one

Delete its files from `fonts/`, re-run `python3 build_font_data.py`, and it stops
being offered. Delete its row here too — this file is hand-maintained, unlike
`IMAGE_CREDITS.md` which is generated.
