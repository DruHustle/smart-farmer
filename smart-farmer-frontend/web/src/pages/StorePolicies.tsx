import {Icon} from '../components/ui';

export function StorePolicies({policy}: {policy: 'privacy' | 'community-guidelines'}) {
  const privacy = policy === 'privacy';
  return <div className="auth-screen">
    <header className="auth-top">
      <a className="brand" href="/" aria-label="Smart Farmer home">
        <span className="brand-mark"><Icon name="leaf" size={23}/></span>
        <strong>Smart Farmer</strong>
      </a>
    </header>
    <main className="store-policy auth-card">
      <h1>{privacy ? 'Privacy policy' : 'Community guidelines'}</h1>
      <p className="muted small">Updated <time dateTime="2026-11-28">28 November 2026</time></p>
      {privacy ? <PrivacyPolicy/> : <CommunityGuidelines/>}
    </main>
    <footer className="auth-footer">
      <a href="/privacy">Privacy policy</a> · <a href="/community-guidelines">Community guidelines</a> · <a href="/account-deletion">Delete your Smart Farmer account</a>
    </footer>
  </div>;
}

function PrivacyPolicy() {
  return <>
    <p>This policy covers the Smart Farmer website and apps for Android, iPhone and iPad.</p>
    <h2>Who handles your data</h2>
    <p>Onesa UG (haftungsbeschränkt), Steinhofweg 47, 69123 Heidelberg, Germany, operates Smart Farmer. For a privacy enquiry, email <a href="mailto:info@onesa.eu">info@onesa.eu</a> or use the <a href="https://onesa.eu/en/contact">Onesa contact form</a>.</p>
    <h2>What we collect and why</h2>
    <ul>
      <li><strong>Account and membership information.</strong> We use your account identifier, sign-in information, farm memberships and preferences to authenticate you, give you access to the right records and remember your settings. Onesa Identity handles managed sign-in.</li>
      <li><strong>Farm records and files.</strong> We process the records you save, which can include farm and asset locations, activity records, photos, voice notes, invoices and contact or business details. We use them to provide the workspace, reports, downloads, and features you request, such as extracting text from an invoice.</li>
      <li><strong>Marketplace and community activity.</strong> We process listings, bookings, enquiries, recorded payments, forum posts, preferences and reports so users can interact and the service can handle disputes and reports.</li>
      <li><strong>Service and notification information.</strong> We use session and operational records to secure the service and investigate failures. If you enable a notification channel, we use its delivery address or device token to deliver the notifications you request.</li>
    </ul>
    <h2>Who can see your information</h2>
    <p>Farm records are available to users with the appropriate farm permissions. Other participants can see the information you share with them through transactions or messages. Marketplace listings you publish can be public. Forum posts and their chosen display names can be seen by signed-in community members across participating farms.</p>
    <p>Service providers process data as needed for functions such as hosting, sign-in, storage and notification delivery. Contact us for information about the providers, data locations and safeguards that apply to your use of Smart Farmer.</p>
    <h2>Why we use your information</h2>
    <p>We use account and workspace information to provide the service you request. We also process information to protect accounts, keep the service reliable, handle reports and disputes, and comply with legal requirements. Some features use permissions or settings you can change, such as media capture and optional notifications.</p>
    <h2>Device permissions and offline data</h2>
    <p>The app requests camera, microphone or photo-library access when needed for a feature you choose. You can manage these permissions in your device settings. The native app encrypts its offline workspace and protects access with the device’s secure storage and unlock controls. Synchronize unsent records before removing the app or changing devices.</p>
    <h2>Retention and your choices</h2>
    <p>We keep data for as long as needed to operate the service, maintain shared records, manage security and disputes, and meet applicable legal obligations. Information retained for those purposes or in backups may take longer to remove than information in your active account.</p>
    <p>Use <a href="/account-deletion">Delete your Smart Farmer account</a> or the account-deletion control in the app to submit a deletion request. Contact us to request access, correction, deletion, a copy of your data, or to exercise other rights that apply to you. You can also raise a concern with your data protection authority. Requests affecting your separate Onesa account are handled through <a href="https://account.onesa.eu/account">Onesa Account</a>.</p>
  </>;
}

function CommunityGuidelines() {
  return <>
    <p>Use the Smart Farmer forum to exchange practical farming questions and experience. These guidelines also apply when you use Smart Farmer to publish listings or contact other members.</p>
    <h2>Treat other members with respect</h2>
    <p>Discuss ideas without harassing, threatening or discriminating against people. Use a display name that does not impersonate someone else. Keep listings and offers accurate, and avoid scams, spam and misleading claims.</p>
    <h2>Share only what you have permission to share</h2>
    <p>Forum posts and replies can be read by signed-in community members from other farms. Keep passwords, private farm records, exact locations and other people’s personal information out of posts. Publish photos, text and other material only if you own it or have permission to share it.</p>
    <h2>Keep advice safe and lawful</h2>
    <p>Share farming experience responsibly. Avoid instructions likely to endanger people or animals, and avoid offers that violate applicable laws. Use a qualified professional for decisions that require veterinary, chemical, electrical or equipment expertise.</p>
    <h2>Report a problem</h2>
    <p>Use the Report control on a forum post or reply to flag spam, abuse, unsafe advice, a privacy problem or another concern. Reports are reviewed by the responsible farm owners. They can hide content that violates these guidelines. You can also email <a href="mailto:info@onesa.eu">info@onesa.eu</a> when you need help with a report.</p>
    <p>See the <a href="/privacy">privacy policy</a> for how Smart Farmer handles community information.</p>
  </>;
}
