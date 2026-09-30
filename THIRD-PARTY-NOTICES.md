# Third-party notices

This project is an unofficial plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and includes code and assets derived from third-party sources. Their licenses are reproduced below as required. This project itself is licensed under [MIT](LICENSE).

## DeepSeek Harness (deepseek-ai/deepseek-harness)

- Website: https://github.com/deepseek-ai/deepseek-harness
- License: MIT, Copyright (c) 2026 DeepSeek

Portions of this repository are derived from, ported from, or vendored from the DeepSeek Harness repository and its published npm packages (`@deepseek-ai/*`), including but not limited to:

- `packages/helper/assets/chat.css`, `theme.css`, `observation-frame.css` — the chat UI token sheets and component styles ported from the official client packages (`packages/client/ui-chat`, `ui-tool`, `ui-primitives`).
- `packages/computer-use` — vendored from the official `packages/experimental/tool-computer-use` package, then renamed and modified.
- `packages/helper/assets/deepseek-avatar-square.gif` — the default floating-ball avatar, shipped unchanged from the official repository (`apps/desktop/renderer/deepseek-avatar-square.gif`).
- Floating-window / overlay-guard semantics and timing constants ported from the official desktop app.

```
MIT License

Copyright (c) 2026 DeepSeek

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
```

DeepSeek, the DeepSeek logo, and the DeepSeek avatar artwork are trademarks or copyrighted works of DeepSeek AI. This unofficial project claims no affiliation with or endorsement by DeepSeek AI.

## Shiki

- Website: https://shiki.style
- License: MIT

Syntax-highlighting grammars and runtime under `packages/helper/assets/vendor/` are built from Shiki.

```
MIT License

Copyright (c) 2017 Pine Wu
Copyright (c) 2022 Anthony Fu

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
```

## Other dependencies

Runtime and development dependencies declared in the workspace packages (for example `koffi`, `zod`, `tsdown`, `typescript`, `vitest`) keep their own licenses as published on npm; this repository does not vendor or redistribute their source.
