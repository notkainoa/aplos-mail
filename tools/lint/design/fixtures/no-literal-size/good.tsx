// Plain data objects with layout-looking keys are not style objects.
export const layout = { top: 40, height: 120, gap: 8 };
export const columns = { count: 3, gap: 2 };

export function View() {
  return (
    <div>
      <span style={{ padding: 'var(--space-2) var(--space-3)' }} />
      <span style={{ padding: 0, margin: 0 }} />
      <span style={{ marginLeft: 'calc(var(--space-2) * -1)' }} />
      <span style={{ font: 'var(--type-base)', letterSpacing: 'var(--track-base)' }} />
      <span style={{ borderRadius: 'var(--radius-md)' }} />
      <span style={{ boxShadow: 'var(--elev-card)' }} />
      <span style={{ boxShadow: '0 0 0 1px var(--line)' }} />
      <span style={{ zIndex: 0, lineHeight: 'normal' }} />
      <span style={{ padding: `var(--space-${2})` }} />
    </div>
  );
}

export const shorthand = `padding: var(--space-2); margin: 0`;

export function place(el: HTMLElement) {
  el.style.padding = 'var(--space-2)';
  el.style.setProperty('gap', 'var(--space-3)');
}

const roomy = { padding: 'var(--space-3)' };
const offsets = { top: 40 };
export const roomier = <div style={roomy} data-offsets={offsets.top} />;
