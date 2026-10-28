import icon from './assets/icon-512.webp';
import { Airmail, Footer, Header } from './Chrome';
import { Ask } from './Ask';
import { HeroIcon, KeyList, ProviderPicker, Rise } from './Live';
import { Tour } from './Tour';
import { Triage } from './Triage';
import { useReveal } from './reveal';
import { releasesUrl } from './site';

const Key = ({ children }: { children: string }) => <kbd>{children}</kbd>;
const delay = (ms: number) => ({ '--d': `${ms}ms` }) as React.CSSProperties;

const accounts = 'Gmail, Outlook, iCloud, Fastmail and any IMAP account';

export function Landing() {
  useReveal();
  return (
    <>
      <div className="sky">
        <Airmail />
        <Header home="./" />
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title">
              <Rise text="Finish your inbox, one email at a time." />
            </h1>
            <p className="lead" data-reveal style={delay(80)}>
              Aplos Mail is a keyboard-first Mac app for email and calendar. Every message arrives
              with a short summary of what it says and what it needs from you.
            </p>
            <div className="cta" data-reveal style={delay(160)}>
              <a className="button" href={releasesUrl}>
                Download for Mac
              </a>
              <p className="note">For Macs with Apple silicon or Intel.</p>
            </div>
          </div>
          <HeroIcon
            src={icon}
            alt="The Aplos Mail icon: an airmail envelope in a blue sky above a green hill."
          />
          <div className="window-wrap" data-reveal style={delay(320)}>
            <div className="window" data-ui>
              <Tour id="hero" eager focus={0.2} />
            </div>
            <p className="note tour-note">
              <span className="for-pointer">
                This is the app. Click anything that lights up to look around.
              </span>
              <span className="for-touch">
                This is the app. Tap around, and swipe the window sideways.
              </span>
            </p>
          </div>
        </section>
      </div>

      <main>
        <section className="demo" id="home" aria-labelledby="demo-title">
          <div className="copy">
            <h2 id="demo-title" data-reveal>
              Home shows what each email needs
            </h2>
            <p data-reveal style={delay(70)}>
              The email that needs you sits in focus, with a summary that already says what is asked
              and by when. Reply, set it aside for Later, or mark it Done, and the next one is
              waiting.
            </p>
            <p className="note" data-reveal style={delay(140)}>
              This is a working copy. Click it and try the keys.
            </p>
          </div>
          <div className="demo-stage" data-reveal style={delay(120)}>
            <Triage />
          </div>
        </section>

        <section className="calendar" id="calendar" aria-labelledby="calendar-title">
          <h2 id="calendar-title" data-reveal>
            Every calendar in one week
          </h2>
          <p data-reveal style={delay(70)}>
            Calendars from all your accounts share one day, week and month view. When an email
            mentions a plan, Aplos proposes the event and adds it only after you confirm.
          </p>
          <div className="calendar-live" data-reveal style={delay(140)}>
            <div className="calendar-shot" data-ui>
              <Tour id="calendar" focus={0.335} />
            </div>
            <p className="note tour-note">
              Switch views, change the week or open any event, right in the window.
            </p>
          </div>
        </section>

        <section className="ask" aria-labelledby="ask-title">
          <div className="ask-live" data-reveal>
            <Ask />
          </div>
          <div className="copy">
            <h2 id="ask-title" data-reveal style={delay(70)}>
              Ask your mail anything
            </h2>
            <p data-reveal style={delay(140)}>
              Type a question, or hold <Key>A</Key> and say it. Ask reads your mail and calendar,
              cites the messages it used, and drafts replies for you to review. It never sends
              anything on its own.
            </p>
            <p className="note" data-reveal style={delay(210)}>
              Pick a question to see how it answers.
            </p>
          </div>
        </section>

        <section className="keys" aria-labelledby="keys-title">
          <div className="copy">
            <h2 id="keys-title" data-reveal>
              A key for every action
            </h2>
            <p data-reveal style={delay(70)}>
              Your hands stay on the keyboard from the first email to the last.
            </p>
            <p className="note" data-reveal style={delay(140)}>
              Try them: press any of these keys.
            </p>
          </div>
          <KeyList />
        </section>
      </main>

      <section className="ai" id="ai" aria-labelledby="ai-title">
        <div className="ai-inner">
          <h2 id="ai-title" data-reveal>
            AI that stays out of the way
          </h2>
          <p data-reveal style={delay(70)}>
            Summaries, Ask, drafts, plans and voice run on Groq by default. Pick a different
            provider for any of them in Settings, the way you can here. A message goes only to the
            provider you chose for that feature, and your keys stay on your Mac.
          </p>
          <div className="ai-picker" data-reveal style={delay(140)}>
            <ProviderPicker />
          </div>
        </div>
      </section>

      <section className="finish" aria-labelledby="close-title">
        <div className="finish-inner">
          <div className="copy">
            <h2 id="close-title" data-reveal>
              Aplos Mail for Mac
            </h2>
            <p data-reveal style={delay(70)}>
              Works with {accounts}. No Aplos server ever sees your mail.
            </p>
            <div className="cta" data-reveal style={delay(140)}>
              <a className="button" href={releasesUrl}>
                Download for Mac
              </a>
              <p className="note">
                For Macs with Apple silicon or Intel, on macOS 12 or later. Windows and Linux later.
              </p>
            </div>
          </div>
          <img
            className="finish-icon"
            src={icon}
            width="512"
            height="512"
            alt=""
            loading="lazy"
            data-reveal
            style={delay(120)}
          />
        </div>
        <Footer home="./" />
      </section>
    </>
  );
}
