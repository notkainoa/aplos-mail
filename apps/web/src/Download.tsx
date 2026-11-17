import { useEffect, useState } from 'react';
import { Footer, Header } from './Chrome';
import { ArrowDownIcon, DownloadIcon } from './Icons';
import { DownloadsArt, DragArt, FinderArt } from './InstallArt';
import { detect, type Detected } from './platform';
import { megabytes, release, requires, type Release } from './release';
import { useReveal } from './reveal';

// The page the "How to get it" links lead to. While there is no public release (the repository is private), it says
// that builds are shared with invited testers and who can use the app. Once `release` is filled in, it lists the Mac
// builds and marks the one for this Mac; see VISION.md.

function useDetected() {
  const [found, setFound] = useState<Detected | null>(null);
  useEffect(() => {
    if (!release) return;
    let live = true;
    void detect().then(result => live && setFound(result));
    return () => {
      live = false;
    };
  }, []);
  return found;
}

function releasedOn(date: string) {
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

function Intro() {
  return (
    <section className="dl-hero" aria-labelledby="dl-title" data-reveal>
      <h1 id="dl-title">
        {release ? 'Download Aplos Mail' : 'Aplos Mail is with invited testers.'}
      </h1>
      {release ? (
        <p className="dl-lead">
          Aplos Mail {release.version} for Mac. It takes about a minute to install.
        </p>
      ) : (
        <p className="dl-lead" data-claim="invited-testers-builds">
          There is no public download yet. Builds are shared directly with invited testers.
        </p>
      )}
      <a className="text-link text-link-strong dl-jump" href="#install">
        How to install
        <ArrowDownIcon />
      </a>
    </section>
  );
}

// Install steps on a Mac, each with a close-up drawing from InstallArt.
const steps: [() => React.ReactElement, React.ReactNode][] = [
  [
    DownloadsArt,
    <>
      Open the <b>Aplos Mail</b> disk image from your <b>Downloads</b> folder.
    </>,
  ],
  [
    DragArt,
    <>
      Drag the <b>Aplos Mail</b> icon into your <b>Applications</b> folder.
    </>,
  ],
  [
    FinderArt,
    <>
      Open <b>Aplos Mail</b> from your <b>Applications</b> folder.
    </>,
  ],
];

function Steps() {
  return (
    <section className="dl-steps" id="install" aria-labelledby="steps-title">
      <h2 id="steps-title" className="dl-section-title" data-reveal>
        How to install
      </h2>
      <ol data-claim="dmg-install">
        {steps.map(([Art, text], i) => (
          <li key={i} data-reveal>
            <div className="dl-art" aria-hidden="true">
              <Art />
            </div>
            <p>
              <span className="dl-step-number">{i + 1}</span>
              <span>{text}</span>
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Files({ files, found }: { files: Release['files']; found: Detected | null }) {
  return (
    <div className="dl-files">
      {files.map(file => (
        <a
          key={file.target}
          className={`dl-file${file.target === found?.target ? ' is-yours' : ''}`}
          href={file.url}
          download
        >
          <DownloadIcon />
          <span>
            {file.label} <small>.dmg</small>
          </span>
          <small>{megabytes(file.size)}</small>
        </a>
      ))}
    </div>
  );
}

function WhoCanUse({ found }: { found: Detected | null }) {
  return (
    <section className="dl-all" id="all" aria-labelledby="all-title">
      <div className="dl-all-head" data-reveal>
        <h2 id="all-title" className="dl-section-title">
          {release ? 'All versions' : 'Who can use it'}
        </h2>
        <p className="dl-all-lead">
          {release ? (
            <>
              Aplos Mail {release.version}, released {releasedOn(release.date)}.{' '}
              <a href={release.notesUrl}>What’s new</a>
            </>
          ) : (
            'No public release yet.'
          )}
        </p>
      </div>
      <div className="dl-columns">
        <article data-reveal>
          <h3>Aplos Mail for Mac</h3>
          <p data-claim="mac-chips macos-13">For {requires}</p>
          {release ? <Files files={release.files} found={found} /> : null}
        </article>
        <article data-reveal>
          <h3>Gmail and Google Calendar</h3>
          <p data-claim="gmail-invited-testers google-weekly-reconnect">
            Available to invited testers. While Aplos Mail is in testing, Google lets only listed
            test users sign in, and a sign-in lasts 7 days, so testers reconnect once a week.
          </p>
        </article>
      </div>
    </section>
  );
}

export function Download() {
  useReveal();
  const found = useDetected();
  return (
    <div className="site">
      <div className="page">
        <Header home="../" page="download" />
        <main className="dl">
          <Intro />
          <WhoCanUse found={found} />
          <Steps />
        </main>
        <Footer home="../" />
      </div>
    </div>
  );
}
