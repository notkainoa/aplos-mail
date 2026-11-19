# Identity collision audit: the proposed "Airmail" direction

2026-10-25. This checks the direction proposed in `research/email-clients/SYNTH-ui.md` §2 against Airmail by Bloop and ten other Mac mail clients. The direction has five parts: the "Airmail" name, the red/blue stripe, sky neutrals with a `#0755dc` accent, hill green for Done, and Newsreader for AI text. It also looks at the current Aplos icon.

**This is not legal advice.** The trademark section reports what public registers show and gives a rough risk level. Before any public naming decision, a trademark lawyer should do a proper clearance search.

**Evidence key.**
- **[V]** means verified. The URL, register record or screenshot path is given.
- **[I]** means my inference or judgement.

**How the evidence was gathered.**
- All captures were made headlessly with Playwright, using scripts in `/Users/knewton/.t3/aplos-research/tools/identity-audit/`.
- Evidence is stored in `/Users/knewton/.t3/aplos-research/ui/identity-audit/` (written as `…/identity-audit/` below).
- No app binary or DMG was downloaded or opened. The capture scripts block `.dmg`, `.pkg` and `.zip` requests and refuse downloads.
- Icon and screenshot images were rendered from the App Store CDN and from product sites only so they could be compared. None of them goes into Aplos.

**Licences.** Every product audited here is proprietary: Airmail, Mimestream, Spark, Superhuman, Apple Mail, Notion Mail, Shortwave, HEY, Canary, Missive, Spike and Avec. Their icons, art, fonts (Super Sans/Serif, Sofia Pro, Really Sans, Moniker, Tiempos, Lyon) and copy are all rights reserved. Aplos may only take ideas from them, never assets. Newsreader is OFL-licensed, which is why Aplos can bundle it.

---

## 0. Bottom line

1. **The name is the real collision.** Airmail is a well-known Mac and iOS mail client:
   - It is actively maintained. The Mac app was at v27.0.2 on 2026-10-19, and the iOS app at v27.0.7 on 2026-10-20.
   - It won an Apple Design Award in 2017.
   - Bloop holds an Italian word mark "airmail" in classes 9 and 42.

   Separately, a French company holds "AirMail" for software and e-mail services, and a UK company holds "AIRMAIL" for messaging. Using "Airmail" for anything a user can see would be **high risk**. Keeping it as an internal codename is low legal risk, but the word already sits in code identifiers and decision docs and could leak. Rename it.
2. **The stripe is generic postal ornament,** not anyone's protected trade dress as far as public registers show. It is low risk on its own. One thing to know: **Bloop's own first Mac icon (2014) was an envelope inside a ring of red and navy airmail stripes.** So stripe plus "Airmail" plus mail client is the one combination that points straight at Bloop. Keep the stripe, drop the name, and never draw the stripe as a ring.
3. **`#0755dc` is ΔE00 4.8 from Avec's brand blue `#0050ff`.** That is the brand SYNTH-ui is trying to move away from. It is also within ΔE 10 of Spark, Missive, Mimestream, Shortwave and Canary. Saturated blue is shared by everyone, so it can't carry the identity, and it sits closest to Avec in particular. **Medium risk.** A deeper "ink" blue (for example `#0b5394`) gets ≥ 8.9 from every reference, or ≥ 10.4 from every brand's primary blue, and fits the paper story.
4. **Hill green, sky tints, cool neutrals and the Newsreader voice are low risk.** No audited client sets AI text in a serif, and none pairs a serif AI voice with green for Done.
5. **The icon motif is crowded but not taken.** Envelope plus airmail border on a blue background also appears today on two Mac utilities (Winmail Viewer and Letter) and on Bloop's 2014 icon. The Aplos scene of envelope, wind, hill and sky is distinctive. **Medium risk**, driven by the motif, not by copying. No change is required.

---

## 1. Inventory

UI accents come from each product's site CSS or its App Store art. They are not taken from inside the apps; I didn't install any. Icon colours are dominant colours from the 512 px App Store artwork (`…/identity-audit/icons/*.png`, sampled by `colors.py`). The side-by-side sheets are `…/identity-audit/icon-compare.png` and `…/identity-audit/icon-sheet.png`.

| Client (status) | Icon motif and colours [V] | Accent and canvas [V unless marked] | Signature mark | Type | AI text styling |
|---|---|---|---|---|---|
| **Airmail** (Bloop S.R.L., Italy; Mac and iOS, updated Oct 2026) | Today: a blue ring (`#047ff9`→`#02c3fe`) around an envelope-flap "V" on white. The Mac squircle has a lighter ring, `#48b5f0`. **2014 Mac icon: a grey envelope disc inside a red/navy diagonal airmail-stripe ring** (red `#ea2e1a`, navy `#3b3b64`, sampled) | Site: grey text on white, logo blue. App: dark sidebar and white list (`appstore/airmail-mac-*.png`). iOS App Store art: **sky cyan `#31dcfc`** over a `#146ae9` band, with line icons of clouds, sun, moon, airplanes and paper planes (`sheet-airmail-ios.png`) | The ring logo | Site: Google Sans. App: system [I] | None seen |
| **Mimestream** (Mac; iOS in beta) | Blue envelope with a paper sheet (`#008bee`, `#1571c5`, pale `#a9d8f5`) | Site tokens copy Apple's system palette: accent `#007aff`, link `#0068da`, green `#64ca56` | None; native AppKit look | System UI | None seen |
| **Spark** (Readdle) | **Paper plane on a sky-blue gradient**, with a yellow and blue wave (`#1f8cf4`, `#53b8ef`) | Site: CTA `#205eff`, link `#006ee5`. The hero is a **sky gradient (`#1b6dff`→`#29a7ff`) with a white horizon arc** (`sites/spark-light-fold.png`) | Paper plane, horizon arc | Sofia Pro (site), system UI (app) | "+AI" badge in a purple gradient (`sheet-spark-canary-mac.png`) |
| **Superhuman** | White envelope on a purple-magenta gradient | Purple `#714cb6`, lilac `#d4c7ff` | Lavender-cloud textures | Super Sans VF. The brand family also has **Super Serif** (declared on the site; [case study](https://medium.com/smith-diction/branding-superhuman-and-grammarly-and-coda-8c57f970bead)) | Sparkle glyph and purple/lavender cards, all in sans (`strip-superhuman-ai-full.png`) |
| **Apple Mail** | White envelope on a blue gradient (`#007bfe`, pale `#a9dbfe`) | System blue `#007aff` / `#0a84ff` | None | SF | Summaries in plain SF (`appstore/applemail-ios-2.png`) |
| **Notion Mail** (**shut down 2026-09-22**; [9to5Mac](https://9to5mac.com/2026/06/25/notion-shutting-down-its-ai-powered-email-client-including-mac-and-ios-apps/)) | App icon not captured: the store page now returns 404 (`pages/notion-mail-appstore-fold.png`) | Notion CTA `#0075de` | Launch art used **postal motifs**: a perforated stamp, postmark wave lines, a paper plane (`pages/notion-mail-blog-fold.png`) | NotionInter, plus **Lyon Text** serif on notion.com | Not seen |
| **Shortwave** | White wave mark on `#346afe` | Dark navy site `#0f0f16`, primary `#356aff` | Wave | Poppins | Blue cards. Green check and red trash as swipe colours (`appstore/shortwave-ios-3.png`) |
| **HEY** (37signals) | Hand wave plus envelope on a blurple-to-blue gradient | Blurple `#5522fa`, cobalt `#0074e4`. Its palette names include **sky `#b6dbff`**, **paper `#f9f7f5`** and green `#299850` | Loud, playful illustration | Really Sans Large, Moniker, Shantell Sans | Not seen |
| **Canary** | Blue swoosh or wing "C" on white | Site background **sky `#7ce2ff`**, blue `#1e35e5`. App art is dark ("night") | Bird | Archivo Narrow, Plus Jakarta Sans | "Copilot" with sparkle, blue "Draft ready" (`sheet-spark-canary-mac.png`) |
| **Missive** | Dark-grey chevron lines on white | Brand `#2266ed` (dark shade `#1c42b1`), green `#2b8e3f` | None | **Tiempos Headline** (serif) for site headings, Inter for body | Not seen |
| **Spike** | Purple @ speech bubble | Purple `#854dff` | None | Poppins | "Magic Message" with a sparkle and a blue Generate button (`appstore/spike-ios-3.png`) |
| *Avec* (prior report, for reference) | — | Brand blue `#0050ff`, Done green `#07aa04`/`#03ce4c`, sky `#36b7ff` (`research/email-clients/ui/avec.md:106,112`) | Green Done flood | System UI | Sparkles |
| **Aplos today** | Illustrated envelope with a red/blue airmail border (`#da3435`/`#2555d3`), a stamp, postmark lines and a label with stars, flying with wind swirls over a green hill in blue sky (`apps/desktop/assets/icon-256.png`) | Site: sky `#9fd3ff`, accent `#0755dc`, stripe `#ee162b`/`#0755dc` on `#fbf8f2` (`apps/web/src/styles.css:16-18,91-95`) | Stripe frame at the top and bottom of every page | Newsreader headings, SF body | (proposed) Newsreader |

The site style data is in `…/identity-audit/sites/sites.json`. HEY's colour variables were read from the live CSS.

**Gaps.**
- I have no in-app captures of the Mac apps for Mimestream, HEY, Superhuman or Missive, only their public marketing.
- I could not see what typeface Superhuman's in-app AI uses.

---

## 2. Airmail (Bloop) specifically

### Verified facts
- **Active and in the same category.**
  - Mac: [id918858936](https://apps.apple.com/us/app/airmail-lightning-fast-email/id918858936), v27.0.2, 2026-10-19.
  - iOS: [id993160329](https://apps.apple.com/us/app/airmail-your-mail-with-you/id993160329), v27.0.7, 2026-10-20, rated 4.25 by 4,533 people.
  - There is also "Airmail for Business" (id1530968324).
  - The listings open with "Apple Design Award 2017 Winner", and [Apple's 2017 newsroom post](https://www.apple.com/newsroom/2017/06/apple-design-awards-celebrate-the-best-in-innovation-and-creativity/) lists "Airmail 3".
  - Source: `…/identity-audit/meta/lookup.json`.
- **Current mark: no stripes.** All three current Bloop icons use the blue ring with a flap chevron. The Business icon is a silver ring on charcoal. Bloop's Gmail app (Bloop Limited, id1462419097) is a white disc with a red flap. See `icon-compare.png` and `icon-sheet.png`.
- **The 2014 Mac icon used the airmail stripe.** [macOS Icon Gallery, "Airmail" 2014](https://www.macosicongallery.com/icons/airmail-2014-09-18/) shows a grey envelope disc ringed by diagonal red, white and navy bars (`pages/mig-airmail-2014-fold.png`). By 2016, airmailapp.com showed the blue-ring icon on iOS ([Wayback 2016](https://web.archive.org/web/20161009122410/http://airmailapp.com/), `pages/wayback-airmail-2016-fold.png`).
- **Sky and flight in the marketing.**
  - The iOS App Store art is a sky-cyan field with outline clouds, sun, moon, stars, airplanes and paper planes.
  - The Mac "Airmail Pro" art repeats the line-icon pattern, airplane included, on an orange background (`sheet-airmail-ios.png`, `crop-airmail-mac-6-pattern.png`).
- **Website.** airmailapp.com is Google Sans, grey on white, with a device mock-up and the ring logo. It has no stripes, no serif and no sky (`sites/airmail-light-fold.png`).

### How close would Aplos look? [I]
- **Visually, the current Airmail and the proposed Aplos look are not alike.** Airmail today is a bright cyan/azure ring, system UI and a dark sidebar. Aplos would be paper cards on cool sky, moss green, a serif voice and an illustrated icon. Nobody would mistake one screenshot for the other.
- **The risk is association, and three things add up:**
  1. Same product name and same category (Mac and iOS mail clients).
  2. Bloop's own history with the airmail stripe on its icon.
  3. Bloop's App Store art of sky, clouds and planes.

  An Aplos that someone describes as "the Airmail-style one", with the stripe as its signature and sky everywhere, invites exactly that link. Mac mail power users are Aplos's target audience, and they are also the people most likely to know Airmail.
- **Where the name has already leaked.** The word appears in code and docs:
  - `apps/web/src/Chrome.tsx:6` exports a component named `Airmail`.
  - `.airmail` CSS classes live in `apps/web/src/styles.css:92` and `apps/desktop/build/dmg-background.html:21`.
  - `DECISIONS.md:15-17` and `PROGRESS.md:12` say "airmail blue" and "an airmail brand".
  - The public landing-page alt text says "an airmail envelope" (`apps/web/src/Landing.tsx:34`). That is descriptive use, and low risk.

  The repo is private today, but codenames tend to spread into release notes, tokens and screenshots.

---

## 3. Trademarks (not legal advice)

### AIRMAIL as a name
Sources:
- USPTO Trademark Search, queried headlessly through the public search box. Raw results are in `…/identity-audit/trademarks/uspto-*.json|png|txt`.
- EUIPO's TMview, which covers EUIPO, the national offices and WIPO. Results are in `trademarks/tmview-*.json|png` (111 hits for "airmail").

| Record | Owner | Classes | Status | Source |
|---|---|---|---|---|
| **IT 2015000086913 "airmail"** (word) | **BLOOP SRL** | **9** (application software), **42** (software design, SaaS) | Registered 2017-07-03. Its 10-year term from filing would have ended 2025-12-23, and TMview shows no renewal entry. **Confirm with UIBM** | [TMview](https://www.tmdn.org/tmview/#/tmview/detail/IT502015000086913), `tmview-detail-IT502015000086913.*` |
| **FR 4268780 "AirMail"** (word) | FICHORGA SAS | 9, 35, **38 (including e-mail messaging services)**, 42 (including software, SaaS) | Registered 2016. **Renewal published 2026-05-15** | [TMview](https://www.tmdn.org/tmview/#/tmview/detail/FR500000004268780) |
| **UK00002486697 "AIRMAIL"** (word) | Dynamical Systems Research Ltd | **38** (messaging services over the Internet and mobile) | Registered, expires 2028-05-06 | [TMview](https://www.tmdn.org/tmview/#/tmview/detail/GB500000002486697) |
| US 77869168 / reg 3881365 "AIRMAIL2" | DocSolid, LLC | **9** (software for routing digital images) | Live | `uspto-airmail2.json`; [Justia](https://trademarks.justia.com/778/69/airmail2-77869168.html) |
| US 85064904 / reg 3913907 "AIRMAIL"; US 85064900 | Urban Airship | 42; 9 | Cancelled; abandoned | `uspto-airmail.json` |
| US "AIR MAIL" (several) | US Postal Service | 14, 18, 25 (merchandise) | Live | `uspto-air_mail.json` |
| US "AIR MAIL" / "AIR MAIL LOOK" | AIR MAIL LLC (a newsletter) | 41 | Live | `uspto-air_mail.json` |
| EUTM for Bloop | — | — | **None found.** The only EM hit was "CAMFIL AirMail", expired | `tmview-airmail.json` |

What the registers show [V]:
- The USPTO has no live AIRMAIL registration in class 9 or 42 for email software.
- A wordmark search for "bloop" finds no Bloop S.R.L. filing.

What I infer [I]:
- Bloop probably still has US common-law rights from more than ten years of App Store use.
- Bloop's Italian registration and the French and UK marks cover the goods and services Aplos is in.

**Risk: high** for any public use of "Airmail" as a name or feature label. **Low** for a codename that stays internal.

### The red/white/blue airmail border ("par avion")
- **No registration found that claims the stripe border itself.** USPTO and TMview searches for "par avion" (171 TMview hits) and "air mail" turn up word marks for clothing, tea, wine, stationery and postal services:
  - La Poste's "PAR AVION de FRANCE" has expired.
  - New Zealand Post's pending "Par Avion Air." is a circle logo, not stripes (`tmview-detail-NZ500000001243279.png`).
  - USPS holds the words "AIR MAIL" for merchandise.
- **History.** The US Post Office Department approved the lozenge border for airmail envelopes in 1928. The design is credited to a private inventor, and envelopes were never required to use it ([Linn's](https://www.linns.com/news/us-stamps-postal-history/2014/december/airmail-flew-with-red-and-blue-borders.html), [Paul Lukas](https://www.inconspicuous.info/p/a-deep-dive-on-air-mail-envelope)). Many stationers still sell bordered envelopes (JAM Paper, Envelopes.com, Amazon listings).
- **Gap.** I did not run figurative or Vienna-code image searches (for example, envelopes plus stripes) at the USPTO or WIPO, so a design registration for a specific stripe artwork can't be ruled out. A specific artwork would not cover the generic pattern anyway [I].

**Risk: low** for the stripe as an ornament [I]. It rises to medium only in combination with the "Airmail" name or in a ring form.

**Side note.** The icon's stamp shows a suspension bridge. The Golden Gate Bridge District's live US marks are class 39 word marks (`uspto-golden_gate_bridge.json`). **Low risk** [I].

---

## 4. Palette and type against the inventory

### Colour distances
All distances are CIEDE2000, computed by `tools/identity-audit/de2000.py`. Full output is in `…/identity-audit/deltaE.txt`.

**Accent `#0755dc`** (LCh 40.7 / 81.0 / 294°). These references are within about ΔE 10:

| ΔE00 | Reference | Product |
|---|---|---|
| **4.8** | `#0050ff` | **Avec** (brand blue) |
| 5.7 | `#205eff` | Spark (CTA) |
| 6.0 | `#2266ed` | Missive (brand) |
| 6.8 | `#0068da` | Mimestream (link) |
| 7.2 | `#146ae9` | Airmail (App Store band) |
| 7.8 | `#1c42b1` | Missive (dark shade) |
| 8.7 | `#356aff` | Shortwave |
| 8.8 | `#006ee5` | Spark (link) |
| 9.1 | `#1e35e5` | Canary |

Airmail's icon ring `#047ff9` is 15.2 away. Apple system blue and Aplos's current `#0682fe` are 13.5 and 16.4.

**Dark accent `#4fa3ff`.** Nearest references:
- 7.2 from Spark's icon `#1f8cf4`;
- 8.7 from Airmail's Mac ring `#48b5f0`;
- 9.5 from Apple dark system blue.

That is the generic system-blue family, so **low** risk.

**Sky `#9fd3ff`.**
- Near pale-blue tints: 2.9 from Apple Mail's icon pale, 3.8 from HEY's sky token, 4.2 from Mimestream's icon pale.
- Further from full-bleed sky backgrounds: 10.3 from Canary's site background, 11.5 from Spark's hero, 13.5 from Airmail's App Store cyan.

Pale sky tints are generic. A full-bleed sky as a mail brand backdrop is used by Spark, Canary and Airmail's marketing.

**Hill green `#2f6f2a`.** The nearest references are Missive's green (11.0), HEY's green (14.9), Aplos's current green (16.9) and Avec's Done green (21.6). A moss green is distinctive among mail clients, which tend to use signal greens. **Low risk.**

**Stripe colours.**
- Website stripe red `#ee162b` is 5.2 from the red in Bloop's 2014 icon stripe. SYNTH's red `#d83237` is 7.5 from it.
- The blues are far apart: 17–20 from Bloop's navy.

Airmail-border red is the same everywhere, so this is not meaningful by itself [I].

### Green for Done plus a serif for AI
- **Green for Done or archive is a convention, not a signature** [V]. Avec floods the card green, Shortwave uses a green check swipe, and HEY and Missive have green tokens.
- **A serif for AI text: none found** [V, within the captures]. Superhuman, Spark, Canary, Spike and Apple Mail all set AI output in their UI sans, and most mark AI with sparkles or purple. Serifs appear only in marketing headings: Missive's Tiempos, Notion's Lyon Text, and Superhuman's Super Serif in the brand family.
- **No client combines green Done with a serif AI voice.** Newsreader is OFL and widely used on the web, so it isn't exclusive, but it doesn't collide with any mail client either.
- **Risk: low.**

### Neutrals
Cool cloud-grey canvases and near-white paper (`#e9edf0`, `#fefefc`) are the Apple-adjacent default that Mimestream and Apple Mail use too [V for those two]. **Low risk.** They also don't distinguish Aplos [I].

---

## 5. The icon

**Convergence on envelope plus airmail border** [V]:
- **Bloop Airmail, 2014 Mac icon.** A striped ring around a circular envelope disc. Historical, but it belongs to the same brand name.
- **Winmail Viewer – Letter Opener** (Letter Opener GmbH, [id411897373](https://apps.apple.com/us/app/winmail-viewer-letter-opener/id411897373), Utilities, updated 2026-10-03). A white envelope with a red/blue airmail border on a blue squircle, with a knife. It is a mail-attachment utility.
- **Letter: just write letters** (Ubelacker Solutions, [id498506154](https://apps.apple.com/us/app/letter-just-write-letters/id498506154), updated 2026-10-06). An addressed airmail-bordered envelope on a blue squircle.
- These came from a scan of 107 Mac App Store icons for "email", "mail client", "inbox", "airmail", "letter" and "par avion": `…/identity-audit/mac-mail-icon-scan.png` and `crop-letter-icon.png`.

**Convergence on sky plus flight** [V]:
- Spark: a paper plane over a sky gradient.
- Newton Mail: a paper plane on violet.
- Notion Mail's launch art: a paper plane, a stamp and a postmark.

**How Aplos differs** [I]:
- It is the only full illustrated scene: envelope, wind swirls, hill, clouds.
- The envelope is tilted and in flight, not a front-on glyph.
- Its stamp and postmark are details, not the shape that reads at small sizes.

At 16–32 px, though, it reads as "airmail envelope on blue", the same thing the Winmail and Letter icons say. **Medium risk** of looking generic, **low risk** of legal trouble. No change is needed for collision reasons. The label with stars on the envelope already conflicts with SYNTH's no-star rule (§2.7), and the UI should not echo it.

---

## 6. Collision table

| Element | Nearest collision | Risk | Why |
|---|---|---|---|
| **Name "Airmail"** (direction codename) | Bloop's Airmail: same category, active, ADA winner. Bloop's IT mark (classes 9/42), Fichorga's FR mark (9/38/42), the UK mark (38) | **High** if any public use. **Low** while strictly internal | Identical name, identical goods. It is already in code identifiers and decision docs |
| **Stripe mark** (undo-send drain, composer edge, site frame) | Bloop's 2014 icon (a stripe ring); Winmail and Letter icons; the 1928 postal convention | **Low** alone; **medium** with the name or in a ring | Generic ornament with no registered rights found. The association with Bloop comes through the name |
| **Accent `#0755dc`** | Avec `#0050ff` (ΔE 4.8), Spark 5.7, Missive 6.0, Mimestream 6.8 | **Medium** | Nearest to the very brand Aplos is moving away from. Blue is commodity, so it can't be the identity |
| **Dark accent `#4fa3ff`** | Spark icon 7.2, Apple dark blue 9.5 | Low | System-blue family |
| **Sky `#9fd3ff`** (tints, site field) | Apple, HEY, Mimestream pales (≤ 4.2); Canary site 10.3; Spark hero; Airmail App Store art | Low; **low–medium** as a full-bleed marketing field | Generic tint. Sky backdrops are common in mail marketing |
| **Hill green `#2f6f2a`** | Missive 11.0, HEY 14.9 | Low | Moss is uncommon among mail clients |
| **Neutrals** | Apple/Mimestream greys | Low | Default territory |
| **Newsreader for AI voice** | None. Serifs appear only in competitor marketing headings | Low | No client sets AI text in a serif |
| **Green Done plus serif AI together** | None | Low | — |
| **Icon** | Winmail Viewer, Letter, Bloop 2014 (envelope plus border); Spark (sky plus flight) | **Medium** (generic look), low legal | A crowded motif, but a distinctive scene |

---

## 7. Minimal changes that keep the sky, paper and hill story

These are recommendations [I], in order of value.

1. **Rename the direction.**
   - Use a descriptive codename that is no competitor's product name, for example **"Paper & Sky"** (the icon's story: paper, sky, hill). Avoid "Postmark" (an email-delivery service), "Courier" (a notification API) and "Spark". "Par Avion" also has many registrations, so avoid it too.
   - In SYNTH-ui and future docs, call the accent "letter blue" or "ink blue", not "airmail blue". Call the mark **"the post stripe"** or "the edge stripe".
   - Rename the `Airmail` component in `apps/web/src/Chrome.tsx` and the `.airmail` classes in `apps/web/src/styles.css` and `apps/desktop/build/dmg-background.html`. A name like `PostEdge` / `.post-edge` works.
   - Keep the lowercase descriptive "airmail envelope" only in alt text, or say "a striped letter". Never put "Airmail" in UI copy, onboarding, the App Store name or keywords, release notes, or the site.
2. **Constrain the stripe's geometry, without dropping it.**
   - Draw it only as a straight, horizontal edge: the undo-send drain, the composer's top edge, and the site's top and bottom frames.
   - Never draw it as a ring, a circular progress indicator, an avatar or badge rim, or an app-icon border. The ring is Bloop's 2014 geometry.
   - Let the motion be the signature. The site already scrolls the stripe as you scroll, and the app's drain can travel in the direction of sending. That way the mark is a moving edge, not a static envelope border.
   - Optional: give the repeat its own rhythm, for example uneven red/blue widths. That would be more ownable than the classic even lozenge. Prototype it first.
3. **Move the accent away from Avec.**
   - Option A, the minimum: keep `#0755dc` and accept that the blue is a commodity. Distinctiveness then has to come from paper, sky, hill and the serif. Risk stays medium because of Avec.
   - Option B, recommended: shift to a deeper ink blue, around **`#0b5394`** (LCh 35 / 42 / 277°). It is ≥ 10.4 from every product's primary blue sampled, and 8.9 from Missive's hover shade. White text on it is 7.8:1, and it is 6.7:1 on the proposed `#e9edf0` canvas. It reads as fountain-pen ink on paper. The website accent would change with it, at `apps/web/src/styles.css:18`.
   - Keep the stripe's blue as a separate, brighter decorative token.
   - Keep the dark `#4fa3ff`.
   - Prototype before deciding. A lower-chroma blue can look less clickable.
4. **Keep everything else as proposed:** sky tints, cool paper neutrals, moss hill green for Done, and Newsreader for Aplos's own voice. Nothing in the inventory collides with them.
5. **Icon: no change needed.** If the icon is ever revised, the scene (hill, wind, the letter in flight) is the ownable part, more than the striped border. Don't add more airmail iconography such as a par-avion label, stars or plane silhouettes to UI surfaces.

---

## 8. Open questions for the owner

1. Do you intend to use the word "airmail" anywhere public, such as taglines or feature names? If so, get a clearance opinion first. Bloop and Fichorga both hold marks that cover software and e-mail.
2. Ink blue (`#0b5394`-ish) or keep `#0755dc`? Either way, the website and app should change together.
3. Should "Aplos Mail" itself get a professional clearance search before the public release? This audit did not cover it.

---

## Evidence index

All paths are under `/Users/knewton/.t3/aplos-research/ui/identity-audit/` unless marked otherwise.

- **Icons:**
  - `icon-compare.png` (Aplos, Bloop 2014 and current, Spark, Mimestream, Apple Mail, Canary, HEY, Superhuman, Shortwave, Missive, Spike, Notion, Edison, Newton);
  - `icon-sheet.png`, `icons/*.png`;
  - `mac-mail-icon-scan.png` (107 Mac App Store icons), `crop-letter-icon.png`.
- **Airmail:**
  - `pages/mig-airmail-2014-fold.png`, `pages/mig-airmail-zero-fold.png`;
  - `pages/appstore-airmail-mac-fold.png`;
  - `pages/wayback-airmail-2015-fold.png`, `pages/wayback-airmail-2016-fold.png`;
  - `sites/airmail-{light,dark}-fold.png`;
  - `sheet-airmail-mac.png`, `sheet-airmail-ios.png`, `crop-airmail-mac-6-pattern.png`.
- **Other clients:**
  - `sites/*-light-fold.png`, `sites/*-light-full.png`, `sites/sites.json`, `sheet-sites-light.png`;
  - `appstore/*.png`, `sheet-ios.png`, `sheet-spark-canary-mac.png`;
  - `strip-superhuman-ai-full.png`, `strip-mimestream-full.png`, `strip-spark-ai-full.png`;
  - `pages/notion-mail-blog-fold.png`, `pages/notion-mail-appstore-fold.png`.
- **Trademarks:**
  - `trademarks/uspto-{airmail,air_mail,airmail2,bloop,golden_gate_bridge}.{json,png,txt}`;
  - `trademarks/tmview-{airmail,airmail-p2,paravion}.json`;
  - `trademarks/tmview-detail-{IT502015000086913,FR500000004268780,GB500000002486697,NZ500000001243279}.*`.
- **Computations:** `deltaE.txt`. Scripts are `de2000.py`, `search_accent.py` and `colors.py` in `/Users/knewton/.t3/aplos-research/tools/identity-audit/`.
- **App Store metadata:** `meta/lookup.json`, `meta/*_macSoftware.json`, `meta/*_software.json`.
- **Aplos sources:**
  - `apps/desktop/assets/icon-256.png`, `apps/web/public/og.png`;
  - `apps/web/src/styles.css:9-18,91-98`, `apps/web/src/Chrome.tsx:5-7`, `apps/web/src/Landing.tsx:34`;
  - `apps/desktop/build/dmg-background.html:20-21`;
  - `DECISIONS.md:15-17`, `PROGRESS.md:12`;
  - `research/email-clients/SYNTH-ui.md` §2.
