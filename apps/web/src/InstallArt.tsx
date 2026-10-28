import icon from './assets/icon-512.webp';

// Close-up drawings for the install steps: one big, cropped piece of the computer per step, each playing its step on a
// loop while it is on screen. Everything is drawn here; the only image is the Aplos Mail icon. Sizes are in container
// units, so a drawing scales with its tile.

// A cursor shape drawn twice: a dark outline pass under a white fill pass, so overlapping parts read as one shape.
function Outlined({ children }: { children: React.ReactNode }) {
  return (
    <>
      <g fill="none" stroke="#111" strokeWidth="2.6" strokeLinejoin="round">
        {children}
      </g>
      <g fill="#fff">{children}</g>
    </>
  );
}
function GrabHand({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <Outlined>
        <rect x="7.5" y="8" width="4.6" height="11" rx="2.3" />
        <rect x="11.9" y="6.5" width="4.6" height="12" rx="2.3" />
        <rect x="16.3" y="7" width="4.6" height="12" rx="2.3" />
        <rect x="20.7" y="9" width="4.4" height="10" rx="2.2" />
        <rect x="3.2" y="13.5" width="4.8" height="9.5" rx="2.4" transform="rotate(-28 5.6 18.2)" />
        <rect x="7" y="13" width="18.4" height="14.5" rx="6.5" />
      </Outlined>
      <path
        d="M12 9.5v5M16.4 9v5.5M20.8 10v5"
        stroke="#111"
        strokeWidth="1.1"
        strokeLinecap="round"
      />
    </svg>
  );
}
function Arrow({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 22" aria-hidden="true">
      <path
        d="M1.5 1.5v16l4-3.6 2.8 6.4 2.8-1.2-2.7-6.2h5.4Z"
        fill="#fff"
        stroke="#111"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
// A folder. `part` draws only its back or its front, so something can drop in between them.
function Folder({
  className,
  glyph,
  part,
}: {
  className?: string;
  glyph?: React.ReactNode;
  part?: 'back' | 'front';
}) {
  return (
    <svg className={className} viewBox="0 0 120 92" aria-hidden="true">
      {part !== 'front' && (
        <path d="M8 14a8 8 0 0 1 8-8h28l10 10h50a8 8 0 0 1 8 8v8H8Z" fill="#2f8ff0" />
      )}
      {part !== 'back' && (
        <>
          <rect x="6" y="24" width="108" height="64" rx="9" fill="#5bb4f7" />
          <rect x="6" y="24" width="108" height="4" rx="2" fill="#86c9fa" />
          {glyph}
        </>
      )}
    </svg>
  );
}
const appsGlyph = (
  <g fill="#fff" opacity=".85">
    <rect x="45" y="40" width="13" height="13" rx="3.5" />
    <rect x="62" y="40" width="13" height="13" rx="3.5" />
    <rect x="45" y="57" width="13" height="13" rx="3.5" />
    <rect x="62" y="57" width="13" height="13" rx="3.5" />
  </g>
);
const downloadGlyph = (
  <path
    d="M60 40v24m0 0-9-9m9 9 9-9"
    fill="none"
    stroke="#fff"
    strokeWidth="5"
    strokeLinecap="round"
    strokeLinejoin="round"
    opacity=".9"
  />
);

// Step 1 on a Mac: the Downloads stack in the Dock, with its name showing above it.
export function DockArt() {
  return (
    <div className="art art-dock">
      <span className="art-tip">Downloads</span>
      <div className="art-dock-bar">
        <i className="art-dock-sep" />
        <span className="art-stack">
          <Folder className="art-stack-folder" />
          <span className="art-stack-doc">
            <img src={icon} alt="" />
          </span>
        </span>
        <svg className="art-trash" viewBox="0 0 80 92" aria-hidden="true">
          <path
            d="M8 16h64l-7 70a6 6 0 0 1-6 5H21a6 6 0 0 1-6-5Z"
            fill="currentColor"
            opacity=".55"
          />
          <path
            d="M26 30l2 48M40 30v48M54 30l-2 48"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            opacity=".5"
          />
          <ellipse cx="40" cy="16" rx="34" ry="8" fill="currentColor" opacity=".8" />
        </svg>
      </div>
    </div>
  );
}

// Step 2 on a Mac: the icon, held by the pointer, goes into the Applications folder.
export function DragArt() {
  return (
    <div className="art art-drag">
      <i className="art-glow" />
      <i className="art-dots" />
      <Folder className="art-drag-folder" part="back" />
      <div className="art-carry">
        <img className="art-drag-icon" src={icon} alt="" />
      </div>
      <Folder className="art-drag-folder" part="front" glyph={appsGlyph} />
      <GrabHand className="art-hand art-echo art-echo-2" />
      <GrabHand className="art-hand art-echo art-echo-1" />
      <GrabHand className="art-hand" />
    </div>
  );
}

// Step 3 on a Mac: Applications in the Finder, the selection moving to Aplos Mail and the pointer opening it.
const apps = ['Calculator', 'Chess', 'Aplos Mail', 'Dictionary', 'Maps', 'Notes', 'Preview'];
const tints = ['#8e8e93', '#b8956a', '', '#d9534f', '#34a853', '#f2c94c', '#5b8def'];
const side = ['Recents', 'Applications', 'Desktop', 'Documents', 'Downloads'];
export function FinderArt() {
  const title = 'Applications',
    pick = 2;
  return (
    <div className="art art-finder" style={{ '--pick': pick } as React.CSSProperties}>
      <div className="art-win">
        <div className="art-win-bar">
          <i />
          <i />
          <i />
          <b>{title}</b>
        </div>
        <div className="art-win-body">
          <ul className="art-side">
            <li className="art-side-label">Favorites</li>
            {side.map(s => (
              <li key={s} className={s === title ? 'is-on' : ''}>
                {s}
              </li>
            ))}
          </ul>
          <ul className="art-list">
            <li className="art-sel" aria-hidden="true" />
            {apps.map((r, i) => (
              <li key={r} className={i === pick ? 'is-ours' : ''}>
                {i === pick ? (
                  <img src={icon} alt="" />
                ) : (
                  <span style={{ background: tints[i % tints.length] }} />
                )}
                {r}
              </li>
            ))}
          </ul>
          <div className="art-preview">
            <img src={icon} alt="" />
            <b>Aplos Mail</b>
            <span>Application</span>
          </div>
        </div>
      </div>
      <Arrow className="art-pointer" />
    </div>
  );
}
