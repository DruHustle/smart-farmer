import {useState} from 'react';
import {useFarm} from '../../context';
import {percentageToBps} from '../../lib/accounting';
import {useResource} from '../../lib/resources';
import {ResourceState} from '../../components/completion';
import {ExpandForm, Field, Section, formValue} from '../../components/ui';
import {AccountingForm} from './AccountingForm';
import {accountName} from './accountNames';
import type {AccountingAccount, AccountingSettings, SettingsResponse} from './types';

export function AccountingSetup({settings, currencies, reload}: {settings: AccountingSettings | null; currencies: SettingsResponse['currencies']; reload: () => Promise<void>}) {
  const {farm, t} = useFarm();
  const base = `/v1/farms/${farm.id}/accounting`;
  const [rates, setRates] = useState(() => (settings?.taxRates ?? []).map(rate => ({id: crypto.randomUUID(), name: rate.name, percentage: (rate.rateBps / 100).toString()})));
  return <>
    <Section title={t.accountingSetup}>
      <p>{t.accountingSetupHint}</p>
      <AccountingForm path={`${base}/settings`} method="PUT" title={t.save} onResult={reload} build={(data, id) => ({
        id, version: settings?.version ?? 0,
        business: {
          legalName: formValue(data, 'legalName'), tradingName: formValue(data, 'tradingName'), address: formValue(data, 'address'),
          email: formValue(data, 'email'), phone: formValue(data, 'phone'), registrationNumber: formValue(data, 'registrationNumber'), taxNumber: formValue(data, 'taxNumber'),
        },
        defaultCurrency: formValue(data, 'defaultCurrency'), invoicePrefix: formValue(data, 'invoicePrefix'),
        ...(!settings ? {startingNumber: Number(formValue(data, 'startingNumber'))} : {}),
        taxRates: rates.map(rate => ({name: formValue(data, `tax-${rate.id}-name`), rateBps: percentageToBps(formValue(data, `tax-${rate.id}-percentage`))})),
        lockedThrough: formValue(data, 'lockedThrough') || null, reason: formValue(data, 'reason'),
      })}>
        <Field label={t.accountingLegalName}><input name="legalName" required maxLength={160} defaultValue={settings?.business.legalName ?? ''}/></Field>
        <Field label={t.accountingTradingName}><input name="tradingName" maxLength={160} defaultValue={settings?.business.tradingName ?? ''}/></Field>
        <Field label={t.invoiceAddress}><textarea name="address" maxLength={500} defaultValue={settings?.business.address ?? ''}/></Field>
        <div className="field-row">
          <Field label={t.invoiceEmail}><input name="email" type="email" maxLength={254} defaultValue={settings?.business.email ?? ''}/></Field>
          <Field label={t.invoicePhone}><input name="phone" type="tel" maxLength={50} defaultValue={settings?.business.phone ?? ''}/></Field>
        </div>
        <div className="field-row">
          <Field label={t.accountingRegistration}><input name="registrationNumber" maxLength={100} defaultValue={settings?.business.registrationNumber ?? ''}/></Field>
          <Field label={t.invoiceTaxId}><input name="taxNumber" maxLength={100} defaultValue={settings?.business.taxNumber ?? ''}/></Field>
        </div>
        <Field label={t.accountingDefaultCurrency}><select name="defaultCurrency" required defaultValue={settings?.defaultCurrency ?? ''}><option value="">{t.select}</option>{currencies.map(currency => <option key={currency.code} value={currency.code}>{currency.code}</option>)}</select></Field>
        <div className="field-row">
          <Field label={t.accountingInvoicePrefix}><input name="invoicePrefix" required maxLength={16} pattern={'[A-Za-z0-9][A-Za-z0-9_\\-]{0,15}'} defaultValue={settings?.invoicePrefix ?? ''}/></Field>
          {!settings ? <Field label={t.accountingStartingNumber}><input name="startingNumber" type="number" min="1" step="1" max="999999999" required/></Field> : <Field label={t.accountingNextNumber}><input value={settings.nextNumber} readOnly/></Field>}
        </div>
        <fieldset className="repeat-card"><legend>{t.accountingTaxRates}</legend>
          <p className="muted small">{t.invoiceTaxHint}</p>
          {rates.map((rate, index) => <fieldset className="repeat-card" key={rate.id}><legend>{t.invoiceTaxRate} {index + 1}</legend><div className="field-row">
            <Field label={t.accountingTaxName}><input name={`tax-${rate.id}-name`} required maxLength={160} defaultValue={rate.name}/></Field>
            <Field label={t.invoiceTaxRate}><input name={`tax-${rate.id}-percentage`} type="text" inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" required maxLength={6} defaultValue={rate.percentage}/></Field>
          </div><button type="button" className="text-button danger-text" onClick={() => setRates(old => old.filter(item => item.id !== rate.id))}>{t.removeDraft}</button></fieldset>)}
          <button type="button" className="secondary" disabled={rates.length >= 30} onClick={() => setRates(old => [...old, {id: crypto.randomUUID(), name: '', percentage: ''}])}>{t.accountingAddTax}</button>
        </fieldset>
        <Field label={t.accountingLockDate} hint={t.accountingLockHint}><input name="lockedThrough" type="date" defaultValue={settings?.lockedThrough ?? ''}/></Field>
        <Field label={t.reason}><textarea name="reason" required minLength={3} maxLength={1000}/></Field>
      </AccountingForm>
    </Section>
    {settings && <Accounts/>}
  </>;
}

export function Accounts() {
  const {farm, t} = useFarm();
  const path = `/v1/farms/${farm.id}/accounting/accounts`;
  const resource = useResource<{items: AccountingAccount[]}>(path, {items: []});
  const types = {asset: t.accountingAsset, liability: t.accountingLiability, equity: t.accountingEquity, income: t.accountingIncome, expense: t.accountingExpense};
  return <Section title={t.accountingAccounts}>
    <ResourceState {...resource}/>
    <div className="table-scroll" role="region" aria-label={t.accountingAccounts} tabIndex={0}><table><caption>{t.accountingAccounts}</caption><thead><tr><th scope="col">{t.accountingAccountCode}</th><th scope="col">{t.name}</th><th scope="col">{t.accountingAccountType}</th></tr></thead><tbody>{resource.value.items.map(account => <tr key={account.code}><td>{account.code}</td><td>{accountName(account, t)}</td><td>{types[account.type]}</td></tr>)}</tbody></table></div>
    <ExpandForm title={t.accountingNewAccount}><AccountingForm path={path} title={t.save} onResult={resource.reload} build={(data, id) => ({id, code: formValue(data, 'code'), name: formValue(data, 'name'), type: formValue(data, 'type')})}>
      <Field label={t.accountingAccountCode}><input name="code" required pattern={'[A-Za-z0-9_\\-]{2,20}'} minLength={2} maxLength={20}/></Field>
      <Field label={t.name}><input name="name" required maxLength={160}/></Field>
      <Field label={t.accountingAccountType}><select name="type" required defaultValue=""><option value="">{t.select}</option>{Object.entries(types).map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></Field>
    </AccountingForm></ExpandForm>
  </Section>;
}
