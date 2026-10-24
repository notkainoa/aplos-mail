import {useEffect,useState} from 'react';
import icon from './assets/icon-512.webp';
import {Airmail,Footer,Header} from './Chrome';
import {Rise} from './Live';
import {detect,type Detected} from './platform';
import {findFile,megabytes,release,type File,type Offer,type Os,type Target} from './release';
import {useReveal} from './reveal';

// The page a download button leads to. It picks the build for this computer, starts it, and shows how to install it.
// It is not linked from anywhere yet; see VISION.md.
const delay=(ms:number)=>({'--d':`${ms}ms`} as React.CSSProperties);
const released=new Date(`${release.date}T12:00:00`).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

function DownloadIcon() {
  return <svg className="dl-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8m0 0L4.75 7.25M8 10.5l3.25-3.25M3 13.25h10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function Download() {
  useReveal();
  const [found,setFound]=useState<Detected|null>(null);
  const [target,setTarget]=useState<Target|null>(null);
  const [started,setStarted]=useState(false); // the automatic download has been asked for
  const [stalled,setStalled]=useState(false); // long enough that, if nothing happened, the visitor should be offered a retry
  const file=target?findFile(target):null;

  const start=(chosen:File)=>{
    // Sample data points at files that do not exist yet, so nothing is fetched until there is a real release.
    if(!release.sample)window.location.assign(chosen.url);
    setStarted(true);setStalled(false);
    window.setTimeout(()=>setStalled(true),3500);
  };

  useEffect(()=>{
    let live=true;
    void detect().then(result=>{
      if(!live)return;
      setFound(result);setTarget(result.target);
      if(result.target)window.setTimeout(()=>live&&start(findFile(result.target!)),700);
    });
    return ()=>{live=false;};
  },[]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose=(next:Target)=>{setTarget(next);setStarted(false);setStalled(false);};
  const auto=found?.target&&target===found.target;
  const os:Os=file?.platform.os??'mac';
  const title=!found?'Getting your download ready':found.mobile?'Aplos Mail is for your computer':file?'Your download is on its way':'Download Aplos Mail';
  const lead=!found?' ':found.mobile
    ?'Open this page on your computer and the right version downloads by itself. Every version is listed below.'
    :file?`Aplos Mail ${release.version} for ${file.platform.name}, ${file.label}. It takes about a minute to install.`
    :'Pick the version for your computer below.';

  return (
    <>
      <div className="sky dl-sky">
        <Airmail />
        <Header home="../" />
        <section className="dl-hero" aria-labelledby="dl-title">
          <img className="dl-app" src={icon} width="512" height="512" alt="" data-reveal />
          <h1 id="dl-title" key={title}><Rise text={title} /></h1>
          <p className="dl-lead" data-reveal style={delay(80)} aria-live="polite">{lead}</p>
          <div className="dl-actions" data-reveal style={delay(160)}>
            {file&&<Status file={file} started={started&&!!auto} stalled={stalled} onStart={()=>start(file)} />}
            <a className="dl-pill" href="#all"><span>All versions</span><svg className="dl-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10m0 0-4-4m4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg></a>
          </div>
          {/* Always rendered, so the page's reveal sees it; it shows once there is a version to name. */}
          <label className="dl-choose" data-reveal style={delay(220)} hidden={!file}>
            <span className="sr">Version</span>
            <select value={target??''} onChange={event=>choose(event.target.value as Target)}>
              {release.platforms.map(p=><optgroup key={p.os} label={p.name}>
                {p.files.map(f=><option key={f.target} value={f.target}>{p.name}, {f.label}</option>)}
              </optgroup>)}
            </select>
          </label>
        </section>
        <section className="dl-steps" aria-labelledby="steps-title">
          <h2 id="steps-title" className="sr">How to install</h2>
          <ol>
            {steps[os].map(([Art,text],i)=>(
              // Keyed by position: the steps change with the system, but the page's reveal keeps watching the same items.
              <li key={i} data-reveal style={delay(i*90)}>
                <div className="dl-art" data-ui><Art file={file??findFile('mac-arm64')} /></div>
                <p><span className="dl-num">{i+1}</span>{text(file??findFile('mac-arm64'))}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <main className="dl-main">
        <section className="dl-all" id="all" aria-labelledby="all-title">
          <h2 id="all-title" data-reveal>All versions</h2>
          <p className="dl-all-lead" data-reveal style={delay(70)}>
            Aplos Mail {release.version}, released {released}. <a href={release.notesUrl}>What’s new</a>
          </p>
          <div className="dl-platforms">
            {release.platforms.map((p,i)=>(
              <article key={p.os} className="dl-platform" data-reveal style={delay(100+i*70)}>
                <h3>Aplos Mail for {p.name}</h3>
                <p>{p.requires}</p>
                <div className="dl-files">
                  {p.files.map(f=>(
                    <a key={f.target} className={`dl-file${f.target===found?.target?' is-yours':''}`} href={f.url} download
                      onClick={event=>{if(release.sample)event.preventDefault();choose(f.target);start(f);}}>
                      <DownloadIcon /><span>{f.label} <small>{f.kind}</small></span><small>{megabytes(f.size)}</small>
                    </a>
                  ))}
                  <a className="dl-file dl-file-quiet" href={release.allUrl}>Every file on GitHub</a>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
      <Footer home="../" />
    </>
  );
}

// The badge under the title: what is downloading, then, if nothing seems to have happened, a way to try again.
function Status({file,started,stalled,onStart}:{file:Offer;started:boolean;stalled:boolean;onStart:()=>void}) {
  const what=`${file.platform.name}, ${file.label}`;
  if(!started)return <button type="button" className="dl-pill dl-pill-primary" onClick={onStart}><DownloadIcon /><span>Download for {what}</span></button>;
  return (
    <p className={`dl-badge${stalled?' is-stalled':''}`} role="status">
      {stalled
        ?<>Didn’t start? <button type="button" onClick={onStart}>Try again</button></>
        :<><span className="dl-spin" aria-hidden="true" />Downloading {file.name}</>}
    </p>
  );
}

// Install steps for each system, each with a small drawing in the app's own style.
type Step=[(props:{file:File})=>React.ReactElement,(file:File)=>React.ReactNode];
const steps:Record<Os,Step[]>={
  mac:[
    [Downloads,f=><>Open <b>{f.name.replace(/-[\d.]+-\w+(?=\.dmg)/,'')}</b> from your <b>Downloads</b> folder.</>],
    [DragToApplications,()=><>Drag <b>Aplos Mail</b> into your <b>Applications</b> folder.</>],
    [Welcome,()=><>Open <b>Aplos Mail</b> from Applications and add your accounts.</>],
  ],
  win:[
    [Downloads,()=><>Open <b>Aplos Mail Setup</b> from your <b>Downloads</b> folder.</>],
    [Installer,()=><>The installer puts Aplos Mail in your <b>Start</b> menu. It takes under a minute.</>],
    [Welcome,()=><>Open <b>Aplos Mail</b> and add your accounts.</>],
  ],
  linux:[
    [Downloads,()=><>Find the <b>AppImage</b> in your <b>Downloads</b> folder.</>],
    [AllowRun,()=><>In its <b>Properties</b>, allow it to run as a program.</>],
    [Welcome,()=><>Open <b>Aplos Mail</b> and add your accounts.</>],
  ],
};

function Downloads({file}:{file:File}) {
  const rows=[[file.name,megabytes(file.size)],['trip-photos.zip','84 MB'],['october-invoice.pdf','212 KB']];
  return (
    <div className="art-window art-downloads">
      <p className="art-title">Downloads</p>
      <ul>
        {rows.map(([name,size],i)=>(
          <li key={name} className={i===0?'is-picked':''}>
            <span className={`art-file${i===0?' is-ours':''}`} aria-hidden="true">{i===0&&<img src={icon} alt="" />}</span>
            <span className="art-name">{name}</span><span className="art-size">{size}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DragToApplications() {
  return (
    <div className="art-window art-drag">
      <img className="art-drag-icon" src={icon} alt="" />
      <svg className="art-arrow" viewBox="0 0 80 16" aria-hidden="true"><path d="M2 8h70m0 0-6-5m6 5-6 5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" strokeDasharray="4 5" /></svg>
      <span className="art-folder" aria-hidden="true"><svg viewBox="0 0 64 52"><path d="M4 10a4 4 0 0 1 4-4h16l6 6h26a4 4 0 0 1 4 4v28a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="currentColor" /><path d="M4 18h56v26a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4Z" fill="currentColor" opacity=".75" /></svg>Applications</span>
    </div>
  );
}

function Installer() {
  return (
    <div className="art-window art-install">
      <img src={icon} alt="" />
      <p className="art-title">Installing Aplos Mail</p>
      <span className="art-progress" aria-hidden="true"><i /></span>
    </div>
  );
}

function AllowRun({file}:{file:File}) {
  return (
    <div className="art-window art-allow">
      <p className="art-title">{file.name} Properties</p>
      <p className="art-row">Allow executing file as program<span className="art-switch" aria-hidden="true" /></p>
    </div>
  );
}

function Welcome() {
  return (
    <div className="art-window art-welcome">
      <img src={icon} alt="" />
      <p className="art-title">Welcome to Aplos Mail</p>
      <span className="art-account is-primary">Add Google account</span>
      <span className="art-account">Add Microsoft account</span>
      <span className="art-account">Other mail (IMAP)</span>
    </div>
  );
}

