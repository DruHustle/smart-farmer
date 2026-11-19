/** The managed Auth0 issuer is not the Onesa Account application origin. */
export function accountManagementUrl(issuer: string, managed: boolean): string {
  // Preserve the original Portal account destination for legacy flows.
  return managed ? 'https://account.onesa.eu/account' : new URL('/account', issuer).href;
}
