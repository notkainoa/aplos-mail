import { Footer, Header } from './Chrome';
import { useReveal } from './reveal';
import { contactEmail, governingLaw, legalUpdated, operatorName } from './site';

// The terms of service: the same reading column as the privacy policy, and nothing in it may contradict that page.
export function Terms() {
  useReveal();
  return (
    <div className="site">
      <div className="page">
        <Header home="../" />
        <main className="doc">
          <p className="draft">Last updated {legalUpdated}</p>
          <h1>Terms of service</h1>
          <p className="lead">
            These terms cover your use of Aplos Mail, the Mac app, and this website. By using
            either, you agree to them. They are short on purpose.
          </p>

          <h2>Who provides it</h2>
          <p data-claim="terms-operator">
            Aplos Mail is provided by {operatorName}, an individual. In these terms, “Aplos” means{' '}
            {operatorName}.
          </p>

          {/* claims-allow: beta-badge */}
          <h2>The beta</h2>
          {/* claims-allow: beta-badge */}
          <p data-claim="terms-free beta-invited-testers google-weekly-reconnect">
            {/* claims-allow: beta-badge */}
            Aplos Mail is free to use and is in beta, open to invited testers. During the beta,
            Google sign-in is limited to invited testers, and Google asks you to sign in again every
            7 days.
          </p>

          <h2>Who can use it</h2>
          <p>
            You must be at least 13 years old, or older if the law where you live sets a higher
            minimum age for using a service like this one.
          </p>

          <h2>Your license</h2>
          <p>
            Aplos gives you a personal, non-exclusive license to install and use Aplos Mail on Macs
            you own or control, for as long as you follow these terms. Don’t present the app as your
            own or use the Aplos Mail name or logo for something else. Where a part of the app comes
            with its own open-source license, that license applies to that part.
          </p>

          <h2>Your accounts and content</h2>
          <p data-claim="mail-stays-on-mac no-aplos-server">
            Your Google accounts, your mail, your calendar and everything you write stay yours.
            Aplos Mail keeps your mail on your Mac, and no Aplos server ever sees your mail,
            calendar or sign-in details, so Aplos claims no rights to any of it. The{' '}
            <a href="../privacy/">privacy policy</a> says what the app does with your data.
          </p>

          <h2>Other services</h2>
          <p data-claim="terms-third-party groq-default">
            Aplos Mail connects to services you choose: Google, for Gmail and Google Calendar, and
            the AI providers you set up (Groq, unless you change it). Each of them is a separate
            company with its own terms and policies, which apply when you use it through Aplos Mail.
            You are responsible for following them and for any charges they make, such as the cost
            of an AI key.
          </p>

          <h2>Acceptable use</h2>
          <p>
            Don’t use Aplos Mail to break the law, to send spam, scams or harassment, to get into
            accounts or data that aren’t yours, or to disrupt Google’s or any other provider’s
            services. Don’t try to break into the app, or get around the limits it or those services
            set.
          </p>

          <h2>No warranty</h2>
          {/* claims-allow: beta-badge */}
          <p>
            {/* claims-allow: beta-badge */}
            Aplos Mail is early software in beta. It is provided “as is” and “as available”, without
            warranties of any kind, express or implied, including merchantability, fitness for a
            particular purpose and non-infringement. It may have bugs, change, or stop working, so
            keep your own copies of anything important.
          </p>

          <h2>Limitation of liability</h2>
          <p>
            As far as the law allows, Aplos is not liable for any indirect, incidental, special,
            consequential or punitive damages, or for lost data, messages, profits or time, that
            come from using or being unable to use Aplos Mail. Aplos’s total liability for any claim
            about the app or this website is limited to 50 US dollars. Some places don’t allow these
            limits, so they may not all apply to you.
          </p>

          <h2>Ending your use</h2>
          <p>
            {/* claims-allow: beta-badge */}
            Aplos may end your access to the beta, or stop offering Aplos Mail, at any time. You can
            stop using Aplos Mail whenever you like; the privacy policy says how to remove its data.
            The sections on warranty, liability and governing law still apply afterwards.
          </p>

          <h2>Changes to these terms</h2>
          <p>
            Aplos may change these terms. When they change, the date at the top changes with them.
            If you keep using Aplos Mail after a change, the new terms apply.
          </p>

          <h2>Governing law</h2>
          <p data-claim="terms-operator">
            These terms are governed by the laws of {governingLaw}, without regard to its rules on
            conflicts of law. This does not take away any rights the law where you live gives you.
          </p>

          <h2>Contact</h2>
          <p data-claim="privacy-contact">
            Questions about these terms go to <a href={`mailto:${contactEmail}`}>{contactEmail}</a>.
          </p>
        </main>
        <Footer home="../" />
      </div>
    </div>
  );
}
