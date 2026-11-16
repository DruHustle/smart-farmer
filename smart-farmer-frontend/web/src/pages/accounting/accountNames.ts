import type {Words} from '../../locales';
import type {AccountingAccount} from './types';

export function accountName(account: Pick<AccountingAccount, 'code' | 'name' | 'system'>, t: Words): string {
  const names: Record<string, string> = {
    '1000': t.invoicePaymentCash, '1010': t.invoicePaymentBank, '1020': t.invoicePaymentMobile, '1030': t.other,
    '1100': t.invoiceReceivables, '1200': t.accountingTaxAdjustment, '1300': t.accountingInventory, '1400': t.accountingEquipment, '1500': t.accountingSupplierAdvance,
    '2000': t.invoicePayables, '2100': t.accountingTaxCollected, '2200': t.accountingCustomerAdvance, '3000': t.accountingOpeningEquity,
    '4000': t.accountingIncome, '5000': t.accountingExpense, '5100': t.accountingPurchaseTax,
  };
  return account.system ? names[account.code] ?? account.name : account.name;
}
