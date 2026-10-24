import {useEffect,useState} from 'react';
import icon from '../../desktop/assets/icon-64.png';
import {releasesUrl,repoUrl} from './site';

type Theme='light'|'dark';
const systemTheme=():Theme=>matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';
const currentTheme=():Theme=>{
  const set=document.documentElement.dataset.theme;
  return set==='light'||set==='dark'?set:systemTheme();
};

// Follows the system until the visitor picks one; the pick is kept in localStorage (no cookies).
function ThemeToggle() {
  const [theme,setTheme]=useState<Theme>('light');
  useEffect(()=>{
    setTheme(currentTheme());
    const media=matchMedia('(prefers-color-scheme: dark)');
    const sync=()=>setTheme(currentTheme());
    media.addEventListener('change',sync);
    return ()=>media.removeEventListener('change',sync);
  },[]);
  const next:Theme=theme==='dark'?'light':'dark';
  return (
    <button type="button" className="theme" aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}
      onClick={()=>{
        document.documentElement.dataset.theme=next;
        try{localStorage.setItem('aplos-theme',next);}catch{/* private mode: the choice just lasts this visit */}
        setTheme(next);
      }}>
      <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="7.25" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M10 2.75a7.25 7.25 0 0 1 0 14.5z" fill="currentColor" /></svg>
    </button>
  );
}

export function Header({home}:{home:string}) {
  return (
    <header className="bar">
      <div className="bar-inner">
        <a className="wordmark" href={home} aria-label="Aplos Mail, home">
          <img src={icon} width="32" height="32" alt="" />
          <span>Aplos Mail</span>
        </a>
        <nav aria-label="Main">
          <a href={`${home}#features`}>Features</a>
          <a href={`${home}privacy/`}>Privacy</a>
        </nav>
        <ThemeToggle />
        <a className="button button-small" href={releasesUrl}>Download for Mac</a>
      </div>
    </header>
  );
}

export function Footer({home}:{home:string}) {
  return (
    <footer className="foot">
      <div className="foot-row">
        <a className="wordmark" href={home}>
          <img src={icon} width="28" height="28" alt="" />
          <span>Aplos Mail</span>
        </a>
        <nav aria-label="Footer">
          <a href={`${home}privacy/`}>Privacy</a>
          <a href={repoUrl}>GitHub</a>
        </nav>
      </div>
      <p>Independent software for Mac. Windows and Linux are planned.</p>
      <div className="foot-name" aria-hidden="true">Aplos Mail</div>
    </footer>
  );
}

const shots=import.meta.glob('./assets/shots/*.webp',{eager:true,import:'default'}) as Record<string,string>;

// Both themes' screenshots are in the page; CSS shows the one that matches the theme, and the hidden one is never fetched (lazy).
export function Shot({name,alt,width,height,className}:{name:string;alt:string;width:number;height:number;className?:string}) {
  const img=(theme:Theme)=>(
    <img className={`shot shot-${theme}${className?` ${className}`:''}`} src={shots[`./assets/shots/${name}-${theme}.webp`]} alt={alt} width={width} height={height} loading="lazy" decoding="async" />
  );
  return <>{img('light')}{img('dark')}</>;
}
