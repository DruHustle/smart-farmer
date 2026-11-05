import { ApiError } from '../context.js';
import type { AccountingLine, AccountingLineInput, AccountingTotals, CurrencyScale } from './types.js';

const currencies = new Map(Intl.supportedValuesOf('currency').flatMap(code => {
  const scale = new Intl.NumberFormat('en', { style: 'currency', currency: code }).resolvedOptions().maximumFractionDigits;
  return typeof scale === 'number' && scale >= 0 && scale <= 3 ? [[code, scale as CurrencyScale] as const] : [];
}));
export const supportedCurrencies = [...currencies].map(([code, minorUnit]) => ({ code, minorUnit }));
export function currencyScale(code: string): CurrencyScale {
  const scale = currencies.get(code);
  if (scale === undefined) throw new ApiError('unsupported_currency');
  return scale;
}
export const MAX_MINOR = 999_999_999_999_999n;
export function minor(value: unknown, signed = false): bigint {
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9]\d{0,14})$/ : /^(0|[1-9]\d{0,14})$/).test(value)) throw new ApiError('invalid_amount');
  const amount = BigInt(value);
  if (amount > MAX_MINOR || amount < -MAX_MINOR) throw new ApiError('amount_too_large');
  return amount;
}
export function decimalScaled(value: unknown, scale: number, signed = false): bigint {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,15}(\.\d{1,6})?$/ : /^\d{1,15}(\.\d{1,6})?$/).test(value)) throw new ApiError('invalid_amount');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  if (fraction.slice(scale).replaceAll('0', '') !== '') throw new ApiError('invalid_amount');
  const amount = BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.slice(0, scale).padEnd(scale, '0') || '0');
  return negative ? -amount : amount;
}
export function decimalFromMinor(value: bigint | string, scale: number): string {
  let amount = typeof value === 'bigint' ? value : BigInt(value);
  const sign = amount < 0n ? '-' : '';
  if (amount < 0n) amount = -amount;
  if (!scale) return sign + amount.toString();
  const digits = amount.toString().padStart(scale + 1, '0');
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
export function halfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n || numerator < 0n) throw new ApiError('invalid_amount');
  return (numerator * 2n + denominator) / (denominator * 2n);
}
export function calculateLines(input: AccountingLineInput[], scale: CurrencyScale, defaultAccount: string): { lines: AccountingLine[]; totals: AccountingTotals; taxBreakdown: { rateBps: number; taxableMinor: string; taxMinor: string }[] } {
  let subtotal = 0n, discount = 0n, net = 0n, tax = 0n;
  const rates = new Map<number, { net: bigint; tax: bigint }>();
  const lines = input.map(line => {
    const qty = decimalScaled(line.quantity, 6), unit = decimalScaled(line.unitPrice, 6);
    if (qty <= 0n) throw new ApiError('invalid_quantity');
    const grossBase = halfUp(qty * unit * 10n ** BigInt(scale), 1_000_000_000_000n);
    if (grossBase > MAX_MINOR) throw new ApiError('amount_too_large');
    const reduction = minor(line.discountMinor);
    if (reduction > grossBase) throw new ApiError('discount_exceeds_line');
    const lineNet = grossBase - reduction;
    const lineTax = halfUp(lineNet * BigInt(line.taxRateBps), 10_000n);
    if (lineNet + lineTax > MAX_MINOR) throw new ApiError('amount_too_large');
    subtotal += grossBase; discount += reduction; net += lineNet; tax += lineTax;
    const bucket = rates.get(line.taxRateBps) ?? { net: 0n, tax: 0n };
    bucket.net += lineNet; bucket.tax += lineTax; rates.set(line.taxRateBps, bucket);
    return { ...line, accountCode: line.accountCode || defaultAccount, projectId: line.projectId ?? null, netMinor: lineNet.toString(), taxMinor: lineTax.toString(), totalMinor: (lineNet + lineTax).toString() };
  });
  if (subtotal > MAX_MINOR || discount > MAX_MINOR || net + tax > MAX_MINOR) throw new ApiError('amount_too_large');
  return { lines, totals: { subtotalMinor: subtotal.toString(), discountMinor: discount.toString(), netMinor: net.toString(), taxMinor: tax.toString(), totalMinor: (net + tax).toString() }, taxBreakdown: [...rates].sort((a,b) => a[0] - b[0]).map(([rateBps, b]) => ({ rateBps, taxableMinor: b.net.toString(), taxMinor: b.tax.toString() })) };
}
