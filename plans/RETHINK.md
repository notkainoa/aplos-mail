# Rethink: what Aplos shows you, and how it is built

Written 2026-11-19 from a conversation with the owner, the day after 0.0.1 shipped. This is a draft for the owner to check. Nothing here is built, and no architecture has been designed yet.

## In plain English

Aplos should bring every email account into one calm app and do the annoying parts for you. It hides what you don't need, shortens what can be shortened, and shows the whole email when the writing itself is the point.

Two things change from today's app:

1. **How mail is sorted and shown.** Today Home sorts on one scale (Do now, Important updates, Low importance) and treats every email the same. The new version decides two things separately for each email: where it goes, and how much of it you see.
2. **How the app is built.** A small core that can't be changed, with everything else made of building blocks. The version a normal person downloads is just our own set of blocks. Anyone can change it by asking the agent, and someone with a coding agent can rebuild whole panels.

## Words we use

| Word | Meaning |
|---|---|
| Core | The part that can't be customised: accounts, mail store, sync, sending, the safe frame that shows email, permissions, undo, the record and your corrections. |
| Block | A piece built on the core. Sections, treatments, rules, panels, themes and keys are blocks. |
| Engine block | A block that plugs into the engine instead of the screen: a mail provider, a decider, an AI model. |
| Default version | Our own set of blocks. What you get when you download Aplos and change nothing. |
| Job | What an email is doing: asking, updating, something to read, a new person, a record, or something you never asked for. |
| Kind | A recognisable type of machine-sent mail from one sender, such as one shop's shipping notices. |
| Section | A place mail appears, such as Needs you or Newsletters. |
| Treatment | How much of an email you see: line, brief, full, or not shown. |
| Line | One sentence. Reading it finishes the email. |
| Brief | The few facts that matter plus the one action. |
| Record | What the core keeps for every email: its job, its section, its treatment, the short version, one sentence on why, and which topic sections it matches. |
| Decider | The block that fills in the record. Ours ships by default and can be swapped. |
| Correction | You telling Aplos it got something wrong. Corrections always win. |

## Part 1: deciding what to show

> **What this means:** the job an email is doing decides where it goes and how much of it you see. You can always get the full email, and Aplos learns from the times you ask for it.

1. **Two decisions per email, made separately.** Where it goes (or whether you see it at all), and how much of it you get. A low-urgency email can still be shown in full, and an important one can be a single line.
2. **The job decides, not the sender.** A person you know can send a plain update, and that becomes one line. A person asking for approval gets shortened to the ask.
3. **Six jobs in the default version:**

   | Job | Example | Where | How much |
   |---|---|---|---|
   | Asks you for something | Approve, reply, pay, sign, pick a time | Needs you | The ask, shortened, with its action |
   | Tells you something that affects you | Delivered, flight check-in, meeting moved | Updates | A line, or a brief |
   | Something you chose to read | Newsletters | Newsletters | Full |
   | Someone new writing to you personally | A real cold email | New people | Full |
   | A record | Receipts, statements, policy updates | Receipts and records | Not shown, findable |
   | Wants something you never asked for | Promos, mass outreach, app notifications | Everything else | Not shown |

4. **Machine mail is decided per kind; mail from people is decided per email.** One shop's shipping notices look the same every time. A person's email depends on what they wrote.
5. **The short version replaces the email.** A "see full email" button is always there, and every press is remembered.
6. **A short version must be trustworthy.** Numbers, dates, names and codes are copied exactly. It says when it left out something that could matter. If it can't be complete, the email is not shortened.
7. **Two guards for mail from people.** A short email from a person is never shortened. When you reply, their actual words are in front of you.
8. **Learning.** One press of "see full email" changes nothing. After about three for the same kind, Aplos asks once whether to always show them in full. It offers to shorten mail you keep clearing unread. It never changes treatment silently. A direct correction applies at once.
9. **Catching mistakes.** Only mail the decider is confident about goes to Everything else. For the first few weeks a "check my work" line shows the few it was least sure about.
10. **The order the decider works in.** Your corrections first, then plain facts about the email (bulk markers, no-reply senders, whether you've written to them), then a decisions model, then a thinking model for the ones the first model was unsure of. The thinking model also settles which section.
11. **Without any AI model**, sorting still works from the plain facts. Mail from people then all goes to Needs you, in full.
12. **A newsletter is defined by its job**: recurring writing sent the same to everyone, where nothing in it is about you or needs you. A bulk email with a real date or ask in it is treated as an update or an ask.
13. **A conversation is one item.** Its newest email decides its job and section, and its short version covers only what is new since you last looked. One conversation never shows in two sections, and a reply moves the whole conversation. (Owner, 2026-11-24.)

## Part 2: the default version

> **What this means:** this is the product for most people, because most people will never customise anything.

**Home, in this order**

1. Needs you
2. Updates
3. New people
4. Waiting on (mail you sent that hasn't been answered; today's Follow up)

**In the sidebar**

- **Newsletters:** all of them, in full, with a one-click unsubscribe per sender.
- **Receipts and records:** filed and searchable, never shown. A failed payment, a refund or an unusually large charge is an update and goes on Home.
- **Everything else:** promos, mass outreach, app notifications. A small count, and you can open it. (Replaces the name "Low importance".)
- **Later, Done and Search** stay as they are today.

**Other choices**

- **Promos** are the user's choice. Onboarding asks; until then they sit in Everything else.
- **Calendar:** the full week and month view leaves the default version and is planned as an official plug-in later. The calendar smarts stay in the engine: spotting a date in an email, checking you're free, offering to add it, adding it when you say yes. Invitations appear in Needs you with Yes, Maybe and No.
- **Ask and Today (owner, 2026-11-24):** today's Ask panel becomes the sidebar agent (Part 4). Today's Today panel leaves the default version and moves into the calendar plug-in. The small peek at a day when Aplos offers to add an event stays.
- **Onboarding** learns from your real mailbox. It shows real examples of your highest-volume kinds and asks what you want done with them, with good defaults for the rest.
- **Everything is customisable.**

## Part 3: how it is built

> **What this means:** most of today's screens get rebuilt as blocks. The engine mostly stays.

1. **A core plus blocks.** See the table of words above for what is in the core.
2. **The default version uses only the public blocks.** If our own Home can't be built from them, the blocks are wrong.
3. **This is a rebuild of most screens**, accepted by the owner one day after 0.0.1.
4. **Blocks carry the Paper look**, so a custom section still looks like Aplos.
5. **The record and your corrections live in the core. The decider is a swappable block.** Any block can read the record or ignore it. A version that ignores it is a plain classic inbox.
6. **Engine blocks exist too:** mail providers, the decider, AI models. They get a higher bar than screen blocks. A provider block sees only the one account it was added for, must pass a fixed set of tests, and is only ever added by a click from you.
7. **Other mail accounts come after** the default version works well on Gmail. To keep that easy: nothing Gmail-only leaks up into the blocks, and the old Outlook, iCloud and Fastmail code is kept until it is ported.
8. **Permissions follow one rule.** Anything you can undo, an extension can just do. Anything you can't undo (sending, forwarding, permanent delete) asks first. You can switch the asking off for one extension, and back on. An agent can never grant itself that.
9. **The engine core's size cap goes up.** The owner agreed on 2026-11-20; the new number will be proposed from a measurement of what the record needs.
10. **The first milestone is the block system (owner, 2026-11-24).** Define the blocks first, then build the default version from them and get the sorting good, then open the door to coding agents.
11. **Two kinds of block (owner, 2026-11-25).** Sections, treatments, rules, themes and keys are settings: a description that runs no code, so anyone can make one by asking the agent. Only panels are code, run walled off from your mail under the same permission rule.
12. **A section chooses mail by fixed fields plus an optional topic (owner, 2026-11-25).** The fixed fields are job, kind, sender, account, label, date and whether you have written to them; our own Home sections use only these (Needs you is job "ask"). A topic is a few plain words, such as "my kid's soccer team". The decider checks each email against every topic while it fills in the record, in the same model call, so a topic adds no extra requests and catches senders the section has never seen. With AI off, a topic section falls back to its fixed fields. Topic matches can be wrong, so the uncertain ones show in "check my work", like the six jobs.

The jobs that can start now are in [next/README.md](next/README.md).

## Part 4: the agent

> **What this means:** one agent in the sidebar that both answers questions and changes the app, powered by whatever the user already has.

1. **The sidebar agent answers and customises.** "Make a section for my kid's soccer" works for anyone. Someone with a coding agent can ask it to redo a panel.
2. **Two ways to power it:** your own Claude Code or Codex, using your subscription, or Aplos's built-in agent with your API key.
3. **Any feature can run on a subscription, a key or a local model**, including the decider and the short versions. The model picker in Settings gains "My Claude Code" and "My Codex".
4. **For background work:** requests are batched, there is a daily cap you can see, and tools are always off.
5. **Voice** still needs a key, because neither program does speech-to-text.

## Things I assumed without a clear yes

Please correct any of these.

- The three shapes are called line, brief and full.
- When even the thinking model is unsure, the email is shown in full and stays visible.
- A model's stated confidence is checked against real corrections before we rely on it.

## Still open

- How Aplos should differ from Powermove.
- What a block is technically, beyond Part 3 items 11 and 12: the format of treatments, rules, themes and keys, how a code panel is kept safe, how blocks are shared.
- Which kinds get a brief first (shipping, flights, bills and so on).
- Which models the decider uses, and where the confidence line sits.
- The exact onboarding questions.
- How to tell a real cold email from mass outreach.

## To check before building

- Whether Anthropic's and OpenAI's terms allow an app to drive the user's own installed Claude Code or Codex this way. T3 Code does it by running the installed program as a one-off command with tools off (`apps/server/src/textGeneration/` in its source).
