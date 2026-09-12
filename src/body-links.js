// Build links with DOM nodes so diary text is never interpreted as HTML.
export function renderBody(container, body) {
  const fragment = document.createDocumentFragment();
  const pattern = /(?<![\p{L}\p{N}_@])(?:https?:\/\/|www\.)[^\s<>"'`“”‘’]+/giu;
  let cursor = 0;
  for (const match of body.matchAll(pattern)) {
    let label = match[0];
    // Keep balanced parentheses in URLs, but leave surrounding punctuation as text.
    while (label) {
      const previous = label;
      label = label.replace(/[.,!?;:…。！？、]+$/u, '');
      for (const [open, close] of [
        ['(', ')'],
        ['[', ']'],
        ['{', '}'],
      ]) {
        if (label.endsWith(close) && label.split(close).length > label.split(open).length)
          label = label.slice(0, -1);
      }
      if (label === previous) break;
    }
    let url;
    try {
      url = new URL(/^www\./i.test(label) ? `https://${label}` : label);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue;
    fragment.append(body.slice(cursor, match.index));
    const link = document.createElement('a');
    link.href = url.href;
    link.textContent = label;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    fragment.append(link);
    cursor = match.index + label.length;
  }
  fragment.append(body.slice(cursor));
  container.replaceChildren(fragment);
}
