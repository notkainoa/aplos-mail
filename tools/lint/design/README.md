# Design lint

Enforces `plans/DESIGN.md` section 12.2 on the renderer. One core, three front doors:

| Front door | File | Status |
|---|---|---|
| Standalone CLI | `run.mjs` | Runs today. Needs only `postcss` and `typescript`. Both are in `node_modules` today, but only transitively (`postcss` via `vite`, `typescript` via the desktop toolchain), and no `package.json` declares them. plat-ci should add `postcss` and `typescript` to the root `devDependencies`; this package may not edit `package.json`. |
| ESLint 9 flat-config plugin | `eslint-plugin.mjs` | Tiny adapter, **not executed in Phase 0** (ESLint is not installed). Only its shape and one fake-context report are unit-tested. |
| stylelint plugin array | `stylelint-plugin.mjs` | Tiny adapter, **not executed in Phase 0** (stylelint is not installed). `stylelint` is imported lazily inside each rule, so the module loads without it. Only its shape is unit-tested. |

Rule logic lives once, in `rules/<rule-id>.mjs`, and runs on a PostCSS AST (CSS) and on the TypeScript compiler API AST (`.ts .tsx .js .jsx .mjs`). Each rule exports `{id, description, appliesTo: ['css'|'ts'], check(fileContext) -> [{line, column, message}]}`. The adapters only wrap `check`.

## Run it

```
node tools/lint/design/run.mjs                      # default scope from config.mjs
node tools/lint/design/run.mjs apps/desktop/src/renderer/home   # a folder or files
node tools/lint/design/run.mjs --rule no-raw-color --rule button-variant <paths>
node tools/lint/design/run.mjs --json <paths>
node tools/lint/design/run.mjs --no-ignore <paths>  # used by the tests to lint fixtures
node --test tools/lint/design/design-lint.test.mjs
```

Output is `file:line:col rule-id message`. Exit code 1 on any violation, 0 when clean, 2 on a usage error.

## What each rule bans, and why

| Rule | Bans | DESIGN |
|---|---|---|
| `no-raw-color` | Hex colours, `rgb() rgba() hsl() hsla() hwb() lab() lch() oklab() oklch() color()` in CSS values and in any TS string or template (`style={{color:'#fff'}}`, `` `${x} #0b5394` ``); named colours (`red`, `white`...) in colour properties and in SVG colour attributes (`fill`, `stroke`, `color`, `stopColor`, `floodColor`, `lightingColor`; `currentColor` and `none` are fine); `color-mix()` containing a literal colour. `transparent`, `currentColor`, `inherit` and `var(--...)` are fine, so `color-mix(in srgb, var(--ink) 8%, transparent)` passes. Raw colours inside `var()` fallbacks and custom properties fail too. | 4.1 rules, 12.2 |
| `no-decoration` | `linear- repeating-linear- radial- conic-gradient()`, `backdrop-filter` (CSS, style key, strings), 3D transforms anywhere (`perspective`, `perspective() rotateX() rotateY() rotate3d() matrix3d() translateZ() scale3d()`, `translate3d()` with a non-zero z, the `rotate` property with an axis or vector, `transform-style: preserve-3d`, `backface-visibility`), including the individual style keys and TS strings, and the old class names `post-edge airmail skyscene sky-scene dock-pill deck has-next low-line reader-dock` in selectors, `className` strings, `classList` calls, `.class` selector strings and CSS-module lookups (`styles.readerDock`, `styles['reader-dock']`; camelCase spellings count). | 2.3 (5, 6), 2.4, 4.6, 4.9, 13 |
| `no-literal-motion` | Literal durations (`120ms`, `.2s`) and easings (`cubic-bezier() steps() linear()` and the `ease`, `ease-in`, `ease-out`, `ease-in-out`, `linear` keywords) in `transition*` and `animation*`; a literal duration or easing in any custom property (`--x: 120ms`, `'--x': '120ms'`); a `cubic-bezier(` or `steps(` string anywhere in TS (only the generated `motion.ts` may hold one); `.animate(keyframes, options)` with a literal `duration`, `delay`, `endDelay` or `easing`, directly, through an options constant or through a same-file const, or a bare number as options; `setTimeout`/`setInterval` with a literal or same-file const delay whose callback writes `style.transform/opacity/transition/left/top/width/height/margin*/...` or toggles a class named like enter, leave, exit, animate, fade, slide. `var(--dur-*)`, `var(--ease-*)`, `var(--spring-*)` and `dur.x` imports are fine. A zero duration is allowed. | 4.8, 12.2 |
| `no-layout-motion` | `transition` or `transition-property` containing `all`, `width`, `height`, min/max sizes, `padding* margin* inset*`, `top left right bottom`, `flex*`, `grid-template*`, `font-size`, `font-weight`, `letter-spacing`, `line-height`, `border-width`, `gap`; the same in `style` objects, strings and `el.style.transition`; any `@keyframes` or WAAPI keyframe property outside transform, opacity and colour (`background-color color border-color fill stroke box-shadow outline-color`, plus the individual `translate rotate scale` transforms). | 5 rule 7, 4.8 |
| `hover-no-layout` | In a rule whose selector contains `:hover`, anything but colour and fill: `color background background-color border-color outline-color fill stroke text-decoration-color box-shadow opacity visibility cursor` and `--hover*`/`--press*` custom properties. Also a keycap (`<Kbd>`, `<kbd>`, or an element whose class contains `kbd` or `keycap`) rendered under a condition that mentions hover (a `hover`-named variable, or state set from `onMouseEnter`/`onPointerOver`). | 3 (11), 5 rule 17 |
| `no-literal-size` | Literals in `padding* margin* gap row-gap column-gap font-size line-height font letter-spacing border-radius (and corner longhands) box-shadow z-index`, in CSS, in style objects (a number counts as px) and in inline strings. Allowed: `0`, `1px` hairlines (spacing, gap, shadow), `100%` (not for radius), `auto`, `normal`, `inherit/initial/unset`, `var(--...)`, and `calc() min() max() clamp()` whose literals are unitless multipliers, `0`, `1px` or `100%`. | 4.3-4.6, 12.2 |
| `no-static-will-change` | `will-change` in a stylesheet, a style object or a string. `el.style.willChange = ...` (the dynamic path `motion.ts` uses) and `will-change: auto` pass. | 5 rule 14 |
| `reduced-motion-covered` | An `animation` / `animation-duration` without a `var(--dur-*)` duration (the generated reduced-motion block only neutralises those); an `@keyframes` not used by an `animation` in the same file (mark WAAPI exports with a comment containing `waapi`); a loop (`infinite`, or ten or more iterations) whose duration is not `--dur-breathe` or `--dur-status`. The same checks run on TS: style objects, inline strings, and `.animate()` options (`iterations: Infinity` or 10 and over needs `dur.breathe` or `dur.status`). | 4.8, 11 (5) |
| `no-banned-icon` | Imports (default, named, aliased, namespace member) and JSX tags of Sparkles, Sparkle, Wand, Wand2, WandSparkles, Stars, Star, StarOff, StarHalf, Brain, BrainCircuit, BrainCog, Bot, BotMessageSquare, BotOff and anything whose name has the word star, bot or contains sparkl, wand, brain, robot, from an icon module (`lucide`, `icon`, `symbol`, `phosphor`, `tabler`...); imports of those names from any module (an aliased `Sparkles` from `./glyphs` fails); SF Symbol and icon names in any string (`sparkle`, `wand.and.stars`, `wand.and.rays`, `star.fill`, `apple.intelligence`, `brain.head.profile`, anything starting `sparkle` or `wand.`, and any multi-word name with a banned word such as `wand-sparkles`, `brain-circuit`, `star-off`, `bot-message-square`, `WandSparkles`); a lone word (`star`, `brain`, `bot`, `robot`) only where it is plainly an icon name: a prop or key named `icon`, `symbol`, `glyph`, `systemImage`, a `name` prop on an `*Icon` element, or the argument of an icon helper; the glyphs and entities for sparkles, stars, wand, robot, brain (also `\2605`-style CSS escapes) in strings, JSX text and CSS values. `Restart` and `Start` are not stars; `bookmark` is the bookmark icon. | 4.7, 9 rule 8 |
| `no-banned-string` | The phrase list of DESIGN 10 and 13 (case-insensitive, word-bounded): "Swipe through them", "Hold to talk", "Hold Space to talk", "Tap to write", "Hide all", "Todo", "Todos", "Be here now", "Sent with", "Ask me anything", "magic", "AI-powered", "AI powered", "Copilot", "Ready when you are", "Waiting on you", "No reply yet", "All clear for now", "Making room for your mail", "Aplos needs a moment", "Couldn't summarize this email", "Your day beside your mail", "A comfortable place for your mail", "Make light work of your inbox", "A little less inbox", "Aplos is ready when your day begins", "Skypaper", "Airmail", "par avion"; "Smart" or "Beta" alone as a label; and any `!`. Scanned only in copy positions: JSX text and string children, JSX string props (not `className id key data-* type` and the like, and not lowercase code-like strings in unknown props), string values of properties whose last word is label, title, description, placeholder, hint, tooltip, message, copy, text (plus subtitle, caption, heading, headline, summary), so `emptyLabel` and `confirmText` count and `context` does not; string arguments of calls that are not known code calls (`toast('...')`, `window.confirm('...')`, `group('...', rows)`; an exclamation mark fails in copy helpers and in sentence-like strings elsewhere); assignments to `document.title`, `.textContent`, `.innerText`, `.title` and similar; `setAttribute('aria-label'|'title'|..., '...')`; and CSS `content`. A same-file const used as copy is followed. | 2.3 (6), 9 rule 8, 10, 13 |
| `button-variant` | `<Button variant="...">` other than `filled`, `text`, `icon`, including every string branch of a conditional, logical or same-file const expression, an inline `{...{ variant: 'ghost' }}` spread, and any aliased import (`import { Button as Btn }`). | 4.6, 12.2 |

The Avec hex values of `lint/identity-references.json` (when it exists) and `#e5e4e1`, `#0682fe`, `#0a9c0a` need no rule of their own: every hex is already banned outside the token source by `no-raw-color`.

## What is checked beyond plain declarations

- **Style objects.** `style={{...}}`, objects typed `CSSProperties`, objects under a key named `*style`, `Object.assign(el.style, {...})`, same-file objects referenced as `style={x}`, `Object.assign(el.style, x)` or spread into a style object (however few keys they have), and any object with two or more style-looking keys. Numbers count as px only inside these objects, so a plain `{ top: 40, gap: 8 }` is left alone.
- **Imperative writes.** `el.style.x = ...`, `el.style['--x'] = ...`, `el.style.setProperty(...)`.
- **Inline CSS text.** A string such as `'padding: 0 7px; will-change: transform'` or `el.style.cssText = ...` is read as declarations.
- **Embedded stylesheets.** A string or template that contains `{ }` and parses as CSS (a `<style>{`...`}</style>` block, a `css` tagged template) is parsed with PostCSS and every declaration goes through the same rules, selectors included. `reduced-motion-covered` reads their animation declarations but not their `@keyframes`.
- **Constant folding.** `+` chains and template substitutions whose parts are literals or same-file consts are joined before the rules read them: `'#0b' + '5394'`, `7 + 'px'`, `` `${13}px` ``, `` `opacity ${d}ms` `` with `const d = 120`.
- **Same-file indirection.** `const t = 'all 120ms'; style={{transition: t}}`, `const v = 'pill'; <Button variant={v}>`, `const L = 'Hide all'; <b>{L}</b>`, a keyframes or options constant passed to `.animate()`, a const duration or easing inside options, a const timer delay, and a named timer callback are followed to their const initializer.

## Exemptions

Only token sources and generated files are exempt (`config.mjs`): `renderer/ui/tokens.json` and `renderer/ui/generated/**`. Test files (`*.test.*`) and this tool's own `tools/lint/design/fixtures/**` are skipped because they plant violations on purpose; a `fixtures/` folder inside the renderer (mock mail data, say) is linted like any other code. `renderer/legacy/**` (today's renderer, moved there by restructure step 1 and deleted in Phase 2) is skipped.

**Generator output contract.** The token generator writes `apps/desktop/src/renderer/ui/generated/tokens.css`, `motion.ts` and `contrast-pairs.json`, and nothing else is exempt. If it wrote `ui/tokens.css` or `ui/motion.ts` (today's legacy names) they would fail with hundreds of hex and duration violations. `apps/web` is outside the include glob until its redesign.

There are no inline disable comments. The CLI has none to honour. When the adapters are wired in, the config should switch the tools' own directives off (`linterOptions: { noInlineConfig: true }` in ESLint, `ignoreDisables: true` in stylelint). There is no escape hatch. A new token goes in `tokens.json`; a genuinely needed exception is a DESIGN change.

## Evasions deliberately left to the screenshot harness

Static analysis cannot see these; the harness (DESIGN 12.5) catches the visible result.

- Values built at run time: `` `${a}${b}` `` where both parts are variables, `[0, 7].join('px ')`, values read from an imported module or a function result (`padding: spacing(3)`). The rule sees a non-literal and passes it.
- Constants defined in another file and imported into a style object or a `.animate()` call. Same-file constants are followed; imported ones are not.
- Computed property names that are not string literals, and `Object.fromEntries`-style style construction.
- Motion driven by `requestAnimationFrame`, `await sleep(n)` or a promise chain rather than a literal timer; layout driven per frame by React state (`width` set from a spring value); a spring solver writing `width`. The harness's layout-shift check and the performance suite see these.
- Hover that reveals layout through JS (a class toggled by an `onMouseEnter` handler that changes size) rather than `:hover` or a `<Kbd>` under a hover condition. The harness hovers every interactive element and fails on any box that moves by more than 0.5 px.
- Colour or size smuggled through a library prop other than the colour attributes listed above (a charting component given `series="red"`). Named colours are checked in colour properties of style objects and in the SVG colour attributes.
- `<Button>` shadows: a differently named component that renders `variant="pill"` and is not an import alias of `Button`.
- Copy that is built from variables (`'Hide ' + word`) or that comes from the engine or the AI. A constant concatenation is folded and checked. The DOM text scan of the harness covers rendered strings.
- System colour keywords (`Canvas`, `CanvasText`, `Highlight`) are not flagged, so a forced-colors block may use them.

## Known approximations

- The `star` icon-name check works on words, so `Starter` and `Restart` pass and `StarIcon` fails. A lone `star`, `brain`, `bot` or `robot` string is a banned name only in an icon position (see `no-banned-icon`); `data-state="star"` passes. A multi-word string with a banned word fails anywhere, so a CSS class `star-rating` is reported.
- A hex-looking string such as `'#abc'` is treated as a colour unless it is an anchor or reference: it sits in a `location.hash` comparison, an `href`/`to`/`id` value, a `querySelector` call, or follows `Fixes `, `See `, `-`, `/`, `?`, `=` or `&`.
- Non-icon imports are checked only for the unmistakable names (`Sparkles`, `Wand2`, `Brain`...) and the substrings sparkl, wand, brain, robot, so a hook such as `useStarred` is left alone.
- `no-banned-string` reads string arguments of every call that is not in its list of code calls (`querySelector`, `includes`, `getItem`, `classList.add`, `console.*` ...). A phrase that is not copy but is passed to some other function can be reported; rename it or build it from tokens.
- `reduced-motion-covered` pairs `animation-iteration-count` with an `animation-duration` or `animation` in the same rule or the same object only.
- `z-index` has no token family in DESIGN section 4 yet. The rule accepts any `var(--...)`, `0` and `auto`; the README of the token owner should name the layer tokens (`--z-menu` and so on).
