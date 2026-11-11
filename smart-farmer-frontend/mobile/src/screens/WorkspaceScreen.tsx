import React, { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { errorText, label, textFor } from '../i18n';
import { LocalRepository } from '../repository';
import { traceSession } from '../session-transition';
import { formatFarmTime } from '../time';
import type { Language, Session } from '../types';
import { KeyboardDismissButton, Button, Choice, Notice, colors, styles } from '../ui';
import { useWorkspace } from '../use-workspace';
import { FarmScreen } from './FarmScreen';
import { MoreScreen } from './MoreScreen';
import { RecordScreen } from './RecordScreen';
import { TodayScreen } from './TodayScreen';
import { ForumScreen } from './ForumScreen';

export function WorkspaceScreen({ session, repository, language, onLanguage, onExpired, onLogout, onLock, nativeBusy, onNativePrompt }: { session: Session; repository: LocalRepository; language: Language; onLanguage: (value: Language) => void; onExpired: () => void; onLogout: () => void; onLock: () => void; nativeBusy: boolean; onNativePrompt: (value: boolean) => void }) {
  const [tab, setTab] = useState<'today' | 'farm' | 'record' | 'forum' | 'more'>('today');
  const insets = useSafeAreaInsets();
  const work = useWorkspace(session, repository, language, onExpired);
  const t = textFor(language);
  const pending = work.mutations.filter(item => item.state !== 'resolved').length;
  const stale = !work.online || !work.snapshot?.syncedAt || Date.now() - Date.parse(work.snapshot.syncedAt) > 15 * 60_000;
  useEffect(() => { traceSession(`tab_${tab}`, 'committed'); }, [tab]);

  return <KeyboardAvoidingView style={styles.page} behavior={Platform.OS === 'ios' ? 'padding' : 'height'} keyboardVerticalOffset={insets.top}>
    <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content} refreshControl={<RefreshControl refreshing={work.busy} onRefresh={() => { if (!nativeBusy) void work.refresh(); }} tintColor={colors.green} />}>
      <View style={styles.between}><View><Text style={styles.brand}>Smart Farmer</Text><Text style={styles.caption}>{session.username} · {label(language, work.selectedFarm?.role || '')}</Text></View><Choice testID="workspace-language" label={t.language} value={language} onChange={onLanguage} closeLabel={t.close} options={[{ value: 'sn', label: 'Shona' }, { value: 'nd', label: 'isiNdebele' }]} /></View>
      {work.farms.length > 1 ? <Choice label={t.farm} value={work.farmId} onChange={id => { if (!nativeBusy) void work.selectFarm(id).catch(work.setError); }} closeLabel={t.close} options={work.farms.map(farm => ({ value: farm.id, label: farm.name }))} /> : <Text style={styles.label}>{work.selectedFarm?.name || t.noFarm}</Text>}
      <View style={styles.between}><View style={[styles.pill, !work.online && styles.warning]}><Text style={styles.caption}>{work.online ? t.online : t.offline}{pending ? ` · ${pending} ${t.pending}` : ''}</Text></View><Button testID="workspace-sync" secondary title={t.sync} disabled={nativeBusy} busy={work.busy} onPress={() => { void work.sync(); }} /></View>
      {stale && work.snapshot ? <Text style={styles.caption}>{t.stale} · {t.lastSync}: {formatFarmTime(work.snapshot.syncedAt, work.snapshot.farm.timezone, language)}</Text> : null}
      {work.error ? <Notice error text={errorText(language, work.error)} /> : null}
      {work.notice ? <Notice text={label(language, work.notice)} /> : null}
      <React.Fragment key={`${work.farmId}:${work.selectedFarm?.role}`}>
      {tab === 'today' ? <TodayScreen work={work} language={language} onRecord={() => setTab('record')} /> : null}
      {tab === 'farm' ? <FarmScreen work={work} language={language} onNativePrompt={onNativePrompt} /> : null}
      {tab === 'record' ? <RecordScreen work={work} language={language} nativeBusy={nativeBusy} onNativePrompt={onNativePrompt} /> : null}
      {tab === 'forum' ? <ForumScreen work={work} language={language} nativeBusy={nativeBusy} /> : null}
      {tab === 'more' ? <MoreScreen work={work} language={language} onLogout={onLogout} onLock={onLock} onNativePrompt={onNativePrompt} /> : null}
      </React.Fragment>
    </ScrollView>
    <KeyboardDismissButton label={t.hideKeyboard} />
    <View style={{ flexDirection: 'row', borderTopWidth: 1, borderTopColor: colors.line, paddingVertical: 6, paddingHorizontal: 8, backgroundColor: colors.white }}>
      {/* These observers never claim a responder or retain the native event payload. */}
      {(['today', 'farm', 'record', 'forum', 'more'] as const).map(value => <Pressable key={value} testID={`tab-${value}`} disabled={nativeBusy} accessibilityRole="tab" accessibilityState={{ selected: tab === value, disabled: nativeBusy }} accessibilityLabel={t[value]}
        onTouchStart={value === 'farm' ? () => traceSession('farm_touch', 'start') : undefined}
        onTouchEnd={value === 'farm' ? () => traceSession('farm_touch', 'complete') : undefined}
        onTouchCancel={value === 'farm' ? () => traceSession('farm_touch', 'cancelled') : undefined}
        onPressIn={value === 'farm' ? () => traceSession('farm_press', 'start') : undefined}
        onPressOut={value === 'farm' ? () => traceSession('farm_press', 'complete') : undefined}
        onPress={() => { if (value === 'farm') traceSession('farm_press', 'received'); setTab(value); work.setNotice(''); work.setError(null); }}
        style={{ flex: 1, minHeight: 52, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 6, borderRadius: 12, backgroundColor: tab === value ? colors.pale : colors.white }}><Text style={[styles.label, { textAlign: 'center' }]}>{t[value]}</Text></Pressable>)}
    </View>
  </KeyboardAvoidingView>;
}
