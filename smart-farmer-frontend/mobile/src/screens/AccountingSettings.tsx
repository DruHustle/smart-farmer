import React, { useState } from 'react';
import { Text } from 'react-native';
import { calendarDate, toMinor, type Account, type SettingsResponse } from '../accounting';
import { c, Form, numericField, options, selectField, textField } from '../completion-ui';
import { rows, string } from '../product';
import type { Language } from '../types';
import type { Workspace } from '../use-workspace';
import { Card, Notice, styles } from '../ui';
import { accountingMutation, PendingAccountingActions } from './accounting-ui';

export function AccountingSettingsPanel({ work, language, data, accounts, onChanged }: { work: Workspace; language: Language; data: SettingsResponse; accounts: Account[]; onChanged: () => void }) {
  const settings = data.settings;
  const [generation, setGeneration] = useState(0);
  return <>
    <PendingAccountingActions work={work} language={language} currencies={data.currencies} paths={[{ suffix: '/settings', method: 'PUT', label: c(language, 'accountingSettings') }, { suffix: '/accounts', label: c(language, 'newAccount') }]} onResolved={() => { setGeneration(value => value + 1); onChanged(); }} />
    <Notice text={c(language, 'accountingSetupHint')} />
    <Form key={`settings:${settings?.version || 0}`} work={work} language={language} draftKey={`accounting-settings:${settings?.version || 0}`} title={c(language, 'accountingSettings')} fields={[
      textField('legalName', true, { maxLength: 160 }), textField('tradingName', false, { maxLength: 160 }), textField('address', false, { multiline: true, maxLength: 500 }), textField('email', false, { maxLength: 254 }), textField('phone', false, { maxLength: 50 }), textField('registrationNumber', false, { maxLength: 100 }), textField('taxNumber', false, { maxLength: 100 }),
      selectField('defaultCurrency', data.currencies.map(item => ({ value: item.code, label: item.code })), true), textField('invoicePrefix', true, { maxLength: 16 }), ...(!settings ? [numericField('startingNumber', true, { type: 'integer', minimum: 1, maximum: 999999999 })] : []),
      { key: 'taxRates', type: 'rows', fields: [textField('name', true, { maxLength: 80 }), textField('taxPercent', true, { maxLength: 6 })] },
      { key: 'lockedThrough', type: 'date', hint: c(language, 'lockedThroughHint') }, textField('reason', true, { maxLength: 1000 }),
    ]} initial={{ ...(settings?.business || {}), defaultCurrency: settings?.defaultCurrency || '', invoicePrefix: settings?.invoicePrefix || 'INV', startingNumber: 1, taxRates: (settings?.taxRates || []).map(rate => ({ name: rate.name, taxPercent: String(rate.rateBps / 100) })), lockedThrough: settings?.lockedThrough || '' }} submit={body => {
      const taxRates = rows(body.taxRates).map(rate => { const rateBps = Number(toMinor(string(rate.taxPercent), 2)); if (rateBps > 10000) throw new Error('invalid_amount'); return { name: rate.name, rateBps }; });
      return accountingMutation(work, '/settings', { version: settings?.version || 0, business: { legalName: body.legalName, tradingName: body.tradingName || '', address: body.address || '', email: body.email || '', phone: body.phone || '', registrationNumber: body.registrationNumber || '', taxNumber: body.taxNumber || '' }, defaultCurrency: body.defaultCurrency, invoicePrefix: body.invoicePrefix, ...(!settings ? { startingNumber: body.startingNumber } : {}), taxRates, lockedThrough: calendarDate(string(body.lockedThrough), false), reason: body.reason }, 'PUT');
    }} onSaved={onChanged} />
    <Card title={c(language, 'accounts')}>{accounts.map(account => <Text key={account.code} style={styles.text}>{account.code} · {account.name} · {c(language, account.type)}{account.active ? '' : ` · ${c(language, 'inactive')}`}</Text>)}</Card>
    <Form key={`account:${generation}`} work={work} language={language} title={c(language, 'newAccount')} fields={[textField('code', true, { maxLength: 20 }), textField('name', true, { maxLength: 120 }), selectField('type', options(language, ['asset', 'liability', 'equity', 'income', 'expense']), true)]} submit={body => accountingMutation(work, '/accounts', { code: body.code, name: body.name, type: body.type })} onSaved={onChanged} />
  </>;
}
