const paths = {
  book: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20 M6.5 3H20v19H6.5A2.5 2.5 0 0 1 4 19.5v-14A2.5 2.5 0 0 1 6.5 3Z',
  plus: 'M12 5v14M5 12h14',
  search: 'm21 21-4.3-4.3M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  calendar:
    'M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z',
  grid: 'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  pin: 'm16 9 3-3-1-3-3-1-3 3M9 8l7 7M5 19l5-5M9 8 5 9l10 10 1-4',
  archive: 'M3 3h18v5H3ZM5 8v13h14V8M10 12h4',
  settings:
    'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1Z',
  cloud: 'M7 18a5 5 0 1 1-.6-9.96A7 7 0 0 1 20 10a4 4 0 0 1-1 8H7Z',
  refresh: 'M20 7v5h-5M4 17v-5h5M5.5 7a8 8 0 0 1 13-1l1.5 1M4 17l1.5 1a8 8 0 0 0 13-1',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  back: 'M19 12H5m6-6-6 6 6 6',
  chevron: 'm9 5 7 7-7 7',
  close: 'm6 6 12 12M6 18 18 6',
  photo: 'M3 3h18v18H3ZM3 17l6-6 4 4 3-3 5 5M15 7h.01',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  upload: 'M12 15V3m-5 5 5-5 5 5M4 16v5h16v-5',
  tag: 'M20 13 11 22 2 13V2h11l9 9-2 2ZM7 7h.01',
  check: 'm5 12 4 4L19 6',
  menu: 'M4 6h16M4 12h16M4 18h16',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  logout: 'M9 3H3v18h6M9 12h12m-5-5 5 5-5 5',
};
export const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ? `<path d="${paths[name]}"/>` : ''}</svg>`;
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon)));
}
