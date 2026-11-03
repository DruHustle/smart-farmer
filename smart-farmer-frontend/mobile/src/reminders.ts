import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import type { Language, Task } from './types';
import { textFor } from './i18n';

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

export async function clearReminders(): Promise<void> { await Notifications.cancelAllScheduledNotificationsAsync(); }
