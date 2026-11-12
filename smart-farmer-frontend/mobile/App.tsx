import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, AppState, Platform, ScrollView, StatusBar, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import * as ScreenCapture from 'expo-screen-capture';
import { apiOrigin, createApi } from './src/api';
import { errorText, textFor } from './src/i18n';
import { deviceUnlock, forgetSession, openRepository, readLanguage, readSession, saveLanguage, saveSession } from './src/native-storage';
import { clearReminders, endDeviceNotifications } from './src/reminders';
import { clearLocalSession, createSessionGate, traceSession } from './src/session-transition';
import { LocalRepository } from './src/repository';
import type { Language, Session } from './src/types';
import { AuthScreen } from './src/screens/AuthScreen';
import { WorkspaceScreen } from './src/screens/WorkspaceScreen';
import { Button, Choice, Notice, Sheet, colors, styles } from './src/ui';

function observeSignOutPhase(phase: 'entry' | 'session-delete-completed' | 'notification-cleanup-completed' | 'notification-cleanup-failed' | 'local-auth-state-requested'): void {
  try { if (__DEV__) console.info('[native-signout]', phase); } catch { /* Diagnostics must not alter sign-out behavior. */ }
}

function Root() {
  const [language, setLanguage] = useState<Language>('sn');
  const [session, setSession] = useState<Session | null>(null);
  const [repository, setRepository] = useState<LocalRepository | null>(null);
  const [locked, setLocked] = useState(true);
  const [expired, setExpired] = useState(false);
  const [starting, setStarting] = useState(true);
  const [busy, setBusy] = useState(false);
  const [sessionGate] = useState(() => createSessionGate(setBusy, traceSession));
  const [error, setError] = useState<unknown>(null);
  const [nativePrompt, setNativePrompt] = useState(false);
  const nativePromptRef = useRef(false);
  const repositories = useRef(new Map<string, LocalRepository>());
  const t = textFor(language);
  let origin = '';
  let configurationError: unknown = null;
  try { origin = apiOrigin(process.env.EXPO_PUBLIC_API_URL, __DEV__); } catch (value) { configurationError = value; }

  const expire = useCallback(() => { setExpired(true); setLocked(true); }, []);

  async function getRepository(value: Session) {
    const key = `${value.origin}\n${value.userId}`;
    let local = repositories.current.get(key);
    if (!local) { local = await openRepository(value); repositories.current.set(key, local); }
    return local;
  }

  useEffect(() => {
    void (async () => {
      setLanguage(await readLanguage());
      if (origin) {
        const previous = await readSession(origin);
        if (previous) { setSession(previous); setExpired(Date.parse(previous.expiresAt) <= Date.now()); }
      }
    })().catch(setError).finally(() => setStarting(false));
    if (Platform.OS === 'ios') void ScreenCapture.enableAppSwitcherProtectionAsync(1).catch(() => undefined);
    // The camera/voice-note flow never writes private files to the public photo library.
  }, []);

  useEffect(() => {
    if (!session) sessionGate.authScreenCommitted();
  }, [session, sessionGate]);

  useEffect(() => {
    if (session) void ScreenCapture.preventScreenCaptureAsync('private-farm').catch(() => undefined);
    else void ScreenCapture.allowScreenCaptureAsync('private-farm').catch(() => undefined);
  }, [Boolean(session)]);

  useEffect(() => {
    let backgroundAt: number | null = null;
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background' && !nativePromptRef.current) backgroundAt = Date.now();
      if (state === 'active') {
        if (session && backgroundAt && Date.now() - backgroundAt >= 30_000) setLocked(true);
        backgroundAt = null;
        if (session && Date.parse(session.expiresAt) <= Date.now()) expire();
      }
    });
    const timer = setInterval(() => { if (session && Date.parse(session.expiresAt) <= Date.now()) expire(); }, 30_000);
    return () => { subscription.remove(); clearInterval(timer); };
  }, [session?.token, expire]);

  function changeLanguage(value: Language) {
    setLanguage(value);
    void saveLanguage(value).catch(setError);
    if (session) { const next = { ...session, language: value }; setSession(next); void saveSession(next).catch(setError); }
  }

  async function authenticated(value: Session) {
    const local = await getRepository(value);
    await saveLanguage(value.language); await saveSession(value);
    setSession(value); setRepository(local); setLanguage(value.language); setExpired(false); setLocked(false); setError(null);
  }

  async function unlock() {
    if (!session || expired) return;
    try {
      await sessionGate.run('unlock', async () => {
        setError(null);
        if (await deviceUnlock(t.unlock, t.cancel)) {
          setRepository(await getRepository(session));
          setLocked(false);
        }
      });
    } catch (value) { setError(value); }
  }

  async function signOut() {
    await sessionGate.run('sign_out', async () => {
      observeSignOutPhase('entry');
      const previous = session;
      setLocked(true);
      await clearLocalSession({
        async forgetSession() {
          await forgetSession();
          observeSignOutPhase('session-delete-completed');
        },
        async clearNotifications() {
          try {
            if (previous) await endDeviceNotifications(previous);
            else await clearReminders();
            observeSignOutPhase('notification-cleanup-completed');
          } catch (error) {
            observeSignOutPhase('notification-cleanup-failed');
            throw error;
          }
        },
        clearState() {
          setSession(null);
          setRepository(null);
          setLocked(true);
          setExpired(false);
          setError(null);
          observeSignOutPhase('local-auth-state-requested');
        },
      }, traceSession);
      if (previous) {
        // Revoke on the server when connected after local access has ended.
        void createApi(previous.origin, previous.token).request('/v1/sessions/current', 'DELETE').catch(() => undefined);
      }
    });
  }

  function requestSignOut() {
    Alert.alert(t.logout, t.switchAccountHint, [{ text: t.cancel, style: 'cancel' }, { text: t.logout, onPress: () => { void signOut().catch(setError); } }]);
  }

  function nativeBusy(value: boolean) { nativePromptRef.current = value; setNativePrompt(value); }

  if (starting) return <View style={[styles.content, { paddingTop: 32 }]}><Text style={styles.brand}>Smart Farmer</Text><Text style={styles.text}>{t.loading}</Text></View>;
  if (configurationError) return <ScrollView contentContainerStyle={styles.content}><Text style={styles.brand}>Smart Farmer</Text><Choice label={t.language} closeLabel={t.close} value={language} onChange={changeLanguage} options={[{ value: 'sn', label: 'Shona' }, { value: 'nd', label: 'isiNdebele' }]} /><Notice text={errorText(language, configurationError)} error /></ScrollView>;
  if (!session) return <AuthScreen origin={origin} language={language} onLanguage={changeLanguage} onSession={authenticated} />;
  return <View style={styles.page}>
    {repository && !locked ? <WorkspaceScreen key={`${session.origin}:${session.userId}`} session={session} repository={repository} language={language} onLanguage={changeLanguage} onExpired={expire} onLogout={requestSignOut} onLock={() => setLocked(true)} nativeBusy={nativePrompt} onNativePrompt={nativeBusy} /> : <View style={styles.content}><Text style={styles.brand}>Smart Farmer</Text></View>}
    <Sheet title={t.locked} visible={locked} dismissible={false} onClose={() => undefined} closeLabel={t.locked}>
      <Text style={styles.heading}>{session.username}</Text><Text style={styles.text}>{expired ? t.sessionExpired : t.unlockHint}</Text>
      {error ? <Notice text={errorText(language, error)} error /> : null}
      {!expired ? <Button testID="device-unlock" title={t.unlock} busy={busy} onPress={() => { void unlock(); }} /> : null}
      <Button testID="device-reauthenticate" secondary title={t.reauthenticate} busy={busy} onPress={() => { void signOut().catch(setError); }} />
      <Text style={styles.caption}>{t.localPrivacy}</Text>
    </Sheet>
  </View>;
}

export default function App() {
  return <SafeAreaProvider><SafeAreaView style={{ flex: 1, backgroundColor: colors.paper }}><StatusBar barStyle="dark-content" /><Root /></SafeAreaView></SafeAreaProvider>;
}
