import { Footer, Header } from './Chrome';
import { useReveal } from './reveal';
import { contactEmail, legalUpdated } from './site';

const dataFolder = '~/Library/Application Support/Aplos Mail';
const logsFolder = '~/Library/Logs/Aplos Mail';
// Break points so the long path wraps on a phone instead of widening the page.
const prefsFile = (
  <>
    ~/Library/
    <wbr />
    Preferences/
    <wbr />
    com.aplos.mail.plist
  </>
);

export function Privacy() {
  useReveal();
  return (
    <div className="site">
      <div className="page">
        <Header home="../" page="privacy" />
        <main className="doc">
          <p className="draft">Last updated {legalUpdated}</p>
          <h1>Privacy policy</h1>
          <p className="lead" data-claim="mail-stays-on-mac">
            Aplos Mail keeps your mail on your Mac. This page says what the app and this website do
            with your data.
          </p>

          <h2>What Aplos Mail is</h2>
          <p data-claim="gmail-google-calendar no-aplos-server">
            Aplos Mail is a Mac app for Gmail and Google Calendar. It connects straight from your
            Mac to Google and, when you use AI features, to the AI provider you choose. Aplos runs
            no server that receives your mail, your calendar or your sign-in details.
          </p>
          {/* claims-allow: beta-badge */}
          <p data-claim="beta-invited-testers google-weekly-reconnect">
            {/* claims-allow: beta-badge */}
            Aplos Mail is in beta. During the beta, Google sign-in is limited to invited testers,
            and Google asks you to sign in again every 7 days. Using the app is also covered by the{' '}
            <a href="../terms/">terms of service</a>.
          </p>

          <h2>What stays on your Mac</h2>
          <p data-claim="local-database retention-default">
            The app keeps a local database of your mail, drafts, calendar events and settings in{' '}
            <code>{dataFolder}</code>. It keeps the text of messages from the last 90 days, plus any
            message you opened in Aplos, starred or left unread, all up to 2&nbsp;GB. You can change
            both limits in Settings → Mail. Past the size limit, text goes first from mail you
            haven’t opened in Aplos, starred or left unread, then from the mail you read longest
            ago. Text that was dropped is fetched from Google again when you open the message.
            Subjects, senders, folders and the search index stay, so older mail is still searchable.
            Drafts and mail that is only on your Mac keep their text.
          </p>
          <p data-claim="update-backups">
            Before an app update changes the database, Aplos saves a copy of it in the same folder
            and deletes that copy after 14 days. If the database is ever damaged, Aplos keeps a copy
            of the damaged file there for 30 days. These copies can hold text the rules above have
            dropped.
          </p>
          <p data-claim="keychain-protected-secrets">
            Sign-in tokens and the AI keys you save are encrypted with a key that the macOS keychain
            protects. The rest of the database relies on your Mac’s own disk encryption (FileVault).
          </p>

          <h2>What leaves your Mac</h2>
          <ul>
            <li data-claim="google-requests">
              <b>Google</b> receives the requests the app makes to show, organize and send your
              Gmail and to show and change your Google Calendar events.
            </li>
            <li data-claim="ai-consent no-training-providers groq-default local-models">
              <b>The AI providers you set up</b> (Groq, unless you change it). The provider you
              picked for a feature receives the text that feature needs, such as an email thread,
              your question or a voice recording; any other provider you set up gets only key checks
              and requests for its list of models. Background AI starts only after you agree. Gemini
              gets mail only when you mark its key as paid, because Google may use what a free key
              sends to improve its products. Ollama and LM Studio run on your Mac, so text sent to
              them stays there. Each provider handles what it receives under its own terms.
            </li>
            <li data-claim="remote-images-blocked">
              <b>The server hosting an email’s images</b>, only when you allow images for that
              message, that sender or all mail. The app’s image proxy fetches them without cookies,
              but the server still sees a request from your internet connection.
            </li>
            <li data-claim="update-check">
              {/* claims-allow: github */}
              <b>GitHub</b> receives the app’s checks for new versions.
            </li>
          </ul>
          <p data-claim="only-these-destinations no-telemetry diagnostics-local">
            Nothing else. There is no telemetry and no crash upload. Logs, crash reports and
            diagnostics stay on your Mac, and leave it only if you export them and send them
            yourself.
          </p>

          <h2>Google user data</h2>
          <p data-claim="google-limited-use">
            Aplos Mail asks Google for access to your Gmail and Google Calendar only to show,
            organize and send your mail and manage your events inside the app. Aplos does not sell
            that data, use it for advertising or use it to train AI models, and it never reaches an
            Aplos server. It goes to an AI provider only for the features above: when you use one,
            or for background AI after you agree. As Google asks, Aplos Mail states: “The use of
            information received from Google Workspace scopes will adhere to the{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy">
              Google User Data Policy
            </a>
            , including the{' '}
            <a href="https://developers.google.com/terms/api-services-user-data-policy#additional_requirements_for_specific_api_scopes">
              Limited Use requirements
            </a>
            .”
          </p>

          <h2>This website</h2>
          <p data-claim="site-no-tracking">
            This website has no analytics, no cookies and no third-party scripts or fonts. It is
            hosted on Vercel, which handles each page request under its own terms.
          </p>

          <h2>Deleting your data</h2>
          <p data-claim="remove-account update-backups">
            Removing an account in Settings stops syncing it and deletes what Aplos stored for it on
            your Mac: its mail and attachments, drafts, events, AI summaries and saved Google
            sign-in. Aplos won’t remove an account while mail or a calendar update from it is still
            waiting to go out. It also deletes the copies Aplos saved before an update or of a
            damaged database, which hold all your accounts’ mail. Your mail stays with Google, and
            removing the account doesn’t withdraw the app’s access there; the end of this section
            says how.
          </p>
          <p data-claim="delete-data">
            To remove the app’s data, quit Aplos Mail and delete <code>{dataFolder}</code> and its
            logs in <code>{logsFolder}</code>. Outside those folders the app also keeps its
            preferences file, <code>{prefsFile}</code>, and a key named{' '}
            <b>Aplos Mail Safe Storage</b> in your login keychain, which you can delete in Keychain
            Access. To withdraw the app’s access to your Google account, remove Aplos Mail at{' '}
            <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>.
          </p>

          <h2>Contact</h2>
          <p data-claim="privacy-contact">
            Questions about privacy go to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
            When this page changes, the date at the top changes with it.
          </p>
        </main>
        <Footer home="../" />
      </div>
    </div>
  );
}
