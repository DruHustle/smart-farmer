import React, {useEffect, useRef, useState} from 'react';
import * as Crypto from 'expo-crypto';
import {textFor} from '../i18n';
import type {Language} from '../types';
import {Button, Card, Field} from '../ui';
import type {Workspace} from '../use-workspace';

type Draft = {id: string; name: string};
const key = 'createFirstFarm';

export function CreateFirstFarm({work, language}: {work: Workspace; language: Language}) {
  const t = textFor(language);
  const [name, setName] = useState('');
  const [pending, setPending] = useState<Draft | null>(null);
  const [ready, setReady] = useState(false);
  const submitting = useRef(false);
  useEffect(() => {
    let active = true;
    work.repository.preference<Draft>(key).then(draft => {
      if (active) { setPending(draft); setName(draft?.name || ''); setReady(true); }
    }).catch(work.setError);
    return () => { active = false; };
  }, [work.repository, work.setError]);

  async function create() {
    if (!ready || !name.trim() || submitting.current) return;
    submitting.current = true;
    try {
      const success = await work.onlineAction(async () => {
        const draft = pending ?? {id: Crypto.randomUUID(), name: name.trim()};
        // Persist before the request so a lost response or process restart reuses the same operation.
        await work.repository.setPreference(key, draft);
        setPending(draft);
        await work.api.request('/v1/farms', 'POST', draft);
        await work.repository.setPreference(key, null);
      });
      if (success) await work.refresh();
    } finally { submitting.current = false; }
  }

  return <Card title={t.register}>
    <Field testID="first-farm-name" label={t.farmName} value={name} maxLength={100} onChangeText={setName} editable={ready && !pending && !work.busy}/>
    <Button testID="first-farm-create" title={pending ? t.retry : t.register} disabled={!work.online || !ready || !name.trim()} busy={work.busy} onPress={() => { void create(); }}/>
  </Card>;
}
