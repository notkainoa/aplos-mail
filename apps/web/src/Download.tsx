import {useEffect,useRef,useState} from 'react';
import icon from './assets/icon-512.webp';
import {Airmail,Footer,Header} from './Chrome';
import {AllowRunArt,DockArt,DownloadsArt,DragArt,FinderArt,InstallerArt,WelcomeArt} from './InstallArt';
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

  const autoTimer=useRef(0),stallTimer=useRef(0);
  const start=(chosen:File)=>{
    // Sample data points at files that do not exist yet, so nothing is fetched until there is a real release.
    if(!release.sample)window.location.assign(chosen.url);
    setStarted(true);setStalled(false);
    window.clearTimeout(stallTimer.current);
    stallTimer.current=window.setTimeout(()=>setStalled(true),3500);
  };

  useEffect(()=>{
    let live=true;
    void detect().then(result=>{
      if(!live)return;
      setFound(result);setTarget(result.target);
      // Only start by itself when the build is known; a wrong guess would download a file that cannot run.
      if(result.target&&result.sure)autoTimer.current=window.setTimeout(()=>start(findFile(result.target!)),700);
    });
    return ()=>{live=false;window.clearTimeout(autoTimer.current);window.clearTimeout(stallTimer.current);};
  },[]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose=(next:Target)=>{
    window.clearTimeout(autoTimer.current);window.clearTimeout(stallTimer.current);
    setTarget(next);setStarted(false);setStalled(false);
  };
  const os:Os=file?.platform.os??'mac';
  const guessed=!!found&&!found.sure&&!!file;
  const title=!found?'Getting your download ready':found.mobile?'Aplos Mail is for your computer':file&&!guessed?'Your download is on its way':'Download Aplos Mail';
  const lead=!found?'\u00a0':found.mobile
    ?'Open this page on your computer and the right version downloads by itself. Every version is listed below.'
    :guessed&&file?.platform.os==='mac'?'Most Macs made since 2020 have Apple silicon. If yours has an Intel chip, choose Intel below.'
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
            {file&&<Status file={file} started={started} stalled={stalled} onStart={()=>start(file)} />}
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
          {release.sample&&<p className="dl-sample">Preview with sample data. Aplos Mail isn’t released yet, so nothing downloads.</p>}
        </section>
        <section className="dl-steps" aria-labelledby="steps-title">
          <h2 id="steps-title" className="sr">How to install</h2>
          <ol>
            {steps[os].map(([Art,text],i)=>(
              // Keyed by position: the steps change with the system, but the page's reveal keeps watching the same items.
              <li key={i} data-reveal style={delay(i*90)}>
                <div className="dl-art" data-ui aria-hidden="true"><Art file={file??findFile('mac-arm64')} /></div>
                <p>{text(file??findFile('mac-arm64'))}</p>
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
                      onClick={event=>{event.preventDefault();choose(f.target);start(f);}}>
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

// Install steps for each system, each with a close-up drawing from InstallArt.
type Step=[(props:{file:File})=>React.ReactElement,(file:File)=>React.ReactNode];
const steps:Record<Os,Step[]>={
  mac:[
    [DockArt,f=><>Open <b>{f.name.replace(/-[\d.]+-\w+(?=\.dmg)/,'')}</b> from your <b>Downloads</b> folder</>],
    [DragArt,()=><>Drag the <b>Aplos Mail</b> icon into your <b>Applications</b> folder</>],
    [()=><FinderArt />,()=><>Open <b>Aplos Mail</b> from your <b>Applications</b> folder</>],
  ],
  win:[
    [DownloadsArt,()=><>Open <b>Aplos Mail Setup</b> from your <b>Downloads</b> folder</>],
    [InstallerArt,()=><>Let the installer finish. It takes <b>under a minute</b></>],
    [WelcomeArt,()=><>Open <b>Aplos Mail</b> from the <b>Start</b> menu and add your accounts</>],
  ],
  linux:[
    [DownloadsArt,()=><>Find the <b>AppImage</b> in your <b>Downloads</b> folder</>],
    [AllowRunArt,()=><>In its <b>Properties</b>, allow it to <b>run as a program</b></>],
    [WelcomeArt,()=><>Open <b>Aplos Mail</b> and add your accounts</>],
  ],
};
