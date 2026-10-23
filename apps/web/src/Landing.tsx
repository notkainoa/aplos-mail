import {Footer,Header,Shot} from './Chrome';
import {Triage} from './Triage';
import {useReveal} from './reveal';
import {releasesUrl} from './site';

const Key=({children}:{children:string}) => <kbd>{children}</kbd>;

const keys:[string,string,boolean?][]=[['Space','Do it',true],['←','Later'],['→','Done'],['B','Bookmark'],['A','Ask'],['C','Compose'],['Z','Undo']];
const providers:[string,boolean?][]=[['Groq',true],['OpenAI'],['Claude'],['Gemini'],['OpenRouter'],['OpenCode Go'],['Ollama'],['LM Studio'],['Your own server']];
const accounts=['Gmail','Outlook','iCloud','Fastmail','Any IMAP account'];

export function Landing() {
  useReveal();
  return (
    <>
      <Header home="./" />
      <main>
        <section className="hero">
          <h1 data-reveal>Finish your inbox, one email at a time.</h1>
          <p className="lead" data-reveal style={{'--d':'70ms'} as React.CSSProperties}>
            Aplos Mail is a keyboard-first Mac app for email and calendar. Every message
            comes with a short summary of what it says and what it needs from you.
          </p>
          <div className="cta" data-reveal style={{'--d':'140ms'} as React.CSSProperties}>
            <a className="button" href={releasesUrl}>Download for Mac</a>
            <p className="note">Windows and Linux coming later.</p>
          </div>
          <div className="window" data-reveal style={{'--d':'220ms'} as React.CSSProperties}>
            <Shot name="home" alt="Aplos Mail showing one focused email with a summary, the rest of the inbox as single lines, and the Ask panel." width={1240} height={760} eager />
          </div>
        </section>

        <section className="demo" id="features">
          <div className="copy" data-reveal>
            <h2>One email at a time</h2>
            <p>
              Home puts the email that needs you in focus, with a summary that already
              includes what is asked and by when. Reply, set it aside for Later, or mark it
              Done. The next one is waiting.
            </p>
            <p className="note">This is a working copy. Try it with the keys.</p>
          </div>
          <div data-reveal style={{'--d':'100ms'} as React.CSSProperties}><Triage /></div>
        </section>

        <section className="bento" aria-label="More">
          <article className="tile tile-calendar" data-reveal>
            <h2>Every calendar in one week</h2>
            <p>
              Calendars from all your accounts share one day, week and month view. When an
              email mentions a meeting, Ask can propose the event and saves it only after
              you confirm.
            </p>
            <Shot name="calendar" className="bleed" alt="A week in the Aplos Mail calendar with events from two accounts, a mini month and the list of calendars." width={1440} height={860} />
          </article>

          <article className="tile tile-ask" data-reveal style={{'--d':'80ms'} as React.CSSProperties}>
            <h2>Ask anything</h2>
            <p>
              Type a question, or hold <Key>A</Key> and say it. Ask reads your mail and
              calendar, cites the messages it used, and drafts replies for you to review.
              It never sends anything on its own.
            </p>
            <Shot name="ask" className="bleed" alt="The Ask panel with an input, a hold-A-to-talk hint and suggested questions." width={360} height={230} />
          </article>

          <article className="tile tile-keys" data-reveal>
            <h2>Keyboard on every control</h2>
            <p>Every action has a key, and <Key>?</Key> lists them all.</p>
            <ul className="keys" aria-label="Main shortcuts">
              {keys.map(([key,label,wide])=>(
                <li key={key} className={wide?'wide':undefined}><kbd className="keycap">{key}</kbd><span>{label}</span></li>
              ))}
            </ul>
          </article>

          <article className="tile tile-ai" data-reveal style={{'--d':'80ms'} as React.CSSProperties}>
            <h2>Bring your own AI provider</h2>
            <p>
              Groq is the default for every AI feature, including voice. Pick a different
              provider for each feature in Settings. A message goes only to the provider
              you chose for that feature, and your keys stay on your Mac.
            </p>
            <ul className="pills" aria-label="Providers">
              {providers.map(([name,main])=><li key={name} className={main?'main':undefined}>{name}{main&&<small>Default</small>}</li>)}
            </ul>
          </article>

          <article className="tile tile-accounts" data-reveal>
            <h2>Works with the mail you have</h2>
            <ul className="pills" aria-label="Accounts">
              {accounts.map(name=><li key={name}>{name}</li>)}
            </ul>
          </article>
        </section>

        <section className="close" data-reveal>
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
