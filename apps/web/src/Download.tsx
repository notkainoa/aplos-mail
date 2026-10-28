import { useEffect, useState } from 'react';
import icon from './assets/icon-512.webp';
import { Footer, Header } from './Chrome';
import { DockArt, DragArt, FinderArt } from './InstallArt';
import { Rise } from './Live';
import { detect, type Detected } from './platform';
import { megabytes, release, requires } from './release';
import { useReveal } from './reveal';

// The page the Download buttons lead to. While there is no public release (the repository is private), it says that
// builds are shared with invited testers and who can use the app. Once `release` is filled in, it lists the Mac builds
// and marks the one for this Mac; see VISION.md.
const delay = (ms: number) => ({ '--d': `${ms}ms` }) as React.CSSProperties;

function DownloadIcon() {
  return (
    <svg className="dl-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path
        d="M8 2.5v8m0 0L4.75 7.25M8 10.5l3.25-3.25M3 13.25h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Download() {
  useReveal();
  const [found, setFound] = useState<Detected | null>(null);
  useEffect(() => {
    if (!release) return;
    let live = true;
    void detect().then(result => live && setFound(result));
    return () => {
      live = false;
    };
  }, []);

  const title = release ? 'Download Aplos Mail' : 'Aplos Mail is with invited testers';
  const released =
    release &&
    new Date(`${release.date}T12:00:00`).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

  return (
    <>
      <div className="sky dl-sky">
        <Header home="../" />
        <section className="dl-hero" aria-labelledby="dl-title">
          <img className="dl-app" src={icon} width="512" height="512" alt="" data-reveal />
          <h1 id="dl-title">
            <Rise text={title} />
          </h1>
          {release ? (
            <p className="dl-lead" data-reveal style={delay(80)}>
              Aplos Mail {release.version} for Mac. It takes about a minute to install.
            </p>
          ) : (
            <p
              className="dl-lead"
              data-reveal
              data-claim="invited-testers-builds"
              style={delay(80)}
            >
              There is no public download yet. Builds are shared directly with invited testers.
            </p>
          )}
          <div className="dl-actions" data-reveal style={delay(160)}>
            <a className="dl-pill" href="#all">
              <span>{release ? 'All versions' : 'Who can use it'}</span>
              <svg className="dl-icon" viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M8 3v10m0 0-4-4m4 4 4-4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </div>
        </section>
        <section className="dl-steps" aria-labelledby="steps-title">
          <h2 id="steps-title" className="sr">
            How to install
          </h2>
          <ol data-claim="dmg-install">
            {steps.map(([Art, text], i) => (
              <li key={i} data-reveal style={delay(i * 90)}>
                <div className="dl-art" data-ui aria-hidden="true">
                  <Art />
                </div>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </section>
      </div>

      <main className="dl-main">
        <section className="dl-all" id="all" aria-labelledby="all-title">
          <h2 id="all-title" data-reveal>
            {release ? 'All versions' : 'Who can use it'}
          </h2>
          <p className="dl-all-lead" data-reveal style={delay(70)}>
            {release ? (
              <>
                Aplos Mail {release.version}, released {released}.{' '}
                <a href={release.notesUrl}>What’s new</a>
              </>
            ) : (
              'No public release yet.'
            )}
          </p>
          <div className="dl-platforms">
            <article className="dl-platform" data-reveal style={delay(100)}>
              <h3>Aplos Mail for Mac</h3>
              <p data-claim="mac-chips macos-13">For {requires}</p>
              {release && (
                <div className="dl-files">
                  {release.files.map(f => (
                    <a
                      key={f.target}
                      className={`dl-file${f.target === found?.target ? ' is-yours' : ''}`}
                      href={f.url}
                      download
                    >
                      <DownloadIcon />
                      <span>
                        {f.label} <small>.dmg</small>
                      </span>
                      <small>{megabytes(f.size)}</small>
                    </a>
                  ))}
                </div>
              )}
            </article>
            <article className="dl-platform" data-reveal style={delay(170)}>
              <h3>Gmail and Google Calendar</h3>
              <p data-claim="gmail-invited-testers google-weekly-reconnect">
                Available to invited testers. While Aplos Mail is in testing, Google lets only
                listed test users sign in, and a sign-in lasts 7 days, so testers reconnect once a
                week.
              </p>
            </article>
          </div>
        </section>
      </main>
      <Footer home="../" />
    </>
  );
}

// Install steps on a Mac, each with a close-up drawing from InstallArt.
const steps: [() => React.ReactElement, React.ReactNode][] = [
  [
    DockArt,
    <>
      Open the <b>Aplos Mail</b> disk image from your <b>Downloads</b> folder
    </>,
  ],
  [
    DragArt,
    <>
      Drag the <b>Aplos Mail</b> icon into your <b>Applications</b> folder
    </>,
  ],
  [
    FinderArt,
    <>
      Open <b>Aplos Mail</b> from your <b>Applications</b> folder
    </>,
  ],
];
