import {useState} from 'react';
import {useFarm} from '../../context';
import {amountToMinor, invoiceMoney} from '../../lib/accounting';
import {useList, useResource} from '../../lib/resources';
import {displayDate} from '../../lib/time';
import {downloadPrivate, MoreButton, ResourceState} from '../../components/completion';
import {Empty, ExpandForm, Field, Form, Icon, Section, Submit, formValue} from '../../components/ui';
import {AccountingForm} from './AccountingForm';
import {accountName} from './accountNames';
import type {AccountingAccount, AccountingJournal, AccountingReportsResponse, SettingsResponse} from './types';

export function AccountingReports({configuration}: {configuration: SettingsResponse}) {
  const {farm, t, lang, online, run, snapshot, notify} = useFarm();
  const base = `/v1/farms/${farm.id}/accounting`;
  const [filters, setFilters] = useState({from: '', to: '', asOf: ''});
  const [currency, setCurrency] = useState('');
  const [revision, setRevision] = useState(0);
  const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value));
  const flowQuery = new URLSearchParams(Object.entries({...filters, currency}).filter(([, value]) => value));
  const report = useResource<AccountingReportsResponse | null>(`${base}/reports?${query}`, null);
  const journals = useList<AccountingJournal>(`${base}/ledger?${flowQuery}`);
  async function refresh() {
    const results = await Promise.allSettled([report.reload(), journals.reload()]);
    if (results.some(result => result.status === 'rejected')) notify(t.limitedSync);
    setRevision(old => old + 1);
  }
  return <>
    <Section title={t.invoiceReports}>
      <p>{t.invoiceReportHint}</p>
      <Form className="accounting-report-filters" onSubmit={form => setFilters({from: formValue(form, 'from'), to: formValue(form, 'to'), asOf: formValue(form, 'asOf')})}>
        <div className="field-row"><Field label={t.fromDate}><input name="from" type="date" defaultValue={filters.from}/></Field><Field label={t.toDate}><input name="to" type="date" defaultValue={filters.to}/></Field></div>
        <Field label={t.accountingAsOf}><input name="asOf" type="date" defaultValue={filters.asOf}/></Field>
        <Submit>{t.review}</Submit>
      </Form>
      <div className="button-row"><button type="button" className="secondary" disabled={!online} onClick={() => void run(() => downloadPrivate(`${base}/invoices.csv?${flowQuery}`, snapshot.identity.token, 'farm-invoices.csv'))}>{t.accountingExportInvoices}</button><button type="button" className="secondary" disabled={!online} onClick={() => void run(() => downloadPrivate(`${base}/ledger.csv?${flowQuery}`, snapshot.identity.token, 'farm-accounting-ledger.csv'))}>{t.accountingExportLedger}</button></div>
      <ResourceState {...report}/>
      {report.value && <p className="notice subtle">{t.accountingScopeHint}<br/>{t.accountingUnlinked}: {report.value.summary.unlinkedLegacyEntries}<br/>{t.accountingAsOf}: {displayDate(report.value.summary.asOf, lang)}</p>}
    </Section>
    {report.value && <>
      <Section title={t.accountingProfitLoss}>
        <div className="accounting-currencies">{report.value.profitLoss.map(row => <article className="accounting-currency" key={row.currency}><h3>{row.currency}</h3><dl><ReportAmount title={t.accountingIncome} value={row.incomeMinor} row={row}/><ReportAmount title={t.accountingExpense} value={row.expenseMinor} row={row}/><ReportAmount title={t.accountingRecordedResult} value={row.resultMinor} row={row}/></dl></article>)}</div>
        {!report.value.profitLoss.length && <Empty title={t.emptyFinancials}/>}
      </Section>
      <Section title={t.accountingBalanceSheet}>
        <div className="accounting-currencies">{report.value.balanceSheet.map(row => <article className="accounting-currency" key={row.currency}><h3>{row.currency}</h3><dl><ReportAmount title={t.accountingAsset} value={row.assetsMinor} row={row}/><ReportAmount title={t.accountingLiability} value={row.liabilitiesMinor} row={row}/><ReportAmount title={t.accountingEquity} value={row.equityMinor} row={row}/></dl></article>)}</div>
        {!report.value.balanceSheet.length && <Empty title={t.emptyFinancials}/>}
      </Section>
      <Section title={t.accountingTrialBalance}>
        {report.value.trialBalance.map(row => <div key={row.currency} className="record-card"><h3>{row.currency}</h3>
          <div className="table-scroll" role="region" aria-label={`${t.accountingTrialBalance} ${row.currency}`} tabIndex={0}><table><caption>{t.accountingTrialBalance} · {row.currency}</caption><thead><tr><th scope="col">{t.accountingAccount}</th><th scope="col">{t.accountingDebit}</th><th scope="col">{t.accountingCredit}</th><th scope="col">{t.accountingBalance}</th></tr></thead><tbody>{row.accounts.map(account => <tr key={account.code}><td>{account.code} · {accountName({...account, system: true}, t)}</td><td>{invoiceMoney(account.debitMinor, row.currency, row.minorUnit, lang)}</td><td>{invoiceMoney(account.creditMinor, row.currency, row.minorUnit, lang)}</td><td>{invoiceMoney(account.balanceMinor, row.currency, row.minorUnit, lang)}</td></tr>)}</tbody><tfoot><tr><th scope="row">{t.totals}</th><td>{invoiceMoney(row.totalDebitMinor, row.currency, row.minorUnit, lang)}</td><td>{invoiceMoney(row.totalCreditMinor, row.currency, row.minorUnit, lang)}</td><td>—</td></tr></tfoot></table></div>
        </div>)}
        {!report.value.trialBalance.length && <Empty title={t.emptyFinancials}/>}
      </Section>
      <Section title={t.accountingAging}>
        {report.value.aging.map(row => <article className="accounting-currency record-card" key={`${row.kind}-${row.currency}`}><h3>{row.kind === 'sale' ? t.invoiceReceivables : t.invoicePayables} · {row.currency}</h3><dl><ReportAmount title={t.accountingCurrent} value={row.currentMinor} row={row}/><ReportAmount title={t.accountingAging30} value={row.days1To30Minor} row={row}/><ReportAmount title={t.accountingAging60} value={row.days31To60Minor} row={row}/><ReportAmount title={t.accountingAging90} value={row.days61To90Minor} row={row}/><ReportAmount title={t.accountingAgingOver90} value={row.over90Minor} row={row}/></dl></article>)}
        {!report.value.aging.length && <Empty title={t.emptyFinancials}/>}
      </Section>
    </>}
    <Section title={t.accountingLedger}>
      <Field label={t.currency}><select value={currency} onChange={event => setCurrency(event.target.value)}><option value="">{t.all}</option>{configuration.currencies.map(item => <option key={item.code} value={item.code}>{item.code}</option>)}</select></Field>
      <ResourceState {...journals}/>
      {journals.items.map(journal => <details className="record-card" key={journal.id}><summary>{displayDate(journal.postedOn, lang)} · {journal.description} · {journal.currency}</summary><p className="preserve-lines">{journal.reason}</p>
        <div className="table-scroll" role="region" aria-label={t.accountingLedger} tabIndex={0}><table><caption>{journal.description}</caption><thead><tr><th scope="col">{t.accountingAccountCode}</th><th scope="col">{t.description}</th><th scope="col">{t.accountingDebit}</th><th scope="col">{t.accountingCredit}</th></tr></thead><tbody>{journal.lines.map((line, index) => <tr key={index}><td>{line.accountCode}</td><td>{line.description}</td><td>{invoiceMoney(line.debitMinor, journal.currency, journal.minorUnit, lang)}</td><td>{invoiceMoney(line.creditMinor, journal.currency, journal.minorUnit, lang)}</td></tr>)}</tbody></table></div>
        {(journal.reversalOf || journal.reversedBy) && <p className="notice subtle">{t.accountingJournalReversed}</p>}
        {journal.sourceType === 'manual' && !journal.reversalOf && !journal.reversedBy && <ExpandForm title={t.accountingReverseJournal}><AccountingForm path={`${base}/journals/${journal.id}/reverse`} title={t.accountingReverseJournal} onResult={refresh} build={(form, id) => ({id, postedOn: formValue(form, 'postedOn'), reason: formValue(form, 'reason'), confirmed: form.has('confirmed')})}>
          <Field label={t.accountingJournalDate}><input name="postedOn" type="date" required/></Field><Field label={t.reason}><textarea name="reason" required minLength={3} maxLength={1000}/></Field><label className="check-label"><input name="confirmed" type="checkbox" required/>{t.accountingManualConfirmed}</label>
        </AccountingForm></ExpandForm>}
      </details>)}
      {!journals.loading && !journals.items.length && <Empty title={t.emptyFinancials}/>}<MoreButton {...journals}/>
    </Section>
    <Section title={t.accountingManualJournal}><ExpandForm title={t.accountingManualJournal}><ManualJournal key={revision} configuration={configuration} onSaved={refresh}/></ExpandForm></Section>
  </>;
}

function ReportAmount({title, value, row}: {title: string; value: string; row: {currency: string; minorUnit: number}}) {
  const {lang} = useFarm();
  return <div><dt>{title}</dt><dd>{invoiceMoney(value, row.currency, row.minorUnit, lang)}</dd></div>;
}

function ManualJournal({configuration, onSaved}: {configuration: SettingsResponse; onSaved: () => Promise<void>}) {
  const {farm, t} = useFarm();
  const base = `/v1/farms/${farm.id}/accounting`;
  const accounts = useResource<{items: AccountingAccount[]}>(`${base}/accounts`, {items: []});
  const [currency, setCurrency] = useState(configuration.settings?.defaultCurrency ?? '');
  const [lines, setLines] = useState(() => [crypto.randomUUID(), crypto.randomUUID()]);
  const scale = configuration.currencies.find(item => item.code === currency)?.minorUnit;
  return <>
    <p className="notice subtle">{t.accountingJournalHint}</p><ResourceState {...accounts}/>
    <AccountingForm path={`${base}/journals`} title={t.accountingManualJournal} onResult={onSaved} build={(form, id) => {
      if (scale === undefined) throw new Error('unsupported_currency');
      const journalLines = lines.map(key => {
        const debitMinor = amountToMinor(formValue(form, `journal-${key}-debit`) || '0', scale);
        const creditMinor = amountToMinor(formValue(form, `journal-${key}-credit`) || '0', scale);
        if ((BigInt(debitMinor) > 0n) === (BigInt(creditMinor) > 0n)) throw new Error('unbalanced_journal');
        return {accountCode: formValue(form, `journal-${key}-account`), debitMinor, creditMinor, description: formValue(form, `journal-${key}-description`)};
      });
      if (journalLines.reduce((sum, line) => sum + BigInt(line.debitMinor) - BigInt(line.creditMinor), 0n) !== 0n) throw new Error('unbalanced_journal');
      return {id, currency, postedOn: formValue(form, 'postedOn'), description: formValue(form, 'description'), reason: formValue(form, 'reason'), confirmed: form.has('confirmed'), lines: journalLines};
    }}>
      <div className="field-row"><Field label={t.currency}><select name="currency" required value={currency} onChange={event => setCurrency(event.target.value)}><option value="">{t.select}</option>{configuration.currencies.map(item => <option key={item.code} value={item.code}>{item.code}</option>)}</select></Field><Field label={t.accountingJournalDate}><input name="postedOn" type="date" required/></Field></div>
      <Field label={t.description}><input name="description" required maxLength={500}/></Field>
      <fieldset className="repeat-card accounting-journal-lines"><legend>{t.accountingLedger}</legend><p className="muted small">{t.accountingOneSide}</p>{lines.map((key, index) => <fieldset className="repeat-card" key={key}><legend>{t.invoiceLine} {index + 1}</legend>
        <Field label={t.accountingAccount}><select name={`journal-${key}-account`} required defaultValue=""><option value="">{t.select}</option>{accounts.value.items.filter(account => account.active).map(account => <option key={account.code} value={account.code}>{account.code} · {accountName(account, t)}</option>)}</select></Field>
        <Field label={t.description}><input name={`journal-${key}-description`} maxLength={500}/></Field>
        <div className="field-row"><Field label={`${t.accountingDebit} · ${currency}`}><input name={`journal-${key}-debit`} type="text" inputMode="decimal" pattern={scale ? `[0-9]+([.][0-9]{1,${scale}})?` : '[0-9]+'} maxLength={30}/></Field><Field label={`${t.accountingCredit} · ${currency}`}><input name={`journal-${key}-credit`} type="text" inputMode="decimal" pattern={scale ? `[0-9]+([.][0-9]{1,${scale}})?` : '[0-9]+'} maxLength={30}/></Field></div>
        <button type="button" className="text-button danger-text" disabled={lines.length <= 2} onClick={() => setLines(old => old.filter(item => item !== key))}>{t.removeInvoiceLine} {index + 1}</button>
      </fieldset>)}<button type="button" className="secondary" disabled={lines.length >= 200} onClick={() => setLines(old => [...old, crypto.randomUUID()])}><Icon name="plus"/>{t.accountingAddJournalLine}</button></fieldset>
      <Field label={t.reason}><textarea name="reason" required minLength={3} maxLength={1000}/></Field>
      <label className="check-label"><input name="confirmed" type="checkbox" required/>{t.accountingManualConfirmed}</label>
    </AccountingForm>
  </>;
}
