# PR #21 review (onboarding window + first-sync loading screen)

Reviewed 2026-10-25 at head 2d88846 by a 5-lens review workflow; every finding below was confirmed by at least 2 of 3 skeptics trying to refute it. Not fixed yet (research/planning phase).

## In plain English

The new onboarding mostly works, but the way it pauses AI during setup can get stuck: if you close the onboarding window at the wrong moment, that account stops getting AI triage until you restart the app. There are also a handful of smaller keyboard, window-timing and wording bugs. None are dangerous; all are fixable in a day. The UI revamp should fix these as part of reworking onboarding.

## Findings (several reviewers found the same deferAI problem from different angles; they are listed as found)

### [medium] Closing a 'Show welcome' onboarding window after adding an account turns off sync AI for that account for the rest of the session
`apps/desktop/src/main/electron.ts:73`

**Scenario.** A returning user (onboardingDone already true, mail window open) opens Settings → Show welcome, picks 'Add another' and connects an account. AddAccountForm sends account.connect with setup:true, so the engine adds the account to deferAI (service.ts:788). The user then closes the onboarding window with the red button or Cmd+W instead of going through the loading screen. The window's 'closed' handler (electron.ts:73) skips finishOnboarding because `main` exists. Even if finishOnboarding did run, line 77 only sends settings.update when onboardingDone is false. As a result the engine never receives the onboardingDone patch that clears deferAI (service.ts:778), and setup.run never runs. Every later sync of that account returns early at service.ts:712 (`if(deferAI.has(a.id))return;`), so new mail gets no importance/reply/todo classification and no automatic calendar extraction until the app restarts. Only on-screen rows get lazy summaries. I reproduced this against the engine: with setup:true and onboardingDone already true, two later syncs added j1:101 and j1:102 and nothing was summarized; the same run with setup:false summarized all four threads. The same leak happens on first run if the onboarding window is closed while an account.connect (Google OAuth in the browser, or a slow IMAP login) is still pending: finishOnboarding's settings.update clears deferAI first, and the connect then calls deferAI.add afterwards. The DECISIONS 'safety net' (closing clears deferAI) does not cover either path.

**Fix.** Don't tie the lifting of deferAI to onboardingDone changing. Option 1: in the onboarding window's 'closed' handler, when not quitting, always tell the engine setup is over, e.g. a new `setup.end` method that clears deferAI and starts the deferred AI pass in the background. Option 2, more robust and fixes the late-connect race too: make the deferral one-shot in the engine. Skip AI only for the connect-time sync, delete the id from deferAI right after, and have setup.run (or a setup.end) select unsummarized threads as it already does.

### [medium] Closing the onboarding window after the first sync has finished means the initial mail never gets the sync AI pass
`apps/desktop/src/engine/service.ts:778`

**Scenario.** First run: the user connects Gmail in onboarding (setup:true). The connect-time sync downloads the first window of mail with AI held back while the user is on the AI-key and microphone steps. The user then closes the window (the code says 'Closing it is the same as finishing'). finishOnboarding sends settings.update {onboardingDone:true}, and service.ts:778 clears deferAI. That only affects later syncs, and the threads already downloaded are never classified. I reproduced this against the engine: after connect setup:true, completing the first sync, sending settings.update onboardingDone:true and running another sync, summarize was called 0 times and all 3 threads stayed importance 'important'. The mail window then opens with the whole initial inbox unclassified in Home: no Low-importance split, no todos or due dates, no automatic calendar events. Rows are only fixed lazily, two at a time, as they scroll on screen (MailList summarizeRow). The new test 'closing onboarding before its loading screen does not leave new mail without AI' only covers a sync that is still in flight when the window closes.

**Fix.** When deferral is lifted without setup.run (onboardingDone set while setupJob is unset, or the new setup.end), queue the same background pass runSetup uses: classifyIncoming over each deferred account's unsummarized new/spam threads, tracked in `jobs`. Then closing early still gets the initial mail classified.

### [low] second-instance during startup opens a mail window before the first-run decision, leaving both windows open
`apps/desktop/src/main/electron.ts:303`

**Scenario.** The 'second-instance' handler calls focusMain() without the `started` guard that 'activate' has. Electron only emits it after app ready, but `started` is set much later, after keychain unlock (which can show a prompt), engine start and state.get. If a second launch arrives in that window (e.g. `open -n`, launching the binary from a terminal, or a script), focusMain finds no onboarding window and openMain() creates the mail window. On a first-run data folder, line 334 then also calls openOnboarding(). The mail window's App sees onboardingDone=false and calls onboarding.open. If the user then closes the onboarding window, the closed handler does nothing because `main` exists, so onboardingDone is never saved and onboarding comes back on every launch. On a returning-user folder, line 334 assigns `main=createWindow()` again, orphaning the first mail window. That part predates this PR.

**Fix.** Guard it the same way as activate: `app.on('second-instance',(_e,argv)=>{if(started)focusMain();for(const arg of argv)if(/^(mailto|aplos):/i.test(arg))handleLink(arg);});`. handleLink already queues links before `started`. Also consider `if(!main)main=createWindow()` at line 334.

### [low] Finishing onboarding shows the mail window before it has painted, defeating the wait for ready-to-show
`apps/desktop/src/main/electron.ts:68`

**Scenario.** finishOnboarding (line 78) calls openMain(), which creates the mail window and immediately calls main.show() and main.focus(). Until now a newly created mail window was only shown on 'ready-to-show' (line 126). At the end of first run, a 1360×900 window with a transparent background and sidebar vibrancy, but no content yet, appears and takes focus next to the onboarding window. Its content arrives after the renderer loads and state.get returns, which can take a while for a freshly synced mailbox. The onboarding window, meanwhile, is only closed on ready-to-show. This contradicts the stated intent ('closes the onboarding window once the mail window can be shown') at the most visible moment of first run. I checked the Electron v44.7.2 source: ready-to-show still fires for an already visible window, so the onboarding window does close. The issue is only the blank flash.

**Fix.** In finishOnboarding, when creating the mail window, don't call show() synchronously. Create it with `main=createWindow()`, and on 'ready-to-show' show and focus it, then close the onboarding window in the same callback. Keep openMain's immediate show() only for the Dock/activate path, where a window is already expected.

### [medium] deferAI entry leaks for the whole session when onboarding ends without setup.run while onboardingDone is already true, so background AI stops for that account
`apps/desktop/src/engine/service.ts:788`

**Scenario.** Only two things clear `deferAI`: runSetup's finally block (line 640), and `settings.update` when the patch has onboardingDone:true and no setup job is running (line 778). The electron 'closed' handler (electron.ts:73) calls finishOnboarding only when there is no main window, and finishOnboarding sends settings.update only if onboardingDone is false. Three ways to hit this:
(1) Settings > Show welcome > Add another > connect with setup:true > close the onboarding window. The main window exists, so the engine is never told.
(2) First run: click 'Continue with Google', close the small window while the OAuth consent is still open in the browser, then finish consent. finishOnboarding has already set onboardingDone, so the later `deferAI.add` sticks.
(3) account.disconnect never removes the id, so disconnecting and reconnecting through Settings stays deferred.
In all three, every later sync of that account returns at line 712 before classifyIncoming until the engine restarts. That means no background summaries or importance, no reply refresh, and no auto-calendar for its new mail. Rows on screen still get lazy summaries. I reproduced this with a scratch engine test: onboardingDone=true, connect with setup:true, new mail arrives, manual sync gives 0 summarize calls.

**Fix.** Don't key the deferral on an in-memory per-account flag that only onboarding completion clears. Options: only defer when onboardingDone is false and drop the account from deferAI in account.disconnect; or add an engine method (e.g. `setup.release`) that the onboarding window's 'closed' handler always calls, whether or not a main window exists. That method clears deferAI and starts the background pass for the released accounts.

### [medium] Closing the first-run onboarding window after the connect-time sync has finished leaves the initial mailbox without the AI pass
`apps/desktop/src/engine/service.ts:778`

**Scenario.** The user connects Gmail in onboarding (setup:true). The connect-time sync downloads up to 500 threads and skips AI because of deferAI. While the user is on the AI-key or mic step, they close the window, which electron.ts treats as 'the same as finishing'. finishOnboarding sends settings.update {onboardingDone:true}, and line 778 only runs `deferAI.clear()`. Nothing re-runs classification for threads that were already synced. Later syncs are incremental, so they only classify new arrivals. The whole first mailbox keeps Gmail snippets and Gmail-label importance, with no auto-calendar extraction. Rows are only summarized lazily as they scroll on screen. The same happens after Cmd+Q during onboarding, relaunch, then close. The new test only covers closing while the sync is still running. I reproduced it in a scratch test: connect, wait for the sync, settings.update onboardingDone gives 0 summarize calls.

**Fix.** When onboarding ends without setup.run (the !setupJob branch here, or the release hook from the previous finding), start the same background pass runSetup uses: unsummarized new/spam threads of the deferred accounts, with no wait. Alternatively, record the thread ids skipped while deferred and classify them when the deferral is lifted.

### [low] A second setup.run (Retry, or Show welcome again) collides with the previous run's still-running background pass because the AI request id is fixed
`apps/desktop/src/engine/service.ts:634`

**Scenario.** runSetup uses fixed request ids `setup-ai-<account>` and `setup-rest-<account>`, and `ai()` throws 'This AI request is already running.' for an id that is already running. One example: account A syncs and B fails, A has more than 40 unsummarized threads so its `setup-rest-A` job is still going, and the user clicks Retry. The new pass for A fails at once. classifyIncoming catches the error as a cancellation and emits 'Mail synced for A; automatic AI processing was cancelled.' The 'Summaries for Home' row then reports done counts that leave out A. The same happens if the first run's home pass was capped at 60 s and is still running, and when Show welcome runs setup again in the same session (the main window shows the toast). I reproduced the 'cancelled' error with 200 threads and two back-to-back setup.run calls.

**Fix.** Give each run unique request ids (e.g. append a run counter), or have a new runSetup leave out threads already covered by a running setup pass. Another option is to await or abort the previous setup passes for the same account before starting new ones.

### [low] While deferred, replies to already-summarized threads are never re-summarized; setup.run skips them because they still have a real summary
`apps/desktop/src/engine/service.ts:618`

**Scenario.** syncAccountOnce returns at line 712 for deferred accounts, so it also skips the `replies` refresh, which normally updates summary, replyStatus and action for new mail in existing threads. runSetup then picks only `!hasRealSummary(t)` threads, so a reply on a thread that already had an AI summary is never processed, and the list's lazy summarizer also skips threads that have a real summary. Show welcome adds every real account to deferAI during its sync, so a reply that arrives in that sync keeps the old summary, action and reply state. The same applies to every sync of an account that leaked in deferAI (first finding). I reproduced it in a scratch test: an existing summarized thread gets a reply during setup.run, which ends with 0 summarize calls and the old summary.

**Fix.** While deferred, record the fresh, reply and spam ids a sync skipped, and have the setup or background pass classify them with the same refresh and summaryOnly sets the normal sync path would have used. Alternatively, defer only accounts with no cursor yet (their first sync) and let existing accounts classify as usual.

### [low] Connecting several accounts in onboarding leaves the main window filtered to the last one
`apps/desktop/src/engine/service.ts:786`

**Scenario.** account.connect still sets `s.selectedAccountId=a.id` on every connect, including setup:true. The new flow encourages adding several accounts ('Add every address you use. They all land in one calm inbox'). After adding a Gmail and then a work account, the main window opens scoped to the work account: Home, Drafts, Calendar and Sync all follow selectedAccountId (App.tsx:180). The first account's mail, including the AI-prepared Home set, looks missing until the user switches to 'All accounts'.

**Fix.** Leave selectedAccountId unchanged when p.setup===true (it is 'all' on a fresh install), or set it to 'all' in runSetup or at onboarding finish when more than one real account exists.

### [medium] Accounts connected from onboarding can stay excluded from sync AI until the app restarts (deferAI is never cleared)
`apps/desktop/src/engine/service.ts:788`

**Scenario.** When `account.connect` gets `setup:true`, it adds the account to the engine-global `deferAI` set (service.ts:788). Every `syncAccount` then returns before `classifyIncoming` while the account is in that set (service.ts:214 of the diff hunk, `if(deferAI.has(a.id))return;`). Only two things remove it: `runSetup`'s `finally`, or `settings.update` with `onboardingDone:true` while no setup job is running (service.ts:778). Two ordinary flows reach neither.

(1) Re-opened onboarding. The user clicks Settings → Help & about → Show welcome, then Add another, connects Gmail, and closes the onboarding window with the red button or Cmd+W before the loading screen. The window's 'closed' handler (electron.ts:73) only calls `finishOnboarding()` when `!main`. The mail window exists, so the engine is never told anything and `deferAI` keeps the account.

(2) First run with a connect still in flight. The user starts Google OAuth or an IMAP login, then closes the onboarding window while waiting. `finishOnboarding` sends `onboardingDone:true` and clears `deferAI`, which is still empty. The connect then resolves and `deferAI.add(a.id)` runs afterwards. Because `onboardingDone` is already true, nothing clears it again.

In both cases the connect-time first sync (up to the full initial window of threads) and every later auto or manual sync of that account skip classification: importance, reply state, todo/due extraction and automatic calendar plans. This lasts until the engine restarts. Disconnecting and reconnecting from Settings does not help, because `account.disconnect` never removes the id from `deferAI`. After a restart, the threads from the first sync are no longer 'fresh', so they are never classified. Only rows scrolled on screen get lazy summaries from the renderer. The existing test ('closing onboarding before its loading screen…') covers only the first-run close where `settings.update` arrives after the connect.

**Fix.** Tie the deferral to the onboarding window's lifetime instead of a set that something must remember to clear. Suggested approach:

(a) In electron.ts, have the onboarding window's 'closed' handler always tell the engine that setup ended, even when `main` exists. Add a small engine method such as `setup.end` that clears `deferAI` when no `setupJob` is running, or reuse the clear in `settings.update`.

(b) In `account.connect`, only add to `deferAI` while onboarding is actually open. For example, the engine tracks an `onboardingOpen` flag set by `onboarding.open` and the startup path and cleared on close. Alternatively, `syncAccount` re-checks `deferAI.has(a.id) && (setupJob || onboardingOpen)` instead of `deferAI.has` alone.

(c) Remove the id from `deferAI` in `account.disconnect`.

Also add tests for: connect resolving after `onboardingDone:true` was already sent, and the window closing when `onboardingDone` was already true.

### [medium] Escape does nothing on the failed loading screen, even though "Continue to Aplos" shows an esc hint
`apps/desktop/src/renderer/components/Welcome.tsx:71`

**Scenario.** Onboarding registers a window keydown listener when it mounts (line 71). SyncStep only adds its own Escape listener (line 137) after the sync fails, so the Onboarding listener always runs first. On Escape it calls e.preventDefault() and then skip(), and skip() does nothing on the 'sync' step. SyncStep's listener then sees e.defaultPrevented === true and returns without calling onFinish. Steps to reproduce: one account fails to sync (for example the dev:emulated --fail-sync case), the screen reads "Some mail didn't come through", and the user presses Escape as the esc keycap on "Continue to Aplos" suggests. Nothing happens. DECISIONS.md says "Continue to Aplos (Escape)", but the PROGRESS evidence only covers Enter/Retry.

**Fix.** Have Onboarding's handler return without preventDefault when step==='sync', so SyncStep handles Escape there. Alternatives: pass an onEscape ref from SyncStep up to Onboarding's skip(), or register SyncStep's listener with {capture:true}.

### [medium] deferAI is never cleared when onboarding is reopened and closed, or when OAuth finishes after setup was skipped, so that account gets no AI for the rest of the session
`apps/desktop/src/engine/service.ts:788`

**Scenario.** account.connect {setup:true} adds the account to deferAI. Only two things clear it: runSetup's finally block, and a settings.update that sets onboardingDone:true while no setupJob exists (line 778). (a) The user opens Settings > Show welcome while the main window is open, adds an account, then closes the onboarding window with the red button or Cmd+W. The 'closed' handler (electron.ts:73) skips finishOnboarding because main exists, so neither path runs. (b) First run: the user clicks Continue with Google, presses Escape twice (or closes the window), and finishOnboarding sets onboardingDone and clears deferAI. Then the user finishes signing in in the browser, the pending connect resolves, and deferAI.add runs after the clear. In both cases syncAccount returns before classifyIncoming (line 712) on every later sync until the app restarts. That account's new mail never gets summaries, importance, reply state, todos or plans, and no error is shown.

**Fix.** Only defer when a setup can still run, e.g. `if(p.setup===true&&!state.settings.onboardingDone)deferAI.add(a.id)`. Better: scope deferAI to an explicit setup session that the main process ends from the onboarding window's 'closed' handler every time (for example a setup.end call), whether or not main exists.

### [medium] With several accounts connected, the mail window opens filtered to the last one instead of All accounts
`apps/desktop/src/engine/service.ts:786`

**Scenario.** Every account.connect sets s.selectedAccountId=a.id, and the setup path keeps doing that. Onboarding now pushes adding several accounts ("Add every address you use. They all land in one calm inbox." with an Add another button). Example: the user connects work@ and then personal@, and the loading screen summarizes the newest 40 Home emails across both. The mail window then opens with Home, the sidebar and Ask all limited to personal@ (App.tsx:180 filters on selectedAccountId). Work mail looks missing, and many of the summaries the loading screen waited for are hidden.

**Fix.** Don't change selectedAccountId when p.setup===true, or select 'all' when there is more than one account. Another option is to invoke account.select {id:'all'} in Onboarding.finish before onboarding.finish.

### [low] An in-flight connect that resolves after Escape pulls the user back to the first step, even from the loading screen
`apps/desktop/src/renderer/components/Welcome.tsx:105`

**Scenario.** Escape on the account step unmounts AddAccountForm, but the account.connect call it started is still pending (an OAuth browser sign-in or an IMAP login check). The user carries on, for example with Try demo mail and then the AI or mic step, or goes on to the loading screen. When the connect resolves, the stale closure runs refresh().then(()=>setStep('start')), which jumps the user back to "Your accounts". If they were on the 'sync' step, SyncStep is torn down mid-run. Because real.length changes, the focus effect (line 73) also runs again and takes focus from whatever field the user was typing in.

**Fix.** Use a functional update guarded on the current step, e.g. connected={()=>{void refresh().then(()=>setStep(s=>s==='account'?'start':s));}}. Also consider cancelling or ignoring the connect when the form unmounts.

### [low] The loading screen shows "Summaries for Home ✓ Done" when the 60 s cap cut the pass short or every summary failed, and the AI error messages are lost
`apps/desktop/src/renderer/components/Welcome.tsx:151`

**Scenario.** The row shows Done for any state other than 'running', so 'partial' (capped at 60 s, e.g. 12 of 40) also reads Done. classifyIncoming reports failures (bad key, Groq free-plan 429s, cancelled) only through emit('error'). runSetup throws away the pass results (service.ts:624-633). The onboarding window ignores 'error' events, and on first run no mail window exists yet, so "AI could not classify 40 new threads" never appears anywhere and the screen still says Done. The same happens with Retry after a capped run: the old 'setup-ai-<id>' request is still running, so ai() throws "already running". The new pass finishes at once and shows Done 0 of N, and the old pass's tick() keeps writing its own counter into the new run's setup.ai.done (line 625). Accounts that sync() skips (not connected) also stay at "Waiting" with a moving bar while the title says "Your mail is ready".

**Fix.** Track failures and the cap in SetupProgress.ai (e.g. a failed count, and show 'x of y, the rest continue in the background' for partial). Collect classifyIncoming's warnings into setup state instead of only emitting them. Give each run its own requestId and per-run tick closure (or guard ticks with a run id). Report skipped accounts as a phase.

### [low] aria-live on the progress list makes screen readers announce every 120 ms progress update
`apps/desktop/src/renderer/components/Welcome.tsx:144`

**Scenario.** The whole <ul class="setup-progress" aria-live="polite"> re-renders its "N of M" text on every coalesced setup.progress event, about every 120 ms. A 500-thread Gmail sync therefore queues hundreds of VoiceOver announcements ("37 of 500", "41 of 500", ...), which drowns out the useful phase changes and the failure message. The progress bars also have no accessible name, so several of them each read as just "progress bar".

**Fix.** Remove aria-live from the list. Announce only phase changes (synced, failed, ready) through a separate visually hidden role="status" element, and add aria-label={`${email} sync`} to each progressbar.

### [low] Enter does nothing on the account details page ("Continue with Google") because focus is lost after discovery or picking a provider
`apps/desktop/src/renderer/components/AddAccount.tsx:75`

**Scenario.** In onboarding the user types a Gmail address and presses Enter. discover() changes the form's internal step to 'details', which unmounts the focused submit button, so focus falls to <body>. Onboarding's autofocus effect only runs on [step,!!state,real.length] and doesn't notice the form's internal step change, so nothing gets focused. Enter then does nothing. That breaks the stated contract ("Enter continues; each step focuses its main action") on the most common path (email, Enter, Continue with Google). The PROGRESS run clicked the Google tile, so it didn't hit this.

**Fix.** Inside AddAccountForm, focus the primary details control when step changes to 'details': the Continue with Google/Microsoft button for OAuth, otherwise the first empty input. A data-autofocus plus an effect keyed on `step` would do it.

### [low] Vertically centered onboarding pages cut off their top when content overflows the fixed 560 px window
`apps/desktop/src/renderer/styles.css:652`

**Scenario.** .onboarding-page is an overflow-y:auto flex column with justify-content:center, and its children have flex-shrink:0. When content is taller than the roughly 444 px content box (508 px minus padding), the overflow is split evenly above and below, and the part above the scroll origin can't be scrolled to. I confirmed this in headless Chromium: a 580 px tall body put the first child at top -12 px with scrollTop 0. Cases that hit it in the window, which can't be resized: the loading screen with 5 or more syncing accounts, the failure screen with 3 accounts showing long Google error text, or "Your accounts" with about 9 accounts. The app icon and then the title get clipped, and content also slides under the 48 px drag region.

**Fix.** Use `justify-content: safe center` (supported in Electron 44's Chromium), or use justify-content:flex-start with margin-block:auto on the first and last children.

### [medium] Accounts added from a reopened welcome stay excluded from sync AI when the window is closed early
`apps/desktop/src/engine/service.ts:788`

**Scenario.** A returning user (onboardingDone=true) opens Settings → Help & about → Show welcome, clicks Add another and connects Gmail. That call is `account.connect {setup:true}`, which runs `deferAI.add(a.id)`. They then close the onboarding window with the close button or Cmd-W instead of going through to the loading screen.

Nothing clears the deferral:
- electron.ts:73 calls finishOnboarding only when `!main`, and the main window is open.
- finishOnboarding skips settings.update anyway, because onboardingDone is already true.
- The renderer's finish() never runs.

Until the engine restarts, every sync of that account returns at service.ts:712 (`if(deferAI.has(a.id))return;`) before classifyIncoming. New mail gets no background summaries, importance, reply status, todos, auto-calendar plans or Spam summaries. Only rows the list scrolls into view get summarized, two at a time.

I confirmed this with a scratch test outside the repo: set onboardingDone, connect with setup:true, let the sync finish, then sync again with a new thread. summarize was never called (`summarized []`).

**Fix.** Defer only on a real first run: `if(p.setup===true&&!state.settings.onboardingDone)deferAI.add(a.id)`. Or have the onboarding window's 'closed' handler, whether or not main exists, call an engine method such as `setup.release` that clears deferAI for those accounts and queues the background pass. Add a test for the reopen-then-close path.

### [medium] First-run mail synced before the onboarding window is closed never gets the engine's AI pass
`apps/desktop/src/engine/service.ts:778`

**Scenario.** On a first run the owner adds an account. The connect-time sync finishes while they are on the AI or microphone step, with AI deferred. They then close the onboarding window. finishOnboarding sends `settings.update {onboardingDone:true}`, which only runs `deferAI.clear()`. The threads that already arrived are never classified, because classifyIncoming only covers mail that is new in a later sync and nothing backfills.

I confirmed this with a scratch test: 3 threads synced with setup:true, then onboardingDone set, then another sync. summarize was called 0 times. Only rows that scroll into view get summarized lazily. Off-screen Home and Low mail, auto-calendar plans and Spam summaries are lost. Before this PR, connect classified the mail immediately.

The test meant to cover this (onboarding.test.ts:183, 'closing onboarding before its loading screen does not leave new mail without AI') holds the sync until after onboardingDone is set. It only checks the in-flight case, so its name claims more than it proves.

**Fix.** When the deferral is released outside setup.run (settings.update with onboardingDone, or the window being closed), run the same background pass setup.run uses for its 'rest' set (classifyIncoming over unsummarized new and spam threads of the released accounts), tracked in `jobs`. Extend the test to release the hold, wait for the threads, then set onboardingDone and assert all 3 get summarized.

### [low] Website screenshot script still expects the old welcome dialog and now stalls on the onboarding page
`apps/web/scripts/capture-screenshots.mjs:98`

**Scenario.** Following the script's updated instructions (`APLOS_DATA_DIR=$(mktemp -d) npm run dev:demo`), the fresh folder has demo mail but onboardingDone is false. App.tsx:139 calls showWelcome(). In the browser (no window.aplos) that runs `location.assign('?onboarding=1')`, so every reach() lands on the onboarding page.

Line 98 only checks for `getByRole('dialog',{name:'Welcome to Aplos Mail'})`, which no longer exists. So Escape is never pressed, onboardingDone is never saved, and the first tour step's click on a main-app control times out. Regenerating the website screenshots is broken. The PR changed this file's instructions (dev → dev:demo) but not this handling.

**Fix.** After `page.goto(url)`, if `.onboarding-window` is present, press Escape and wait for `.app-shell`. With only demo accounts, Escape on the first step calls finish(), which saves onboardingDone and reloads the plain URL. Alternatively, POST `settings.update {patch:{onboardingDone:true}}` to the API once before the tours.
