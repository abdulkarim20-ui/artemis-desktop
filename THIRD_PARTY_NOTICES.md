# Third-party notices

Artemis bundles the following third-party components. Each component remains
under its own license, and those licenses apply to the component regardless of
the MIT license that covers Artemis source code.

## Browser libraries (`renderer/vendor/`)

| Component | Version | License |
| --- | --- | --- |
| [marked](https://github.com/markedjs/marked) | 18.1.3 | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | 3.4.17 | Apache-2.0 OR MPL-2.0 |
| [highlight.js](https://github.com/highlightjs/highlight.js) | 11.12.0 | BSD-3-Clause |
| [KaTeX](https://github.com/KaTeX/KaTeX) | 0.19.1 | MIT |

KaTeX ships its own font files under `renderer/vendor/katex/fonts/`; these are
covered by the KaTeX license.

## Fonts (`assets/fonts/`)

The bundled Inter, Crimson Pro, Instrument Serif, Space Grotesk, and JetBrains
Mono web fonts are distributed under the SIL Open Font License 1.1. The fonts
are unmodified copies from the corresponding Fontsource packages.

## npm dependencies

Artemis depends on the following packages. Their full license texts are
installed with them under `node_modules/`.

| Package | License |
| --- | --- |
| Electron | MIT |
| Express | MIT |
| cors | MIT |
| dotenv | BSD-2-Clause |
| groq-sdk | Apache-2.0 |
| openai | Apache-2.0 |
| @firecrawl/anydoc | MIT |

## Trademarks

Groq, NVIDIA, OpenAI, Qwen, Meta, and other model or provider names are
trademarks of their respective owners. Artemis uses those names only to
identify compatible services and models. Artemis is not affiliated with,
sponsored by, or endorsed by any of those companies.
