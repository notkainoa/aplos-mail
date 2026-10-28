import src from '../../../../assets/icon-256.png';

/** The app icon, exported from assets/AppIcon.icon by scripts/build-icon.mjs. */
export function AppIcon({ size = 40 }: { size?: number }) {
  return <img className="app-icon" src={src} width={size} height={size} alt="" draggable={false} />;
}
