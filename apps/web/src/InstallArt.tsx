import logo from '../brand/aplos-mail.svg';

// Close-up drawings for the install steps: one cropped piece of the Mac per step, drawn here in the site's calm
// greys. The only image is the Aplos Mail logo. Sizes are container units, so a drawing scales with its tile.

function Pointer({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 22" aria-hidden="true">
      <path
        d="M1.5 1.5v16l4-3.6 2.8 6.4 2.8-1.2-2.7-6.2h5.4Z"
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

function Arrow() {
  return (
    <svg className="art-arrow" viewBox="0 0 64 24" aria-hidden="true">
      <path d="M4 12h54M47 3l11 9-11 9" />
    </svg>
  );
}

function TrafficDots() {
  return (
    <>
      <i />
      <i />
      <i />
    </>
  );
}

// Step 2: the disk image's window, as it opens: Aplos Mail on the left, an arrow, Applications on the right.
export function DragArt() {
  return (
    <div className="art art-drag">
      <div className="art-dmg">
        <div className="art-win-bar">
          <TrafficDots />
          <b>Aplos Mail</b>
        </div>
        <div className="art-dmg-row">
          <span className="art-dmg-item">
            <img src={logo} alt="" />
            Aplos Mail
          </span>
          <Arrow />
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

type Item = { name: string; ours?: boolean; disk?: boolean };

const applications: Item[] = [
  { name: 'Calculator' },
  { name: 'Chess' },
  { name: 'Aplos Mail', ours: true },
  { name: 'Dictionary' },
  { name: 'Maps' },
  { name: 'Notes' },
];
const downloads: Item[] = [
  { name: 'Invoice.pdf' },
  { name: 'Aplos Mail.dmg', ours: true, disk: true },
  { name: 'Photo.jpg' },
  { name: 'Notes.txt' },
];
const side = ['Recents', 'Applications', 'Desktop', 'Documents', 'Downloads'];

function DiskIcon() {
  return (
    <svg className="art-disk" viewBox="0 0 20 20" aria-hidden="true">
      <rect x="1" y="3" width="18" height="14" rx="3.5" />
      <rect className="art-disk-label" x="1" y="11" width="18" height="6" rx="3" />
    </svg>
  );
}

function ItemIcon({ item }: { item: Item }) {
  if (item.disk) return <DiskIcon />;
  if (item.ours) return <img src={logo} alt="" />;
  return <span className="art-app" />;
}

function FinderList({ items }: { items: Item[] }) {
  return (
    <ul className="art-list">
      {items.map(item => (
        <li key={item.name} className={item.ours ? 'is-ours' : ''}>
          <ItemIcon item={item} />
          {item.name}
        </li>
      ))}
    </ul>
  );
}

type FinderProps = { title: string; items: Item[]; pointer: string };

function Finder({ title, items, pointer }: FinderProps) {
  return (
    <div className="art art-finder">
      <div className="art-win">
        <div className="art-win-bar">
          <TrafficDots />
          <b>{title}</b>
        </div>
        <div className="art-win-body">
          <ul className="art-side">
            {side.map(name => (
              <li key={name} className={name === title ? 'is-on' : ''}>
                {name}
              </li>
            ))}
          </ul>
          <FinderList items={items} />
        </div>
      </div>
      <Pointer className={`art-pointer ${pointer}`} />
    </div>
  );
}

// Step 1: the disk image in the Downloads folder, selected under the pointer.
export function DownloadsArt() {
  return <Finder title="Downloads" items={downloads} pointer="art-pointer-one" />;
}

// Step 3: Applications in the Finder, with Aplos Mail selected under the pointer.
export function FinderArt() {
  return <Finder title="Applications" items={applications} pointer="art-pointer-finder" />;
}
