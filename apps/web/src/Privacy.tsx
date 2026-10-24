import {Footer,Header} from './Chrome';

export function Privacy() {
  return (
    <>
      <div className="field paper"><Header home="../" /></div>
      <main className="doc">
        <p className="draft">Draft. This text has not been reviewed and will change before Aplos Mail is released or submitted for Google or Microsoft verification.</p>
        <h1>Privacy policy</h1>
        <p className="lead">Aplos Mail keeps your mail on your Mac. This page describes what the app and this website do with data.</p>

        <h2>What Aplos Mail is</h2>
        <p>Aplos Mail is a desktop app. It connects directly from your Mac to your mail provider and, when you use AI features, to the AI provider you choose. Aplos does not run a server that receives your mail, calendar or credentials.</p>

        <h2>Data stored on your Mac</h2>
        <p>Messages, drafts, calendar events and settings are kept in a local database in your user folder. Account passwords and sign-in tokens are encrypted with a key held in the macOS keychain. Mail is not encrypted at rest beyond what your Mac provides, so keep exports private.</p>

        <h2>Google and Microsoft accounts</h2>
        <p>When you sign in with Google or Microsoft, the app asks for access to mail and calendar so it can read, organize, send and display them for you. That data is used only to provide those features inside the app. It is not sold, used for advertising, or shared with Aplos. <span className="todo">[Final wording of the Google API Services User Data Policy and Limited Use statement to be added.]</span></p>

        <h2>AI providers</h2>
        <p>AI features (summaries, Ask, drafts, plans and voice) send the text they need, such as an email thread or a voice recording, to the provider you selected for that feature. Groq is the default. Each provider handles that data under its own terms. If you choose a model running on your Mac, such as Ollama or LM Studio, the text stays on your Mac. API keys stay in the app’s backend and are not included in the app’s interface.</p>

        <h2>Using Aplos on more than one device</h2>
        <p>If you turn on device sync, Aplos stores small, encrypted records of your Later, todo and reminder state in a hidden folder inside your own mail account. The key comes from a sync code that stays on your devices.</p>

        <h2>This website</h2>
        <p>This website has no analytics, no cookies and no third-party scripts. Downloads are served by GitHub under GitHub’s own privacy terms.</p>

        <h2>Your choices</h2>
        <p>You can disconnect an account or delete the app’s data folder at any time. Access granted to Google or Microsoft can also be revoked from your account settings with those providers.</p>

        <h2>Contact</h2>
        <p><span className="todo">[Contact email to be added.]</span></p>
      </main>
      <div className="field grass doc-end">
        <div className="band" />
        <Footer home="../" />
      </div>
    </>
  );
}
