# Third-party notices

This file lists material copied into the Riichi Mahjong Studio source tree.
Packages installed through npm are additionally identified by `package-lock.json`
and retain their respective upstream licenses.

## MahjongRepository/mahjong

- Upstream: https://github.com/MahjongRepository/mahjong
- Local path: `python/vendor/mahjong`
- License: MIT
- Snapshot: upstream tag `v2.0.0`, commit
  `27ee0f926132d0659e83a26540ce996b09fe4257` (2026-04-02). The vendored
  `mahjong` package tree was verified byte-for-byte against that commit before
  local terminology edits. Local changes are limited to comments and
  docstrings.

MIT License

Copyright (c) 2017 mahjong Python library contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## FluffyStuff/riichi-mahjong-tiles

- Upstream: https://github.com/FluffyStuff/riichi-mahjong-tiles
- Local path: `src/assets/tiles/Regular_shortnames`
- Dedication: CC0 1.0 / public domain dedication
- Snapshot: commit `26e127ba2117f45cdce5ea0225748cc0cfad3169`.
  The local SVGs are renamed copies of the upstream Regular set with
  editor-specific Inkscape export-path metadata removed.

The upstream notice states: “This work is in the public domain. For more
information, visit https://creativecommons.org/publicdomain/zero/1.0/.”

## killerducky/killer_mortal_gui

- Upstream: https://github.com/killerducky/killer_mortal_gui
- Reviewed upstream commit: `9f85c6ba7c554ad5957ed01e1dc36c7f3064ce40`.
- Local use: selected CSS zoom, color, and table-spacing expressions in
  `src/styles.css`, the optional `killerducky` color theme, and
  report-format compatibility were adapted from this project.
- License: MIT

MIT License

Copyright (c) 2025 Andy Olsen

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
