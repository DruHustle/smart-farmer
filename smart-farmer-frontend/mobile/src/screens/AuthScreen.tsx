import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { createApi } from '../api';
import { errorText, textFor } from '../i18n';
import type { Language, Session } from '../types';
import { KeyboardDismissButton, Button, Card, Choice, Field, Notice, styles } from '../ui';

export function AuthScreen({ origin, language, onLanguage, onSession }: { origin: string; language: Language; onLanguage: (language: Language) => void; onSession: (session: Session, recoveryCode?: string) => Promise<void> }) {
  const t = textFor(language);
  const [mode, setMode] = useState<'signIn' | 'register' | 'join' | 'recover'>('signIn');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [farmName, setFarmName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  async function submit() {
    if (!username.trim() || password.length < 12 || (mode === 'register' && !farmName.trim()) || ((mode === 'join' || mode === 'recover') && !code.trim())) { setError(new Error('required')); return; }
    setBusy(true); setError(null);
    try {
      const api = createApi(origin);
      let recoveryCode: string | undefined;
      if (mode === 'register') {
        const result = await api.request<{ recoveryCode: string }>('/v1/register', 'POST', { username: username.trim(), password, farmName: farmName.trim(), language });
        recoveryCode = result.recoveryCode;
      }
      if (mode === 'join') {
        const result = await api.request<{ recoveryCode?: string }>('/v1/invitations/accept', 'POST', { token: code.trim(), username: username.trim(), password, language });
        recoveryCode = result.recoveryCode;
      }
      if (mode === 'recover') await api.request('/v1/recover', 'POST', { username: username.trim(), recoveryCode: code.trim(), password });
      const session = await api.request<Omit<Session, 'origin'>>('/v1/sessions', 'POST', { username: username.trim(), password, deviceName: `Smart Farmer · ${Platform.OS}` });
      if (mode === 'recover') {
        const renewed = await createApi(origin, session.token).request<{ recoveryCode: string }>('/v1/recovery-codes', 'POST', { password });
        recoveryCode = renewed.recoveryCode;
      }
      setPassword(''); setCode('');
      await onSession({ ...session, origin }, recoveryCode);
    } catch (value) { setError(value); } finally { setBusy(false); }
  }

  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : undefined}><ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.content, { maxWidth: 580, paddingTop: 28 }]}>
    <View style={styles.between}><Text style={styles.brand}>Smart Farmer</Text><Choice label={t.language} value={language} onChange={onLanguage} closeLabel={t.close} options={[{ value: 'sn', label: 'Shona' }, { value: 'nd', label: 'isiNdebele' }]} /></View>
    <Text style={styles.title} accessibilityRole="header">{t.welcome}</Text><Text style={styles.muted}>{t.intro}</Text>
    {error ? <Notice text={errorText(language, error)} error /> : null}
    <Card title={t[mode]}>
      <Choice label={t.choose} value={mode} onChange={value => { setMode(value); setError(null); setCode(''); }} closeLabel={t.close} options={(['signIn', 'register', 'join', 'recover'] as const).map(value => ({ value, label: t[value] }))} />
      <Field testID="auth-username" label={t.username} value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} autoComplete="username" maxLength={80} />
      <Field testID="auth-password" label={t.password} hint={t.passwordHint} value={password} onChangeText={setPassword} secureTextEntry autoCapitalize="none" autoCorrect={false} autoComplete={mode === 'signIn' ? 'current-password' : 'new-password'} maxLength={128} />
      {mode === 'register' ? <Field label={t.farmName} value={farmName} onChangeText={setFarmName} maxLength={100} /> : null}
      {mode === 'join' || mode === 'recover' ? <Field label={mode === 'join' ? t.invitationCode : t.recoveryCode} value={code} onChangeText={setCode} autoCapitalize="none" autoCorrect={false} secureTextEntry /> : null}
      <Button testID="auth-submit" title={t.submit} busy={busy} onPress={() => { void submit(); }} />
    </Card><Text style={styles.caption}>{t.translations}</Text>
  </ScrollView><KeyboardDismissButton label={t.hideKeyboard} /></KeyboardAvoidingView>;
}
