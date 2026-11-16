import React, {useState} from 'react';
import {Linking} from 'react-native';
import {Button, Notice} from './ui';
import {textFor} from './i18n';
import type {Language} from './types';
import {privacyPolicyUrl, communityPolicyUrl} from './policies';

export function PolicyLink({language, community = false}: {language: Language; community?: boolean}) {
  const t = textFor(language);
  const [failed, setFailed] = useState(false);
  const url = community ? communityPolicyUrl : privacyPolicyUrl;
  if (!url) return null;
  return <><Button secondary title={community ? t.communityRules : t.privacyPolicy} onPress={() => {
    setFailed(false);
    void Linking.openURL(url).catch(() => setFailed(true));
  }}/>
    {failed ? <Notice error text={t.network_error}/> : null}
  </>;
}
