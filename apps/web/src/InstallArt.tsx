import logo from '../brand/aplos-mail.svg';

// Close-up drawings for the install steps: one cropped piece of the Mac per step, drawn here in the site's calm
// greys. The only image is the Aplos Mail logo. Sizes are container units, so a drawing scales with its tile.

function Pointer({ className }: { className: string }) {
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

function Folder({ className, glyph }: { className: string; glyph?: React.ReactNode }) {
  return (
    <svg className={className} viewBox="0 0 120 92" aria-hidden="true">
      <path className="folder-back" d="M8 14a8 8 0 0 1 8-8h28l10 10h50a8 8 0 0 1 8 8v8H8Z" />
      <rect className="folder-front" x="6" y="24" width="108" height="64" rx="9" />
      {glyph}
    </svg>
  );
}

const appsGlyph = (
  <g className="folder-glyph">
    <rect x="45" y="40" width="13" height="13" rx="3.5" />
    <rect x="62" y="40" width="13" height="13" rx="3.5" />
    <rect x="45" y="57" width="13" height="13" rx="3.5" />
    <rect x="62" y="57" width="13" height="13" rx="3.5" />
  </g>
);

// Step 1: the Downloads stack in the Dock, with the disk image on top and its name above it.
export function DockArt() {
  return (
    <div className="art art-dock">
      <span className="art-tip">Downloads</span>
      <div className="art-dock-bar">
        <span className="art-stack">
          <Folder className="art-stack-folder" />
          <span className="art-stack-doc">
            <img src={logo} alt="" />
          </span>
        </span>
      </div>
    </div>
  );
}

function Chevrons() {
  return (
    <svg className="art-arrows" viewBox="0 0 64 30" aria-hidden="true">
      <path d="M5 5l10 10-10 10" opacity=".3" />
      <path d="M27 5l10 10-10 10" opacity=".6" />
      <path d="M49 5l10 10-10 10" />
    </svg>
  );
}

// Step 2: the disk image's window, as it opens: Aplos Mail on the left, Applications on the right.
export function DragArt() {
  return (
    <div className="art art-drag">
      <div className="art-dmg">
        <p className="art-dmg-line">
          Drag <b>Aplos Mail</b> to <b>Applications</b>
        </p>
        <div className="art-dmg-row">
          <span className="art-dmg-item">
            <img src={logo} alt="" />
            Aplos Mail
          </span>
          <Chevrons />
          <span className="art-dmg-item">
            <Folder className="art-dmg-folder" glyph={appsGlyph} />
            Applications
          </span>
        </div>
      </div>
      <Pointer className="art-pointer art-pointer-drag" />
    </div>
  );
}

const apps = ['Calculator', 'Chess', 'Aplos Mail', 'Dictionary', 'Maps', 'Notes'];
const side = ['Recents', 'Applications', 'Desktop', 'Documents', 'Downloads'];
const PICK = 2;

function FinderList() {
  return (
    <ul className="art-list">
      {apps.map((name, i) => (
        <li key={name} className={i === PICK ? 'is-ours' : ''}>
          {i === PICK ? <img src={logo} alt="" /> : <span className="art-app" />}
          {name}
        </li>
      ))}
    </ul>
  );
}

// Step 3: Applications in the Finder, with Aplos Mail selected under the pointer.
export function FinderArt() {
  return (
    <div className="art art-finder">
      <div className="art-win">
        <div className="art-win-bar">
          <i />
          <i />
          <i />
          <b>Applications</b>
        </div>
        <div className="art-win-body">
          <ul className="art-side">
            {side.map(name => (
              <li key={name} className={name === 'Applications' ? 'is-on' : ''}>
                {name}
              </li>
            ))}
          </ul>
          <FinderList />
        </div>
      </div>
      <Pointer className="art-pointer art-pointer-finder" />
    </div>
  );
}
