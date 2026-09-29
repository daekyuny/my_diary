// Small DOM helpers shared by the journal controller.
export const $ = (selector) => document.querySelector(selector);
let toastTimer;
// `action` adds a button ({ label, run }) that hides the toast when pressed. While such a
// toast is visible, routine status messages do not replace it; errors and other actions do.
export function toast(message, error = false, action = null) {
  const element = $('#toast');
  if (!element.hidden && element.querySelector('.toast-action') && !error && !action) return;
  clearTimeout(toastTimer);
  element.textContent = message;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.onclick = () => {
      clearTimeout(toastTimer);
      element.hidden = true;
      action.run();
    };
    element.append(button);
  }
  element.classList.toggle('error', error);
  element.hidden = false;
  toastTimer = setTimeout(() => (element.hidden = true), error ? 13000 : 5000);
}
export function small(title, html) {
  $('#small-title').textContent = title;
  $('#small-body').innerHTML = html;
  if (!$('#small-dialog').open) $('#small-dialog').showModal();
}
// In-app replacement for window.confirm: resolves true only when the accept button is pressed.
export function confirmDialog(title, message, { accept = '확인', danger = false } = {}) {
  return new Promise((resolve) => {
    small(
      title,
      `<p id="confirm-message"></p><div class="dialog-actions"><button id="confirm-cancel" type="button" class="button">취소</button><button id="confirm-accept" type="button" class="button ${danger ? 'danger' : 'primary'}"></button></div>`,
    );
    $('#confirm-message').textContent = message;
    $('#confirm-accept').textContent = accept;
    const dialog = $('#small-dialog');
    let accepted = false;
    dialog.addEventListener(
      'close',
      () => {
        $('#small-body').innerHTML = '';
        resolve(accepted);
      },
      { once: true },
    );
    $('#confirm-cancel').onclick = () => dialog.close();
    $('#confirm-accept').onclick = () => {
      accepted = true;
      dialog.close();
    };
    // Enter must not trigger the destructive choice by default.
    $('#confirm-cancel').focus();
  });
}
export function download(blob, name) {
  const url = URL.createObjectURL(blob),
    link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
