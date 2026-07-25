# Third-party notices

Codex Pad is an independent community project. It is not made, supported, or
endorsed by OpenAI, Apple, Work Louder, Tailscale, or the authors of the projects
listed below.

This file records Codex Pad's direct production dependencies, the browser-bundle
transitive dependency, native image-processing boundary, and the open-source
works whose implementation ideas informed Codex Pad. The exact lockfile-derived
production graph is in [`THIRD_PARTY_LICENSES.json`](THIRD_PARTY_LICENSES.json).
Regenerate it with `npm run licenses:generate`; `npm run audit:release` fails if
the inventory, manifests, lockfile, or direct-dependency table diverge.

Codex Pad does not commit `node_modules`. A source checkout obtains dependencies
from the registry tarballs recorded in the inventory; installed package folders
retain their upstream `LICENSE`, `COPYING`, `NOTICE`, or licensing `README`
files. The inventory is an index, not a replacement for those terms. Any
standalone package that redistributes compiled dependencies must copy the
applicable upstream legal files alongside this notice.

## Direct production dependencies

Versions and SPDX expressions below are the exact resolutions in
`package-lock.json`, not the semver ranges in workspace manifests.

| Package | Version | SPDX license | Copyright and upstream | Use in Codex Pad |
| --- | --- | --- | --- | --- |
| `@fastify/static` | `10.1.0` | `MIT` | Copyright 2017-present The Fastify team; [fastify/fastify-static](https://github.com/fastify/fastify-static) | Serve the built local PWA. |
| `@fastify/websocket` | `11.3.0` | `MIT` | Copyright 2017-present The Fastify team; [fastify/fastify-websocket](https://github.com/fastify/fastify-websocket) | Authenticated snapshot and event transport. |
| `fastify` | `5.10.0` | `MIT` | Copyright 2016-present The Fastify team; [fastify/fastify](https://github.com/fastify/fastify) | Loopback HTTP bridge and API routing. |
| `idb` | `8.0.3` | `ISC` | Copyright 2016 Jake Archibald; [jakearchibald/idb](https://github.com/jakearchibald/idb) | IndexedDB persistence in the PWA. |
| `jsqr` | `1.4.0` | `Apache-2.0` | jsQR contributors; [cozmo/jsQR](https://github.com/cozmo/jsQR) | Decode the short-lived pairing QR inside an already installed PWA. |
| `perfect-freehand` | `1.2.3` | `MIT` | Copyright 2021 Stephen Ruiz Ltd; [steveruizok/perfect-freehand](https://github.com/steveruizok/perfect-freehand) | Pressure-sensitive pen and highlighter stroke outlines. |
| `qrcode` | `1.5.4` | `MIT` | Copyright 2012 Ryan Day; [soldair/node-qrcode](https://github.com/soldair/node-qrcode) | Short-lived local pairing QR codes. |
| `react-dom` | `19.2.7` | `MIT` | Copyright Meta Platforms, Inc. and affiliates; [facebook/react](https://github.com/facebook/react) | Browser rendering. |
| `react` | `19.2.7` | `MIT` | Copyright Meta Platforms, Inc. and affiliates; [facebook/react](https://github.com/facebook/react) | Browser component runtime. |
| `sharp` | `0.35.3` | `Apache-2.0` | Copyright 2013 Lovell Fuller and others; [lovell/sharp](https://github.com/lovell/sharp) | Decode, normalize, resize, and safely re-encode inbound images. |
| `web-push` | `3.6.7` | `MPL-2.0` | Copyright 2015 Marco Castelluccio; [web-push-libs/web-push](https://github.com/web-push-libs/web-push/tree/8d9ba1b33bfe0d73ccf3606c59ead4287f50e3b8) | Standards Web Push encryption, VAPID authentication and delivery. |
| `ws` | `8.21.1` | `MIT` | Copyright 2011 Einar Otto Stangvik, 2013 Arnout Kazemier and contributors, 2016 Luigi Pinca and contributors; [websockets/ws](https://github.com/websockets/ws) | WebSocket client/server protocol transport. |
| `zod` | `4.4.3` | `MIT` | Copyright 2025 Colin McDonnell; [colinhacks/zod](https://github.com/colinhacks/zod) | Runtime validation at trust boundaries. |

`perfect-freehand` 1.2.3 corresponds to upstream revision
`f56f097e0e211fffa1601b93883e4d9f9dccf122`; the research snapshot of `main`
was `176e00f2399f4969e1b0965c5921d96a3e50ce9f`. Codex Pad owns its scene model,
tools, and export pipeline.

## Browser-bundle transitive dependency

The PWA build also includes `scheduler` `0.27.0`, licensed `MIT`, copyright Meta
Platforms, Inc. and affiliates, from
[facebook/react](https://github.com/facebook/react/tree/main/packages/scheduler).
The direct browser dependencies in the table above and this scheduler entry are
covered by the license texts and copyright notices in this file.

## Complete production inventory and license scope

[`THIRD_PARTY_LICENSES.json`](THIRD_PARTY_LICENSES.json) contains every external
production package identity locked for all platforms, including nested and
optional packages. It records the package name, exact version, SPDX expression,
registry tarball, direct workspace owners, optional status, and lock paths.

The current lockfile contains these reviewed SPDX expressions:

- `0BSD`
- `Apache-2.0`
- `Apache-2.0 AND LGPL-3.0-or-later`
- `Apache-2.0 AND LGPL-3.0-or-later AND MIT`
- `BSD-3-Clause`
- `BlueOak-1.0.0`
- `ISC`
- `LGPL-3.0-or-later`
- `MIT`
- `MPL-2.0`

For source releases, registry packages retain their own license and notice
files. For a compiled or offline distribution, retain those files and all
copyright/attribution notices. Apache-2.0 works require a copy of that license
and any upstream `NOTICE`; combined expressions require compliance with every
listed license. This source audit does not by itself certify a future standalone
binary or installer.

### Web Push packages

`web-push@3.6.7` is used unmodified under `MPL-2.0`. Its published npm package includes the upstream [`LICENSE`](https://github.com/web-push-libs/web-push/blob/8d9ba1b33bfe0d73ccf3606c59ead4287f50e3b8/LICENSE). MPL-2.0 obligations apply to that dependency's covered source files; Codex Pad's independently authored files are not modifications of them. Any redistribution must retain the MPL notice and make modifications to covered files available under MPL-2.0.

The transitive `http_ece@1.2.0` package declares `MIT` in the immutable npm metadata but its three-file registry tarball omits the upstream license file. The commit-pinned [MIT license](https://github.com/martinthomson/encrypted-content-encoding/blob/0562510a30819f52424724a6fd5504becacd98a1/LICENSE) is Copyright (c) 2015 Martin Thomson. The MIT terms reproduced below apply to this package as well. This exact version/evidence pair is enforced by the release audit; a version change must be reviewed again.

### `sharp` native packages

`sharp` can install platform-optional `@img/sharp-*` artifacts under
`Apache-2.0` and `@img/sharp-libvips-*` artifacts under
`LGPL-3.0-or-later`. Each libvips package README enumerates the native libraries
inside that platform binary, including components under BSD-2-Clause, BSD-3-
Clause, MIT, MPL-2.0, LGPL, FreeType, fontconfig, libpng, libtiff, zlib, IJG,
and the Alliance for Open Media patent license.

Codex Pad loads the upstream shared library; it does not modify libvips. A
distributor that embeds those native artifacts must preserve the platform
package README and applicable license texts, source/relink or replacement
rights, notices, and source-offer duties. The authoritative component list for
the installed artifact is its own `@img/sharp-libvips-*/README.md`, because the
set varies by platform and package version.

## MIT-licensed design and implementation references

### codex-stream-deck

- Upstream: [dazer1234/codex-stream-deck](https://github.com/dazer1234/codex-stream-deck)
- Inspected revision: `f3b61903311e9205e6366bb068977fb7adfd5481`
- License: MIT
- Copyright (c) 2026 Dazer
- Adapted ideas: semantic discovery of version-hashed renderer modules, strict
  six-slot validation, `threadKey` UUID suffix parsing, typed native Micro event
  dispatch, and explicit degraded compatibility state.
- Excluded: official Codex keycap SVGs, project visuals, rollout-log scanning,
  and any generic remote CDP evaluation surface.

### OpenMicro

- Upstream: [stephenleo/OpenMicro](https://github.com/stephenleo/OpenMicro)
- Inspected revision: `73a153dbdbf877505df0fff6dda1f9ec4cd34dfc`
- License: MIT
- Copyright (c) 2026 Stephen Leo
- Adapted ideas: transport-neutral action vocabulary, press/release gesture
  safety, and separation between state aggregation and feedback.
- Excluded: its artwork, internal database reads, AppleScript/keystroke routing,
  and hook-created sessions as substitutes for native Micro slots.

### muxboard

- Upstream: [mrshu/muxboard](https://github.com/mrshu/muxboard)
- Inspected revision: `e4b8375bfb533937cec9815485bad14fdd8b40f4`
- License: MIT
- Copyright (c) 2026 Marek Šuppa
- Adapted ideas: non-overlapping refresh, retained last-valid state,
  stale/offline separation, and snapshot-plus-event reconciliation.
- Excluded: all screenshots and icons, especially provider SVGs extracted from
  CodexBar and the exact Orca logo path.

### cmux-mobile

- Upstream: [jordjones/cmux-mobile](https://github.com/jordjones/cmux-mobile)
- Inspected revision: `d1c2584bbacbfca1b2cf997ac28e632af97158bd`
- License: MIT
- Copyright (c) 2026 cmux-mobile contributors
- Adapted ideas: same-origin bridge/PWA structure, heartbeat, jittered reconnect,
  visibility resume, full-snapshot recovery, and active-target labeling.
- Excluded: its visuals, direct tailnet-IP binding, loopback trust bypass,
  permanent-token URLs, terminal keystroke replay, and terminal surface identity.

### Current downstream file map

The implementation is independently authored. This map records the exact source
files whose design or compatibility boundary is explicitly informed or
corroborated by the references above; it does not claim verbatim copying.

| Reference | Codex Pad file | Reference-informed boundary |
| --- | --- | --- |
| `codex-stream-deck` | `packages/codex-desktop/src/renderer-expression.ts` | Dynamic discovery of version-hashed renderer modules and React-store traversal; Codex Pad supplies its own fixed, bridge-authored expression and validators. |
| `codex-stream-deck` | `packages/codex-desktop/src/cdp-runtime.ts` | Retaining the bridge-created evaluation promise while dynamic imports settle; transport framing, timeouts, and delivery-unknown handling are Codex Pad code. |
| `OpenMicro` | `packages/codex-desktop/src/open-thread.ts` | Corroboration of the public thread deep-link shape; Codex Pad independently enforces a canonical UUID and invokes `/usr/bin/open` without a shell. |

The `muxboard` and `cmux-mobile` entries above informed cross-cutting state and
reconnection architecture. No individual Codex Pad source file is represented
as a substantial source adaptation from either project. Add or revise this map
before release if that boundary changes.

## MIT License text

The following terms apply separately to each MIT-licensed dependency identified
above—including `http_ece@1.2.0`—the `scheduler` browser dependency, and each
implementation reference listed above, with that work's copyright notice as
stated in its entry.

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

## ISC License text for `idb`

Copyright (c) 2016, Jake Archibald <jaffathecake@gmail.com>

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

## Protocol and documentation reference: OpenAI Codex

- Upstream: [openai/codex](https://github.com/openai/codex)
- Current research revision:
  `2deed3fb9c00c74dac3d177ea700d6fb7a94539d`
- Installed-version reference (`rust-v0.145.0-alpha.18`):
  `f84f9a6406cc55b210395f71b4c6aed236fc7ebb`
- License: Apache-2.0
- Upstream notice: `OpenAI Codex — Copyright 2025 OpenAI`
- [Apache-2.0 license](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/LICENSE)
- [Upstream notice](https://github.com/openai/codex/blob/2deed3fb9c00c74dac3d177ea700d6fb7a94539d/NOTICE)

Codex Pad interoperates with the user-installed Codex app-server protocol and
uses hand-authored minimal schemas. It does not redistribute the Codex binary or
commit generated OpenAI protocol bindings. Version-specific generated bindings
are produced only into an application-owned cache or temporary compatibility
directory. This entry is attribution for protocol/source research, not a claim
that Apache-licensed source is bundled in Codex Pad.

## Non-open-source product assets

No OpenAI, Codex, Work Louder, Apple, Tailscale, Elgato/Stream Deck, Orca,
CodexBar, or other provider logos, keycap SVGs, product imagery, screenshots,
extracted icon paths, fonts, video, or trade dress are included. MIT and
Apache-2.0 code licenses do not grant trademark rights or relicense third-party
assets. Codex Pad uses original project artwork and nominative text references
only.

## Distribution requirement

Source archives and packaged releases must include this file and
`THIRD_PARTY_LICENSES.json`. The release audit must fail if either is absent, if
the inventory differs from the production dependency graph, if a direct runtime
notice is omitted, or if protected asset signatures or known official keycap
filenames are detected. Any new direct dependency or substantial source
adaptation must add its exact version, copyright or upstream notice, license,
source URL, and downstream use before release.
