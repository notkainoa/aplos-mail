import {useEffect,useState} from 'react';
import {Footer,Header,Shot} from './Chrome';
import {Triage} from './Triage';
import {useReveal} from './reveal';
import heroIcon from './assets/brand/icon-640.webp';

const delay=(ms:number)=>({'--d':`${ms}ms`} as React.CSSProperties);

type Cap={id:string;label:string;text:string;wide?:boolean};
const rows:Cap[][]=[
  [{id:'b',text:'B',label:'Bookmark'},{id:'a',text:'A',label:'Ask'},{id:'c',text:'C',label:'Compose'},{id:'z',text:'Z',label:'Undo'},{id:'?',text:'?',label:'All keys'}],
  [{id:'ArrowLeft',text:'←',label:'Later'},{id:' ',text:'Space',label:'Do it',wide:true},{id:'ArrowRight',text:'→',label:'Done'}],
];
const providers:[string,boolean?][]=[['Groq',true],['OpenAI'],['Claude'],['Gemini'],['OpenRouter'],['OpenCode Go'],['Ollama'],['LM Studio'],['Your own server']];

// The real keys press the caps on the page too (outside text fields), so the list is also a small test of the keyboard.
function Keyboard() {
  const [down,setDown]=useState<Set<string>>(new Set());
  useEffect(()=>{
    const norm=(key:string)=>key.length===1?key.toLowerCase():key;
    const typing=(t:EventTarget|null)=>t instanceof HTMLElement&&(t.isContentEditable||/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    const press=(key:string,on:boolean)=>setDown(s=>{const n=new Set(s);if(on)n.add(key);else n.delete(key);return n;});
    const onDown=(e:KeyboardEvent)=>{if(!typing(e.target)&&!e.metaKey&&!e.ctrlKey&&!e.altKey)press(norm(e.key),true);};
    const onUp=(e:KeyboardEvent)=>press(norm(e.key),false);
    const clear=()=>setDown(new Set());
    addEventListener('keydown',onDown);addEventListener('keyup',onUp);addEventListener('blur',clear);
    return ()=>{removeEventListener('keydown',onDown);removeEventListener('keyup',onUp);removeEventListener('blur',clear);};
  },[]);
  return (
    <div className="keyboard" role="list" aria-label="Main shortcuts">
      {rows.flat().map(({id,text,label,wide})=>(
        <div key={id} role="listitem" className={`key${wide?' key-wide':''}`}>
          <kbd className={`keycap${down.has(id)?' is-down':''}`}
            onPointerDown={()=>setDown(s=>new Set(s).add(id))} onPointerUp={()=>setDown(s=>{const n=new Set(s);n.delete(id);return n;})} onPointerLeave={()=>setDown(s=>{const n=new Set(s);n.delete(id);return n;})}>{text}</kbd>
          <span>{label}</span>
        </div>
      ))}
    </div>
  );
}

export function Landing() {
  useReveal();
  return (
    <>
      <div className="field sky">
        <Header home="./" />
        <section className="hero wrap">
          <h1 data-reveal>Finish your inbox, one email at a time.</h1>
          <div className="hero-copy">
            <p className="lead" data-reveal style={delay(70)}>
              Aplos Mail is a keyboard-first Mac app for email and calendar. Every message
              comes with a short summary of what it says and what it needs from you.
            </p>
            <div className="cta" data-reveal style={delay(140)}>
              <span className="soon">Coming soon to Mac</span>
              <p className="note">Apple silicon. Windows and Linux later.</p>
            </div>
          </div>
          <div className="hero-icon" data-reveal style={delay(200)}><img src={heroIcon} width="640" height="640" alt="The Aplos Mail app icon: an airmail envelope flying over a green hill." /></div>
          <div className="window hero-window" data-reveal style={delay(240)}>
            <Shot name="home" alt="Aplos Mail showing one focused email with a summary, the rest of the inbox as single lines, and the Ask panel." width={1240} height={760} />
          </div>
        </section>
        <div className="band" />
      </div>

      <main>
        <section className="demo wrap" id="features">
          <div className="demo-copy" data-reveal>
            <h2>One email at a time</h2>
            <p>
              Home puts the email that needs you in focus, with a summary that already
              says what is asked and by when. Reply, set it aside for Later, or mark it
              Done. The next one is waiting.
            </p>
          </div>
          <div className="stage" data-reveal style={delay(100)}><Triage /></div>
        </section>

        <section className="field soft cal">
          <div className="wrap">
            <div className="cal-head">
              <h2 data-reveal>Every calendar in one week</h2>
              <p data-reveal style={delay(70)}>
                Calendars from all your accounts share one day, week and month view. When an
                email mentions a meeting, Ask can propose the event and saves it only after
                you confirm.
              </p>
            </div>
            <div className="window cal-window" data-reveal style={delay(120)}>
              <Shot name="calendar" alt="A week in the Aplos Mail calendar with events from two accounts, a mini month and the list of calendars." width={1440} height={860} />
            </div>
          </div>
        </section>

        <section className="ask wrap">
          <div className="stage stage-ask" data-reveal>
            <Shot name="ask" alt="The Ask panel with an input, a hold-A-to-talk hint and suggested questions." width={360} height={230} />
          </div>
          <div className="ask-copy" data-reveal style={delay(100)}>
            <h2>Ask anything</h2>
            <p>
              Type a question, or hold <kbd>A</kbd> and say it. Ask reads your mail and
              calendar, cites the messages it used, and drafts replies for you to review.
              It never sends anything on its own.
            </p>
          </div>
        </section>

        <section className="keys wrap">
          <div className="keys-copy" data-reveal>
            <h2>Keyboard on every control</h2>
            <p>Every action has a key, and <kbd>?</kbd> lists them all. Try them: the caps press with you.</p>
          </div>
          <div data-reveal style={delay(100)}><Keyboard /></div>
        </section>

        <section className="ai wrap">
          <div className="ai-copy" data-reveal>
            <h2>Bring your own AI provider</h2>
            <p>
              Groq is the default for every AI feature, including voice. Pick a different
              provider for each feature in Settings. A message goes only to the provider
              you chose for that feature, and your keys stay on your Mac.
            </p>
          </div>
          <ul className="providers" aria-label="Providers" data-reveal style={delay(100)}>
            {providers.map(([name,main])=><li key={name} className={main?'main':undefined}>{name}{main&&<small>Default</small>}</li>)}
          </ul>
          <h2 className="accounts-title" data-reveal>Works with the mail you have</h2>
          <p className="accounts" data-reveal style={delay(100)}>Gmail, Outlook, iCloud, Fastmail, or any IMAP account.</p>
        </section>
      </main>

      <div className="field grass">
        <div className="band" />
        <section className="close wrap">
          <h2 data-reveal>An inbox you can finish.</h2>
          <div className="cta" data-reveal style={delay(100)}>
            <span className="soon">Coming soon to Mac</span>
            <p className="note">Requires a Mac with Apple silicon. Windows and Linux later.</p>
          </div>
        </section>
        <Footer home="./" />
      </div>
    </>
  );
}
