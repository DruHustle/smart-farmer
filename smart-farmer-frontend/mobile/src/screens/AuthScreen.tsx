import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, Text, View } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { openOnesa, redeemOnesa, type OnesaConfig } from '../onesa';
import { PolicyLink } from '../PolicyLink';
import { createApi, isLocalApiHost } from '../api';
import { errorText, textFor } from '../i18n';
import type { Language, Session } from '../types';
import { Button, Card, Choice, Field, Notice, styles } from '../ui';

export function AuthScreen({ origin, language, onLanguage, onSession }: { origin: string; language: Language; onLanguage: (language: Language) => void; onSession: (session: Session) => Promise<void> }) {
  const t = textFor(language);
  const [mode, setMode] = useState<'signIn' | 'register' | 'join' | 'recover'>('signIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [farmName, setFarmName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [receipt, setReceipt] = useState<{ code: string; session?: Session } | null>(null);
  const [recoveringUsername, setRecoveringUsername] = useState('');
  const submitting = useRef(false);
  const [portal, setPortal] = useState<{origin: string; config: OnesaConfig} | null>(null);
  const onesa = portal?.origin === origin ? portal.config : null;
  const [localOrigin, setLocalOrigin] = useState<string | null>(null);
  const allowLocal = localOrigin === origin;
  const [configFailed, setConfigFailed] = useState(false);
  const [configAttempt, setConfigAttempt] = useState(0);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  useEffect(() => {
    let mounted = true;
    let returning = false;
    setPortal(null); setLocalOrigin(null); setConfigFailed(false);
    void createApi(origin).request<(OnesaConfig | {enabled:false}) & {local_credentials?:boolean}>('/v1/onesa/config').then(config => {
      if (!mounted) return;
      const local = __DEV__ && config.local_credentials === true && isLocalApiHost(new URL(origin).hostname);
      if (local) setLocalOrigin(origin);
      if ('issuer' in config && typeof config.issuer === 'string' && config.clientId && config.callback) {
        setPortal({origin, config});
      } else if (!local) setConfigFailed(true);
    }).catch(() => { if (mounted) setConfigFailed(true); });
    const handle = async (url: string | null | undefined) => {
      if (!mounted || !url?.startsWith('smartfarmer://onesa/callback?') || returning) return;
      returning = true;
      setBusy(true);
      try {const session = await redeemOnesa(url,origin); if (mounted && session) await onSessionRef.current(session);}
      catch (err) {if (mounted) setError(err);}
      finally {returning=false;if (mounted) setBusy(false);}
    };
    // The system authentication session handles live redirects. Recover a callback after process death.
    void Linking.getInitialURL().then(handle).catch(() => {});
    return () => {mounted=false;};
  }, [origin, configAttempt]);

  useEffect(() => {
    if (!receipt) return;
    void ScreenCapture.preventScreenCaptureAsync('recovery-code').catch(() => undefined);
    return () => { void ScreenCapture.allowScreenCaptureAsync('recovery-code').catch(() => undefined); };
  }, [receipt]);

  async function submit() {
    if (!allowLocal || submitting.current) return;
    if (!receipt && (!username.trim() || password.length < 12 || (mode === 'register' && !farmName.trim()) || ((mode === 'join' || mode === 'recover') && !code.trim()))) { setError(new Error('required')); return; }
    submitting.current = true;
    setBusy(true); setError(null);
    try {
      const api = createApi(origin);
      if (receipt?.session) { await onSession(receipt.session); return; }
      if (!receipt && (mode === 'register' || mode === 'join')) {
        const account = mode === 'register'
          ? await api.request<{ recoveryCode: string }>('/v1/register', 'POST', { username: username.trim(), password, farmName: farmName.trim(), language })
          : await api.request<{ recoveryCode: string }>('/v1/invitations/accept', 'POST', { token: code.trim(), username: username.trim(), password, language });
        // The account exists now. Show the single-use credential even if the next request fails.
        setUsername(username.trim()); setPassword(password); setMode('signIn'); setRecoveringUsername('');
        setReceipt({ code: account.recoveryCode }); setCode('');
        return;
      }
      if (mode === 'recover') {
        await api.request('/v1/recover', 'POST', { username: username.trim(), recoveryCode: code.trim(), password });
        setMode('signIn'); setRecoveringUsername(username.trim().toLowerCase()); setCode('');
      }
      const identity = await api.request<Omit<Session, 'origin'>>('/v1/sessions', 'POST', { username: username.trim(), password, deviceName: `Smart Farmer · ${Platform.OS}` });
      const session: Session = { ...identity, origin, localFixture: true };
      if (mode === 'recover' || recoveringUsername === identity.username) {
        const renewed = await createApi(origin, session.token).request<{ recoveryCode: string }>('/v1/recovery-codes', 'POST', { password });
        setReceipt({ code: renewed.recoveryCode, session }); setRecoveringUsername(''); setPassword('');
        return;
      }
      await onSession(session);
    } catch (value) { setError(value); } finally { submitting.current = false; setBusy(false); }
  }

  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { maxWidth: 580, paddingTop: 28 }]}>
    <View style={styles.between}><Text style={styles.brand}>Smart Farmer</Text><Choice label={t.language} value={language} onChange={onLanguage} closeLabel={t.close} options={[{ value: 'sn', label: 'Shona' }, { value: 'nd', label: 'isiNdebele' }]} /></View>
    <Text style={styles.title} accessibilityRole="header">{t.welcome}</Text><Text style={styles.muted}>{t.intro}</Text>
    {!configFailed && !onesa && !allowLocal && <Text style={styles.muted} accessibilityRole="text">{t.loading}</Text>}
    {configFailed && <Card>
      <Notice error text={t.onesa_unavailable}/>
      <Button secondary title={t.retry} onPress={() => setConfigAttempt(value => value + 1)}/>
      <Button secondary title={t.onesaAccount} onPress={() => {
        void Linking.openURL('https://portal.onesa.eu/account').catch(setError);
      }}/>
    </Card>}
    {onesa && <Button testID="auth-onesa" title={t.onesaSignIn} disabled={busy} onPress={() => {
      if (submitting.current) return;
      submitting.current=true; setBusy(true); setError(null);
      void openOnesa(origin,onesa,language).then(async session => { if (session) await onSessionRef.current(session); }).catch(setError).finally(() => {submitting.current=false;setBusy(false);});
    }}/>}
    {error ? <Notice text={errorText(language, error)} error /> : null}
    {allowLocal && (receipt ? <Card title={t.recoveryCode}><Text style={styles.text}>{t.recoveryCreated}</Text><Text selectable style={[styles.heading, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{receipt.code}</Text><Button testID="auth-continue" title={t.submit} busy={busy} onPress={() => { void submit(); }} /></Card> : <Card title={t[mode]}>
      <Choice label={t.choose} value={mode} onChange={value => { setMode(value); setError(null); setCode(''); setRecoveringUsername(''); }} closeLabel={t.close} options={(['signIn', 'register', 'join', 'recover'] as const).map(value => ({ value, label: t[value] }))} />
      <Field testID="auth-username" label={t.username} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" maxLength={80} />
      <Field testID="auth-password" label={t.password} hint={t.passwordHint} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} maxLength={128} />
      {mode === 'register' ? <Field label={t.farmName} value={farmName} onChangeText={setFarmName} maxLength={100} /> : null}
      {mode === 'join' || mode === 'recover' ? <Field label={mode === 'join' ? t.invitationCode : t.recoveryCode} value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} secureTextEntry /> : null}
      <Button testID="auth-submit" title={t.submit} busy={busy} onPress={() => { void submit(); }} />
    </Card>)}<Text style={styles.caption}>{t.translations}</Text><PolicyLink language={language}/>
  </ScrollView></KeyboardAvoidingView>;
}
