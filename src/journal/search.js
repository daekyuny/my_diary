// Search matching shared by the list filter, card highlights and the reading view.
// Text is folded with NFKC and locale lower case, so full-width digits match half-width ones.
export const fold = (text) => text.normalize('NFKC').toLocaleLowerCase();
const graphemes = new Intl.Segmenter('ko', { granularity: 'grapheme' });

// Ranges [start, end) in the original text whose folded form equals the folded query.
// Folding runs per grapheme so each folded character maps back to its original position.
export function matchRanges(text, query) {
  const needle = fold(query || '');
  if (!needle || !text) return [];
  let folded = '';
  const starts = [],
    ends = [];
  for (const { segment, index } of graphemes.segment(text)) {
    const part = fold(segment);
    for (let i = 0; i < part.length; i++) {
      starts.push(index);
      ends.push(index + segment.length);
    }
    folded += part;
  }
  const ranges = [];
  for (let at = folded.indexOf(needle); at >= 0; at = folded.indexOf(needle, at + needle.length))
    ranges.push([starts[at], ends[at + needle.length - 1]]);
  return ranges;
}

const escapeHTML = (text) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
// Escapes every piece of the text and wraps only the matches, so diary text never becomes HTML.
export function highlightHTML(text, query) {
  let html = '',
    cursor = 0;
  for (const [start, end] of matchRanges(text, query)) {
    html += `${escapeHTML(text.slice(cursor, start))}<mark>${escapeHTML(text.slice(start, end))}</mark>`;
    cursor = end;
  }
  return html + escapeHTML(text.slice(cursor));
}

// A card preview starts at the sentence holding the first match when it is far into the body.
export function excerpt(text, query, lead = 40) {
  const [first] = matchRanges(text, query);
  if (!first || first[0] <= lead) return text;
  let start = first[0] - lead;
  const boundary = Math.max(
    text.lastIndexOf('\n', first[0] - 1),
    ...['. ', '! ', '? ', '。'].map((mark) => {
      const at = text.lastIndexOf(mark, first[0] - 1);
      return at < 0 ? -1 : at + mark.length - 1;
    }),
  );
  if (boundary >= start) start = boundary + 1;
  return `…${text.slice(start).trimStart()}`;
}

// Wraps matches inside text nodes only, leaving links built by renderBody intact.
export function markMatches(container, query) {
  if (!fold(query || '')) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const ranges = matchRanges(node.data, query);
    if (!ranges.length) continue;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const [start, end] of ranges) {
      fragment.append(node.data.slice(cursor, start));
      const mark = document.createElement('mark');
      mark.textContent = node.data.slice(start, end);
      fragment.append(mark);
      cursor = end;
    }
    fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }
}
