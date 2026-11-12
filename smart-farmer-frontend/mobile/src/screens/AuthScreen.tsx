import React, { useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Linking, Platform, ScrollView, Text, View } from 'react-native';
import * as ScreenCapture from 'expo-screen-capture';
import { openOnesa, redeemOnesa, type OnesaConfig } from '../onesa';
import { createApi } from '../api';
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
  const [onesa, setOnesa] = useState<OnesaConfig | null>(null);
  const onSessionRef = useRef(onSession);
  onSessionRef.current = onSession;
  useEffect(() => {
    let mounted = true;
    let returning = false;
    setOnesa(null);
    void createApi(origin).request<OnesaConfig | {enabled:false}>('/v1/onesa/config').then(config => {
      if (mounted && 'issuer' in config) setOnesa(config);
    }).catch(() => {});
    const handle = async (url: string | null | undefined) => {
      if (!mounted || !url?.startsWith('smartfarmer://onesa/callback?') || returning) return;
      returning = true;
      setBusy(true);
      try {const session = await redeemOnesa(url,origin); if (mounted && session) await onSessionRef.current(session);}
      catch (err) {if (mounted) setError(err);}
      finally {returning=false;if (mounted) setBusy(false);}
    };
    const listener = Linking.addEventListener('url', event => {void handle(event.url);});
    void Linking.getInitialURL().then(handle).catch(() => {});
    return () => {mounted=false;listener.remove();};
  }, [origin]);

  useEffect(() => {
    if (!receipt) return;
    void ScreenCapture.preventScreenCaptureAsync('recovery-code').catch(() => undefined);
    return () => { void ScreenCapture.allowScreenCaptureAsync('recovery-code').catch(() => undefined); };
  }, [receipt]);

  async function submit() {
    if (submitting.current) return;
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
      const session = { ...identity, origin };
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
    {onesa && !receipt && mode === 'signIn' && <Button title={t.onesaSignIn} secondary disabled={busy} onPress={() => {
      if (submitting.current) return;
      submitting.current=true; setBusy(true); setError(null);
      void openOnesa(origin,onesa,language).catch(setError).finally(() => {submitting.current=false;setBusy(false);});
    }}/>}
    {error ? <Notice text={errorText(language, error)} error /> : null}
    {receipt ? <Card title={t.recoveryCode}><Text style={styles.text}>{t.recoveryCreated}</Text><Text selectable style={[styles.heading, { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }]}>{receipt.code}</Text><Button testID="auth-continue" title={t.submit} busy={busy} onPress={() => { void submit(); }} /></Card> : <Card title={t[mode]}>
      <Choice label={t.choose} value={mode} onChange={value => { setMode(value); setError(null); setCode(''); setRecoveringUsername(''); }} closeLabel={t.close} options={(['signIn', 'register', 'join', 'recover'] as const).map(value => ({ value, label: t[value] }))} />
      <Field testID="auth-username" label={t.username} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" maxLength={80} />
      <Field testID="auth-password" label={t.password} hint={t.passwordHint} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} maxLength={128} />
      {mode === 'register' ? <Field label={t.farmName} value={farmName} onChangeText={setFarmName} maxLength={100} /> : null}
      {mode === 'join' || mode === 'recover' ? <Field label={mode === 'join' ? t.invitationCode : t.recoveryCode} value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} secureTextEntry /> : null}
      <Button testID="auth-submit" title={t.submit} busy={busy} onPress={() => { void submit(); }} />
    </Card>}<Text style={styles.caption}>{t.translations}</Text>
  </ScrollView></KeyboardAvoidingView>;
}
