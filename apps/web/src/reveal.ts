import {useEffect} from 'react';

// Elements marked data-reveal rise into place once, as they enter the viewport. Styles live in styles.css.
export function useReveal() {
  useEffect(()=>{
    const items=[...document.querySelectorAll<HTMLElement>('[data-reveal]')];
    if(!('IntersectionObserver' in window)){items.forEach(i=>i.classList.add('is-in'));return;}
    const observer=new IntersectionObserver(entries=>{
      for(const entry of entries)if(entry.isIntersecting){entry.target.classList.add('is-in');observer.unobserve(entry.target);}
    },{rootMargin:'0px 0px -8% 0px',threshold:0.12});
    items.forEach(i=>observer.observe(i));
    return ()=>observer.disconnect();
  },[]);
}
