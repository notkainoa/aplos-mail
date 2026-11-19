export const token = 'var(--accent)';
export const mix = 'color-mix(in srgb, var(--ink) 8%, transparent)';
export const anchor = '#main';
export const issue = 'Issue #12';
export const reference = 'url(#gradient)';
export const prose = 'Pick a colour (rgb values are not accepted); color(s) are tokens.';
export const hash = '#';

export function View() {
  return (
    <div>
      <span style={{ color: 'var(--ink)' }} />
      <span style={{ color: 'currentColor', background: 'transparent' }} />
      <span style={{ borderColor: 'var(--line-strong)', fill: 'inherit' }} />
      <span style={{ background: 'color-mix(in srgb, var(--accent) 8%, transparent)' }} />
    </div>
  );
}

export function paint(el: HTMLElement) {
  el.style.color = 'var(--ink)';
  el.style.setProperty('background', 'var(--paper)');
}

export const icon = <svg><path fill="currentColor" stroke="none" /><stop stopColor="var(--ink)" /></svg>;
export const note = 'Fixes #123';
export const isAdd = location.hash === '#add';
export const anchor = <a href="#fff">Top</a>;
const calm = { color: 'var(--ink)' };
export const calmer = <div style={calm} />;
