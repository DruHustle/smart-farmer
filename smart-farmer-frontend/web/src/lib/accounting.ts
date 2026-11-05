import type {Lang} from '../types';

/** Keep invoice values as strings. Binary floating point must not change a money draft. */
export function decimalInput(value: string, scale = 6): string {
  const cleaned = value.trim();
  if (!Number.isInteger(scale) || scale < 0 || scale > 6 || !/^\d+(?:\.\d+)?$/.test(cleaned)) throw new Error('accounting_invalid_decimal');
  const [whole, fraction = ''] = cleaned.split('.');
  if (fraction.length > scale) throw new Error('accounting_invalid_decimal');
  return `${BigInt(whole)}${fraction ? `.${fraction}` : ''}`;
}

function precision(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 3) throw new Error('accounting_invalid_precision');
  return value;
}

export function amountToMinor(value: string, minorUnit: number): string {
  const scale = precision(minorUnit);
  const [whole, fraction = ''] = decimalInput(value, scale).split('.');
  return (BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0')).toString();
}

export function minorToInput(value: string, minorUnit: number): string {
  const scale = precision(minorUnit);
  if (!/^-?\d+$/.test(value)) throw new Error('accounting_invalid_decimal');
  const amount = BigInt(value);
  const absolute = (amount < 0n ? -amount : amount).toString().padStart(scale + 1, '0');
  return `${amount < 0n ? '-' : ''}${scale ? `${absolute.slice(0, -scale)}.${absolute.slice(-scale)}` : absolute}`;
}

export function invoiceMoney(value: string | null | undefined, currency: string | null | undefined, minorUnit: number, language: Lang): string {
  if (value === null || value === undefined || value === '' || !currency) return '—';
  const [whole, fraction] = minorToInput(value, minorUnit).split('.');
  const amount = BigInt(whole);
  const grouped = new Intl.NumberFormat(`${language}-ZW`, {maximumFractionDigits: 0}).format(amount);
  // Keep the sign of values between -1 and 0; BigInt('-0') is zero.
  return `${currency} ${whole.startsWith('-') && amount === 0n ? '-' : ''}${grouped}${fraction === undefined ? '' : `.${fraction}`}`;
}

export function percentageToBps(value: string): number {
  const result = BigInt(amountToMinor(value, 2));
  if (result > 10000n) throw new Error('accounting_invalid_tax');
  return Number(result);
}

export const invoiceMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] as const;
export function validateInvoiceFile(file: Pick<File, 'type' | 'size' | 'name'>): void {
  if (!(invoiceMimeTypes as readonly string[]).includes(file.type)) throw new Error('accounting_document_type');
  if (!file.size || file.size > 5 * 1024 * 1024) throw new Error('attachment_too_large');
  if (!file.name.trim() || file.name.length > 150 || /[\x00-\x1f\x7f/\\]/.test(file.name)) throw new Error('accounting_document_name');
}

export async function invoiceFilePayload(file: File): Promise<{mimeType: string; filename: string; dataBase64: string}> {
  validateInvoiceFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 16_384) binary += String.fromCharCode(...bytes.subarray(i, i + 16_384));
  return {mimeType: file.type, filename: file.name, dataBase64: btoa(binary)};
}
