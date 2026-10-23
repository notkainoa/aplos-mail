import {Footer,Header,Shot} from './Chrome';
import {releasesUrl} from './site';

const Key=({children}:{children:string}) => <kbd>{children}</kbd>;

export function Landing() {
  return (
    <>
      <Header home="./" />
      <main>
        <section className="hero">
          <h1>Finish your inbox, one email at a time.</h1>
          <p className="lead">
            Aplos Mail is a keyboard-first Mac app for email and calendar. Every message
            comes with a short summary of what it says and what it needs from you.
          </p>
          <div className="cta">
            <a className="button" href={releasesUrl}>Download for Mac</a>
            <p className="note">Windows and Linux coming later.</p>
          </div>
          <Shot name="home" alt="Aplos Mail showing one focused email with a summary, and the rest of the inbox as single lines." width={1240} height={680} eager />
        </section>

        <section className="feature">
          <div className="copy">
            <h2>One email at a time</h2>
            <p>
              Home puts the email that needs you in focus, with a summary that already
              includes what is asked and by when. Reply, set it aside for Later, or mark it
              Done. The next one is waiting.
            </p>
          </div>
          <Shot name="focus" alt="The focused email card with Reply, Later and Done actions, above the next messages as single lines." width={610} height={276} />
        </section>

        <section className="stack">
          <div className="copy">
            <h2>Every calendar in one week</h2>
            <p>
              Calendars from all your accounts share one day, week and month view. When an
              email mentions a meeting, Ask can propose the event and saves it only after
              you confirm.
            </p>
          </div>
          <Shot name="calendar" alt="A week in the Aplos Mail calendar with events from several accounts." width={1440} height={860} />
        </section>

        <section className="feature flip">
          <div className="copy">
            <h2>Ask anything</h2>
            <p>
              Type a question, or hold <Key>A</Key> and say it. Ask reads your mail and
              calendar, points to the messages it used, and drafts replies for you to
              review. It never sends anything on its own.
            </p>
          </div>
          <Shot name="ask" alt="The Ask panel with an input field, a hold-A-to-talk hint and suggested questions." width={360} height={230} />
        </section>

        <section className="details">
          <div className="row">
            <h2>Keyboard on every control</h2>
            <p>
              Every action has a key. <Key>Space</Key> does the suggested action, <Key>←</Key> sets
              mail aside for Later, <Key>→</Key> marks it Done, <Key>B</Key> bookmarks, <Key>C</Key> composes
              and <Key>Z</Key> undoes. Press <Key>?</Key> to see them all.
            </p>
          </div>
          <div className="row">
            <h2>Bring your own AI provider</h2>
            <p>
              Groq is the default for every AI feature, including voice. In Settings you can
              pick OpenAI, Claude, Gemini, OpenRouter, Ollama, LM Studio or your own
              OpenAI-compatible server for each feature separately. A message goes only to
              the provider you chose for that feature, and your keys stay on your Mac.
            </p>
          </div>
          <div className="row">
            <h2>Works with the mail you have</h2>
            <p>Gmail, Outlook, iCloud, Fastmail and any IMAP account.</p>
          </div>
        </section>

        <section className="close">
          <h2>Aplos Mail for Mac</h2>
          <div className="cta">
            <a className="button" href={releasesUrl}>Download for Mac</a>
            <p className="note">Requires a Mac with Apple silicon. Windows and Linux coming later.</p>
          </div>
        </section>
      </main>
      <Footer home="./" />
    </>
  );
}
