# Third-party notices

Iwakura Memoria bundles or depends on the components below. This file records
the component, its license, and where to obtain its source. Full license texts
are included with the bundled resources where the upstream project provides
them (for example `resources/languagetool/COPYING.txt`,
`resources/languagetool/third-party-licenses/`, and the JRE's `LICENSE` /
`NOTICE` files).

## Bundled runtime components

| Component | License | Source |
| --- | --- | --- |
| LanguageTool 6.8 | LGPL-2.1-or-later | https://github.com/languagetool-org/languagetool |
| Eclipse Temurin JRE 21 | GPL-2.0 with Classpath Exception | https://github.com/adoptium/temurin21-binaries |
| WordNet 3.0 | WordNet License (Princeton University) | https://wordnet.princeton.edu/ |
| Electron 44 | MIT | https://github.com/electron/electron |
| Chromium | BSD-style and other licenses | https://www.chromium.org/ |
| Python 3.12 runtime | PSF License | https://www.python.org/ |

The installer ships unmodified LanguageTool, JRE, and WordNet files as separate
resources. The LanguageTool license and its third-party notices are included in
`resources/languagetool/`; the JRE licenses are in `resources/jre/`; Electron's
licenses are in the application folder (`LICENSE.electron.txt` and
`LICENSES.chromium.html`).

## Python packages

These are frozen into the server executable by PyInstaller:

| Package | License |
| --- | --- |
| fastapi | MIT |
| uvicorn | BSD-3-Clause |
| httpx | BSD-3-Clause |
| python-multipart | Apache-2.0 |
| pypdf | BSD-3-Clause |
| python-docx | MIT |
| pywebview | BSD-3-Clause |
| fpdf2 | LGPL-3.0-only |
| Pillow | MIT-CMU |
| Markdown | BSD-3-Clause |
| EbookLib | AGPL-3.0 |
| PyYAML | MIT |
| PyInstaller bootloader | GPL-2.0-or-later with the special exception that permits distributing non-free programs |

The application source is available at
https://github.com/Haibane-Lain/Iwakura-Memoria. Source for the packages above
is available from their respective project pages and PyPI distributions.

## Frontend libraries

TipTap and ProseMirror are MIT-licensed. `static/lib/marked.js` is a vendored
copy of marked (MIT). The remaining frontend dependencies and their licenses
are listed in `package-lock.json`.

## Application code

Unless a separate license is added, the Iwakura Memoria application code is
Copyright (c) 2026 Lain. All rights reserved. This build is shared with selected
testers for evaluation; please don't redistribute it without permission.
