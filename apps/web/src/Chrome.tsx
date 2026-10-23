import icon from '../../desktop/assets/icon.svg';
import {releasesUrl,repoUrl} from './site';

export function Header({home}:{home:string}) {
  return (
    <header className="bar">
      <a className="wordmark" href={home} aria-label="Aplos Mail, home">
        <img src={icon} width="28" height="28" alt="" />
        <span>Aplos Mail</span>
      </a>
      <a className="button button-small" href={releasesUrl}>Download for Mac</a>
    </header>
  );
}

export function Footer({home}:{home:string}) {
  return (
    <footer className="foot">
      <a className="wordmark" href={home}>
        <img src={icon} width="24" height="24" alt="" />
        <span>Aplos Mail</span>
      </a>
      <nav aria-label="Footer">
        <a href={`${home}privacy/`}>Privacy</a>
        <a href={repoUrl}>GitHub</a>
      </nav>
      <p>Independent software for Mac. Windows and Linux are planned.</p>
    </footer>
  );
}

const shots=import.meta.glob('./assets/shots/*.webp',{eager:true,import:'default'}) as Record<string,string>;

// One screenshot, light and dark, switched by the visitor's system setting.
export function Shot({name,alt,width,height,eager}:{name:string;alt:string;width:number;height:number;eager?:boolean}) {
  const src=(scheme:string)=>shots[`./assets/shots/${name}-${scheme}.webp`];
  return (
    <picture>
      <source media="(prefers-color-scheme: dark)" srcSet={src('dark')} />
      <img className="shot" src={src('light')} alt={alt} width={width} height={height} loading={eager?'eager':'lazy'} decoding="async" />
    </picture>
  );
}
