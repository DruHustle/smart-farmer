import React, { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View, type TextInputProps } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const colors = { ink: '#17382C', green: '#1D654B', pale: '#E8F1EA', paper: '#F7F8F3', white: '#FFFFFF', muted: '#55675E', line: '#D1DED3', orange: '#8C4B0D', red: '#9B302A', blue: '#245E7B' };
export const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  content: { width: '100%', maxWidth: 1100, alignSelf: 'center', padding: 16, gap: 14, paddingBottom: 28 },
  row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  between: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', gap: 10 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: 14 },
  card: { padding: 16, backgroundColor: colors.white, borderColor: colors.line, borderWidth: 1, borderRadius: 18, gap: 12 },
  title: { fontSize: 26, lineHeight: 34, fontWeight: '700', color: colors.ink },
  heading: { fontSize: 20, fontWeight: '700', color: colors.ink, lineHeight: 28 },
  text: { color: colors.ink, fontSize: 16, lineHeight: 23 },
  muted: { color: colors.muted, fontSize: 14, lineHeight: 21 },
  label: { color: colors.ink, fontSize: 14, fontWeight: '600', lineHeight: 21 },
  caption: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  input: { minHeight: 48, borderColor: colors.line, borderWidth: 1, backgroundColor: colors.white, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, fontSize: 16, color: colors.ink },
  button: { minHeight: 48, paddingHorizontal: 16, paddingVertical: 12, backgroundColor: colors.green, borderRadius: 12, justifyContent: 'center', alignItems: 'center' },
  secondary: { backgroundColor: colors.pale, borderWidth: 1, borderColor: colors.line },
  danger: { backgroundColor: '#FCEAE7' },
  disabled: { opacity: 0.45 },
  buttonText: { color: colors.white, fontSize: 15, fontWeight: '700', lineHeight: 22, textAlign: 'center' },
  secondaryText: { color: colors.ink },
  item: { paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line, gap: 5 },
  pill: { borderRadius: 999, backgroundColor: colors.pale, paddingHorizontal: 10, paddingVertical: 5, alignSelf: 'flex-start' },
  warning: { backgroundColor: '#FFF0DC' },
  error: { borderWidth: 1, borderColor: '#E7B3A7', backgroundColor: '#FCEAE7', borderRadius: 12, padding: 12 },
  modalBackdrop: { flex: 1, backgroundColor: '#0B271B99', justifyContent: 'center', padding: 12 },
  modal: { width: '100%', maxWidth: 740, maxHeight: '94%', alignSelf: 'center', backgroundColor: colors.paper, borderRadius: 20, overflow: 'hidden' },
  modalHeader: { padding: 16, borderBottomWidth: 1, borderColor: colors.line, gap: 12 },
  brand: { color: colors.green, fontWeight: '800', fontSize: 20, letterSpacing: -0.5 },
});

export function Button({ title, onPress, secondary = false, danger = false, disabled = false, busy = false, testID }: { title: string; onPress: () => void; secondary?: boolean; danger?: boolean; disabled?: boolean; busy?: boolean; testID?: string }) {
  return <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title} accessibilityState={{ disabled: disabled || busy, busy }} disabled={disabled || busy} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, danger && styles.danger, (disabled || busy) && styles.disabled, pressed && { opacity: 0.75 }]}>
    {busy ? <ActivityIndicator color={secondary ? colors.green : colors.white} /> : <Text style={[styles.buttonText, (secondary || danger) && styles.secondaryText]}>{title}</Text>}
  </Pressable>;
}

// Keep this outside the scrollable form so multiline inputs and numeric keyboards
// always have an accessible dismissal action, even on a short viewport.
export function KeyboardDismissButton({ label }: { label: string }) {
  const [visible, setVisible] = useState(() => Keyboard.isVisible());
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setVisible(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setVisible(false));
    setVisible(Keyboard.isVisible());
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  if (!visible) return null;
  return <View style={{ paddingHorizontal: 16, paddingVertical: 6, backgroundColor: colors.paper }}>
    <Button testID="keyboard-dismiss" title={label} secondary onPress={() => Keyboard.dismiss()} />
  </View>;
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  return <View style={{ gap: 6 }}><Text testID={props.testID ? `${props.testID}-label` : undefined} style={styles.label}>{label}</Text><TextInput accessibilityLabel={label} accessibilityHint={hint} placeholderTextColor={colors.muted} style={[styles.input, props.multiline && { minHeight: 92, textAlignVertical: 'top' }]} {...props} />{hint ? <Text style={styles.caption}>{hint}</Text> : null}</View>;
}

export function Toggle({ label, hint, value, onChange, disabled, testID }: { label: string; hint?: string; value: boolean; onChange: (value: boolean) => void; disabled?:boolean; testID?:string }) {
  return <View style={styles.between}><View style={{ flex: 1, minWidth: 160 }}><Text style={styles.label}>{label}</Text>{hint ? <Text style={styles.caption}>{hint}</Text> : null}</View><Switch testID={testID} disabled={disabled} accessibilityLabel={label} value={value} onValueChange={onChange} trackColor={{ false: '#A4B5A7', true: colors.green }} /></View>;
}

export function Card({ title, children, style }: { title?: string; children: ReactNode; style?: object }) {
  return <View style={[styles.card, style]}>{title ? <Text style={styles.heading} accessibilityRole="header">{title}</Text> : null}{children}</View>;
}

export function Notice({ text, error = false }: { text: string; error?: boolean }) {
  return <View style={error ? styles.error : [styles.card, styles.warning]} accessibilityRole={error ? 'alert' : 'text'} accessibilityLiveRegion="polite"><Text style={styles.text}>{text}</Text></View>;
}

export function Sheet({ title, visible, onClose, onDismiss, closeLabel, closeTestID = 'sheet-close', keyboardDismissLabel, children, dismissible = true }: { title: string; visible: boolean; onClose: () => void; onDismiss?: () => void; closeLabel: string; closeTestID?: string; keyboardDismissLabel?: string; children: ReactNode; dismissible?: boolean }) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} onDismiss={onDismiss} presentationStyle="overFullScreen">
    <SafeAreaView style={styles.modalBackdrop}><KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.modal}>
      <View style={[styles.between, styles.modalHeader]}><Text style={[styles.heading, { flex: 1 }]} accessibilityRole="header">{title}</Text>{dismissible ? <Button testID={closeTestID} title={closeLabel} onPress={onClose} secondary /> : null}</View>
      {visible && keyboardDismissLabel ? <KeyboardDismissButton label={keyboardDismissLabel} /> : null}
      <ScrollView keyboardDismissMode="on-drag" keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, gap: 14 }}>{children}</ScrollView>
    </KeyboardAvoidingView></SafeAreaView>
  </Modal>;
}

export function Choice<T extends string>({ label, value, options, onChange, closeLabel, testID, disabled }: { label: string; value: T; options: { value: T; label: string; disabled?: boolean }[]; onChange: (value: T) => void; closeLabel: string; testID?: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  return <View style={{ gap: 6 }}><Text style={styles.label}>{label}</Text>
    <Button testID={testID} secondary disabled={disabled} title={selected?.label || label} onPress={() => setOpen(true)} />
    <Sheet title={label} visible={open} onClose={() => setOpen(false)} closeLabel={closeLabel}>
      {options.map(option => <Pressable key={option.value} testID={testID ? `${testID}-option-${option.value}` : undefined} accessibilityRole="radio" disabled={disabled || option.disabled} accessibilityState={{ selected: option.value === value, disabled: Boolean(disabled || option.disabled) }} accessibilityLabel={option.label} onPress={() => { onChange(option.value); setOpen(false); }} style={[styles.item, (disabled || option.disabled) && styles.disabled, { minHeight: 48, justifyContent: 'center' }]}><Text style={styles.text}>{option.value === value ? '✓ ' : ''}{option.label}</Text></Pressable>)}
    </Sheet>
  </View>;
}
