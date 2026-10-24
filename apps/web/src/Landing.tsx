import icon from './assets/icon-512.webp';
import {Airmail,Footer,Header,Shot} from './Chrome';
import {Triage} from './Triage';
import {useReveal} from './reveal';
import {releasesUrl} from './site';

const Key=({children}:{children:string}) => <kbd>{children}</kbd>;
const delay=(ms:number)=>({'--d':`${ms}ms`} as React.CSSProperties);

const keys:[string,string][]=[['Space','The email’s main action, like Reply'],['←','Set it aside for Later'],['→','Mark it Done'],['Z','Undo the last action'],['B','Bookmark'],['A','Ask, or hold it to talk'],['C','Compose'],['?','Every shortcut in the app']];
// Names keep their words together so a line never breaks inside one.
const providers=['OpenAI','Claude','Gemini','OpenRouter','OpenCode Go','Ollama','LM Studio','your own server'].map(name=>name.replaceAll(' ','\u00a0'));
const accounts='Gmail, Outlook, iCloud, Fastmail and any IMAP account';

export function Landing() {
  useReveal();
  return (
    <>
      <div className="sky">
        <Airmail />
        <Header home="./" />
        <section className="hero" aria-labelledby="hero-title">
          <div className="hero-copy">
            <h1 id="hero-title" data-reveal>Finish your inbox, one email at a time.</h1>
            <p className="lead" data-reveal style={delay(80)}>
              Aplos Mail is a keyboard-first Mac app for email and calendar. Every message
              arrives with a short summary of what it says and what it needs from you.
            </p>
            <div className="cta" data-reveal style={delay(160)}>
              <a className="button" href={releasesUrl}>Download for Mac</a>
              <p className="note">For Macs with Apple silicon.</p>
            </div>
          </div>
          <img className="hero-icon" src={icon} width="512" height="512" alt="The Aplos Mail icon: an airmail envelope in a blue sky above a green hill." />
          <div className="window" data-ui data-reveal style={delay(240)}>
            <Shot name="home" alt="Aplos Mail showing one focused email with a summary, the rest of the inbox as single lines, and the Ask panel." width={1240} height={760} eager />
          </div>
        </section>
      </div>

      <main>
        <section className="demo" id="home" aria-labelledby="demo-title">
          <div className="copy">
            <h2 id="demo-title" data-reveal>Home shows what each email needs</h2>
            <p data-reveal style={delay(70)}>
              The email that needs you sits in focus, with a summary that already says what
              is asked and by when. Reply, set it aside for Later, or mark it Done, and the
              next one is waiting.
            </p>
            <p className="note" data-reveal style={delay(140)}>This is a working copy. Click it and try the keys.</p>
          </div>
          <div className="demo-stage" data-reveal style={delay(120)}><Triage /></div>
        </section>

        <section className="calendar" id="calendar" aria-labelledby="calendar-title">
          <h2 id="calendar-title" data-reveal>Every calendar in one week</h2>
          <p data-reveal style={delay(70)}>
            Calendars from all your accounts share one day, week and month view. When an
            email mentions a plan, Aplos proposes the event and adds it only after you
            confirm.
          </p>
          <div className="calendar-shot" data-ui data-reveal style={delay(140)}>
            <Shot name="calendar" alt="A week in the Aplos Mail calendar with events from two accounts, a mini month, the list of calendars and an event found in an email." width={1440} height={860} />
          </div>
        </section>

        <section className="ask" aria-labelledby="ask-title">
          <div className="ask-shot" data-ui data-reveal>
            <Shot name="ask" alt="The Ask panel with an input, a hold-A-to-talk hint and suggested questions." width={360} height={230} />
          </div>
          <div className="copy">
            <h2 id="ask-title" data-reveal style={delay(70)}>Ask your mail anything</h2>
            <p data-reveal style={delay(140)}>
              Type a question, or hold <Key>A</Key> and say it. Ask reads your mail and
              calendar, cites the messages it used, and drafts replies for you to review.
              It never sends anything on its own.
            </p>
          </div>
        </section>

        <section className="keys" aria-labelledby="keys-title">
          <div className="copy">
            <h2 id="keys-title" data-reveal>A key for every action</h2>
            <p data-reveal style={delay(70)}>Your hands stay on the keyboard from the first email to the last.</p>
          </div>
          <dl className="keylist" data-ui>
            {keys.map(([key,label],i)=>(
              <div key={key} data-reveal style={delay(60+i*40)}><dt><kbd>{key}</kbd></dt><dd>{label}</dd></div>
            ))}
          </dl>
        </section>
      </main>

      <section className="ai" id="ai" aria-labelledby="ai-title">
        <div className="ai-inner">
          <h2 id="ai-title" data-reveal>AI that stays out of the way</h2>
          <p data-reveal style={delay(70)}>
            Summaries, Ask, drafts, plans and voice run on Groq by default. Pick a
            different provider for any of them in Settings. A message goes only to the
            provider you chose for that feature, and your keys stay on your Mac.
          </p>
          <p className="providers" data-reveal style={delay(140)} aria-label="Supported providers">
            <strong>Groq</strong>, {providers.slice(0,-1).join(', ')} or {providers[providers.length-1]}.
          </p>
        </div>
      </section>

      <section className="finish" aria-labelledby="close-title">
        <div className="finish-inner">
          <div className="copy">
            <h2 id="close-title" data-reveal>Aplos Mail for Mac</h2>
            <p data-reveal style={delay(70)}>Works with {accounts}. No Aplos server ever sees your mail.</p>
            <div className="cta" data-reveal style={delay(140)}>
              <a className="button" href={releasesUrl}>Download for Mac</a>
              <p className="note">For Macs with Apple silicon. Windows and Linux later.</p>
            </div>
          </div>
          <img className="finish-icon" src={icon} width="512" height="512" alt="" loading="lazy" data-reveal style={delay(120)} />
        </div>
        <Footer home="./" />
      </section>
    </>
  );
}
