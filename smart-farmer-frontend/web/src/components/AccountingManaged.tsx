import {useFarm} from '../context';

/** A cross-farm market result must never open an invoice under the current farm. */
export function AccountingManaged({invoiceId, invoiceFarmId}: {invoiceId: unknown; invoiceFarmId?: unknown}) {
  const {t, navigate, farm, snapshot, manager} = useFarm();
  const currentFarm = invoiceFarmId === undefined || invoiceFarmId === farm.id;
  const linkedFarm = snapshot.farms.find(item => item.id === invoiceFarmId);
  return <div className="notice subtle"><p>{t.invoiceManagedHint}</p>{currentFarm && manager ? <button type="button" className="text-button" onClick={() => navigate('accounting', typeof invoiceId === 'string' ? {invoiceId} : undefined)}>{t.invoiceOpenLinked}</button> : <p>{t.invoiceChooseLinkedFarm}{linkedFarm ? ` · ${linkedFarm.name}` : ''}</p>}</div>;
}
