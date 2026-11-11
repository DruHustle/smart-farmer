import React, {useEffect, useState} from 'react';
import {Text} from 'react-native';
import {ApiError} from '../api';
import {errorText, textFor} from '../i18n';
import type {Language} from '../types';
import {Button, Notice, Sheet, styles} from '../ui';
import type {Workspace} from '../use-workspace';

const path = '/v1/me/deletion-request';
type Request = { id: string; status: 'pending' | 'in_review'; requestedAt: string };

export function AccountDeletion({work, language}: {work: Workspace; language: Language}) {
  const t = textFor(language);
  const [visible, setVisible] = useState(false);
  const [request, setRequest] = useState<Request | null | undefined>();
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    setRequest(undefined); setError(undefined);
    work.api.request<{request: Request | null}>(path).then(result => {
      if (active) setRequest(result.request);
    }).catch(reason => {
      if (active) {
        setError(reason);
        if (reason instanceof ApiError && reason.status === 401) work.setError(reason);
      }
    });
    return () => { active = false; };
  }, [visible, reload, work.api, work.setError]);

  async function change() {
    if (busy || request === undefined) return;
    setBusy(true); setError(undefined);
    try {
      if (request === null) {
        const result = await work.api.request<{request: Request}>(path, 'POST', {confirm: true});
        setRequest(result.request);
      } else if (request.status === 'pending') {
        await work.api.request(path, 'DELETE');
        setRequest(null);
      }
    } catch (reason) {
      setError(reason);
      if (reason instanceof ApiError && reason.status === 401) work.setError(reason);
      if (reason instanceof ApiError && reason.code === 'request_in_review') setReload(value => value + 1);
    } finally { setBusy(false); }
  }

  return <><Button testID="account-deletion" secondary title={t.deleteAccount} onPress={() => setVisible(true)}/>
    <Sheet visible={visible} closeLabel={t.close} title={t.deleteAccount} dismissible={!busy} onClose={() => setVisible(false)}>
      <Text style={styles.text}>{t.deletionDetail}</Text>
      {error ? <Notice error text={errorText(language, error)}/> : null}
      {request === undefined ? (error ? <Button secondary title={t.retry} onPress={() => setReload(value => value + 1)}/> : <Text style={styles.muted}>{t.loading}</Text>) : null}
      {request ? <Notice text={request.status === 'pending' ? t.deletionPending : t.deletionReview}/> : null}
      {request === null || request?.status === 'pending' ? <Button testID="account-deletion-confirm" busy={busy} danger={request === null}
        title={request ? t.withdrawDeletion : t.deletionConfirm} onPress={() => { void change(); }}/> : null}
    </Sheet>
  </>;
}
