import {useState, type FormEvent} from 'react';
import type {Lang, SessionIdentity, Snapshot} from './types';
import {catalog, errorLabel} from './locales';
import {apiOrigin, request, jsonBody} from './lib/api';
import {Vault} from './lib/vault';
import {Field, Icon} from './components/ui';
type Mode = 'signIn' | 'register' | 'join' | 'recover' | 'offlineUnlock';
export function Auth({language, onLanguage, onLogin}: {language: Lang; onLanguage: (lang: Lang) => void; onLogin: (vault: Vault) => void}) {
  const [mode, setMode] = useState<Mode>('signIn'); const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const t = catalog[language];
  const [oneTimeCode, setOneTimeCode] = useState(''); const [pendingVault, setPendingVault] = useState<Vault | null>(null);
  const [challenge, setChallenge] = useState<{username: string; password: string; initial: Snapshot; recoveryCode: string} | null>(null);
  function finish(vault: Vault, code: string) {setChallenge(null); if (code) {setOneTimeCode(code); setPendingVault(vault);} else onLogin(vault);}
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const invalid = [...e.currentTarget.elements].find(element => element instanceof HTMLInputElement && !element.validity.valid) as HTMLInputElement | undefined; if (invalid) {setMessage(t.invalid_input); invalid.focus(); return;} const form = new FormData(e.currentTarget); const username = String(form.get('username') ?? '').trim().toLowerCase(), password = String(form.get('password') ?? ''); setBusy(true); setMessage('');
    try {
      if (mode === 'offlineUnlock') {
        const vault = await Vault.unlock(apiOrigin, username, password);
        if (vault.snapshot().requiresAuth) throw new Error('unauthorized');
        onLogin(vault); return;
      }
      if (mode === 'recover') {await request('/v1/recover', '', jsonBody({username, password, recoveryCode: String(form.get('recoveryCode'))})); setMessage(t.recovered); setMode('signIn'); return;}
      let recoveryCode = '';
      if (mode === 'register') {const created = await request<{recoveryCode: string}>('/v1/register', '', jsonBody({username, password, language, farmName: String(form.get('farmName'))})); recoveryCode = created.recoveryCode;}
      if (mode === 'join') {const created = await request<{recoveryCode?: string}>('/v1/invitations/accept', '', jsonBody({username, password, language, token: String(form.get('invitationToken'))})); recoveryCode = created.recoveryCode ?? '';}
      const identity = await request<SessionIdentity>('/v1/sessions', '', jsonBody({username, password}));
      const initial: Snapshot = {version: 1, identity, farms: [], currentFarmId: '', data: {}, outbox: [], language: identity.language};
      try {const vault = await Vault.unlock(apiOrigin, username, password, initial); finish(vault, recoveryCode);} catch (error) {if (error instanceof Error && error.message === 'saved_data_locked') {setChallenge({username, password, initial, recoveryCode}); return;} throw error;}
    } catch (error) {setMessage(errorLabel(t, error));} finally {setBusy(false);}
  }
  if (pendingVault && oneTimeCode) return <div className="auth-screen"><main className="recovery-screen"><div className="brand"><span className="brand-mark"><Icon name="lock"/></span><strong>Smart Farmer</strong></div><section className="auth-card"><h1>{t.recoveryCode}</h1><p>{t.keepCode}</p><div className="secret-result"><code>{oneTimeCode}</code></div><p className="muted small">{t.recoveryHint}</p><button className="primary" onClick={() => {const saved = pendingVault; setOneTimeCode(''); setPendingVault(null); onLogin(saved);}}>{t.savedCode}</button></section></main></div>;
  if (challenge) return <div className="auth-screen"><main className="recovery-screen"><div className="brand"><span className="brand-mark"><Icon name="lock"/></span><strong>Smart Farmer</strong></div><section className="auth-card"><h1>{t.recoverDrafts}</h1><p className="muted">{t.recoveryArchiveHint}</p><form className="form-grid" onSubmit={async e => {e.preventDefault(); const previous = String(new FormData(e.currentTarget).get('previousPassword')); setBusy(true); setMessage(''); try {const v = await Vault.recover(apiOrigin, challenge.username, challenge.password, challenge.initial, previous); finish(v, challenge.recoveryCode);} catch (error) {setMessage(errorLabel(t, error));} finally {setBusy(false);}}}><Field label={t.previousPassword}><input name="previousPassword" type="password" required autoComplete="current-password"/></Field><button className="primary" disabled={busy}>{t.recoverDrafts}</button><button type="button" className="secondary" disabled={busy} onClick={() => {setBusy(true); void Vault.recover(apiOrigin, challenge.username, challenge.password, challenge.initial).then(v => finish(v, challenge.recoveryCode)).catch(error => setMessage(errorLabel(t, error))).finally(() => setBusy(false));}}>{t.freshCache}</button>{message && <p className="notice error" role="alert">{message}</p>}</form></section></main></div>;
  return <div className="auth-screen"><header className="auth-top"><a className="brand" href="/" aria-label="Smart Farmer"><span className="brand-mark"><Icon name="leaf" size={23}/></span><strong>Smart Farmer</strong></a><Field label={t.language}><select aria-label={t.language} value={language} onChange={e => onLanguage(e.target.value as Lang)}><option value="sn">Shona</option><option value="nd">isiNdebele</option></select></Field></header>
    <main className="auth-main"><section className="auth-intro"><span className="eyebrow">SMART FARMER · ZIMBABWE</span><h1>{t.welcome}</h1><p>{t.intro}</p><div className="intro-items"><span><Icon name="leaf"/>{t.crop}</span><span><Icon name="animal"/>{t.animals}</span><span><Icon name="equipment"/>{t.equipment}</span></div><div className="privacy-note"><Icon name="lock"/><span>{t.privacy}</span></div></section>
      <section className="auth-card"><div className="auth-tabs"><button type="button" className={mode === 'signIn' ? 'selected' : ''} onClick={() => {setMode('signIn'); setMessage('');}}>{t.signIn}</button><button type="button" className={mode === 'register' ? 'selected' : ''} onClick={() => {setMode('register'); setMessage('');}}>{t.register}</button></div>
        <h2>{t[mode]}</h2>{mode === 'offlineUnlock' && <p className="muted">{t.offlineUnlockHint}</p>}{mode === 'recover' && <p className="muted">{t.recoveryHint}</p>}
        <form noValidate onSubmit={submit} className="form-grid" aria-label={t[mode]}><Field label={t.username}><input name="username" required minLength={3} maxLength={80} pattern="[A-Za-z0-9._-]+" autoComplete="username" autoCapitalize="none" spellCheck={false}/></Field>
          {mode === 'join' && <Field label={t.invitationToken}><input name="invitationToken" required autoComplete="off" spellCheck={false}/></Field>}
          {mode === 'recover' && <Field label={t.recoveryCode}><input name="recoveryCode" required autoComplete="off" spellCheck={false}/></Field>}
          <Field label={mode === 'recover' ? t.newPassword : t.password} hint={t.passwordHint}><input name="password" type="password" required minLength={12} maxLength={128} autoComplete={mode === 'register' || mode === 'recover' || mode === 'join' ? 'new-password' : 'current-password'}/></Field>
          {mode === 'register' && <Field label={t.farmName}><input name="farmName" required maxLength={100} placeholder="Lawfield Farm"/></Field>}
          {message && <p className="notice error" role="alert">{message}</p>}<button className="primary" disabled={busy}>{busy ? t.working : t.continue}<Icon name="chevron" size={18}/></button>
        </form><div className="auth-links">{(['join', 'recover', 'offlineUnlock'] as const).map(item => <button type="button" key={item} className="text-button" onClick={() => {setMode(item); setMessage('');}}>{t[item]}</button>)}</div>
      </section></main><footer className="auth-footer">{t.translationNote}</footer></div>;
}
