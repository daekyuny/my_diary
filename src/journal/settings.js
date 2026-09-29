// Device settings live in localStorage. The key and the owner prefix predate the appdata
// storage and must stay unchanged so existing devices keep their account and repository.
const KEY = 'my-diary-sheets-settings';
export function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    return {};
  }
}
export function saveSettings(settings) {
  localStorage.setItem(KEY, JSON.stringify(settings));
}
// IndexedDB owner: one store per account and repository, plus one for records made before login.
export function ownerKey(account, settings) {
  return account
    ? `sheets-${account.permissionId}-${settings.sheets?.[account.permissionId] || 'unassigned'}`
    : 'sheets-local';
}
