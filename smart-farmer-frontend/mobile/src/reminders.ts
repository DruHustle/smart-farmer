import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import type { Language, Session, Task } from './types';
import { textFor } from './i18n';
import { createApi } from './api';
import { sessionStep, type SessionTrace } from './session-transition';

export async function enableReminders(): Promise<void> {
  if (Platform.OS === 'android') await Notifications.setNotificationChannelAsync('farm-tasks', { name: 'Smart Farmer', importance: Notifications.AndroidImportance.DEFAULT, lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE });
  const permission = await Notifications.requestPermissionsAsync();
  if (!permission.granted) throw new Error('permissionDenied');
}

export async function scheduleTaskReminders(tasks: Task[], language: Language): Promise<void> {
  // Single active account. Cancelling on every refresh prevents old versions and duplicate reminders.
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const task of tasks) {
    if (!task.due_at || ['completed', 'cancelled'].includes(task.status)) continue;
    const due = new Date(task.due_at);
    if (due.valueOf() <= Date.now() || due.valueOf() > Date.now() + 14 * 86_400_000) continue;
    await Notifications.scheduleNotificationAsync({
      identifier: `task-${task.id}-${task.version}`,
      content: { title: 'Smart Farmer', body: textFor(language).taskReminder, data: { taskId: task.id } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: due, channelId: 'farm-tasks' },
    });
  }
}

export async function clearReminders(trace?: SessionTrace): Promise<void> {
  await sessionStep('notification_cancel', () => Notifications.cancelAllScheduledNotificationsAsync(), trace);
  await sessionStep('notification_dismiss', () => Notifications.dismissAllNotificationsAsync(), trace);
}

const PUSH_CHANNELS_KEY = 'smart-farmer.active-push-channels.v1';
type Channel = { origin: string; userId: string; farmId: string; id: string };
async function storedChannels(trace?: SessionTrace): Promise<Channel[]> {
  try { return await sessionStep('channels_read', async () => { const value = JSON.parse(await SecureStore.getItemAsync(PUSH_CHANNELS_KEY) || '[]'); return Array.isArray(value) ? value : []; }, trace); }
  catch { trace?.('channels_read', 'fallback'); return []; }
}
export async function rememberPushChannel(session: Session, farmId: string, id: string): Promise<void> {
  const channels = (await storedChannels()).filter(item => item.id !== id);
  channels.push({ origin: session.origin, userId: session.userId, farmId, id });
  await SecureStore.setItemAsync(PUSH_CHANNELS_KEY, JSON.stringify(channels), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
}
export async function endDeviceNotifications(session: Session, trace?: SessionTrace): Promise<void> {
  // Native unregister invalidates this device's delivery registration even when the API is unreachable.
  await Promise.allSettled([sessionStep('notification_unregister', () => Notifications.unregisterForNotificationsAsync(), trace), clearReminders(trace)]);
  const channels = await storedChannels(trace); const owned = channels.filter(item => item.origin === session.origin && item.userId === session.userId);
  await sessionStep('channels_write', () => SecureStore.setItemAsync(PUSH_CHANNELS_KEY, JSON.stringify(channels.filter(item => !owned.includes(item))), { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }), trace);
  const api = createApi(session.origin, session.token);
  void Promise.allSettled(owned.map(item => api.request(`/v1/farms/${item.farmId}/notification-channels/${item.id}`, 'DELETE')));
}
