// Minimal DOM helpers. Text always goes in through textContent: file names and other strings that
// originate from remote servers are data, never markup (spec 00 section 11), and ESLint forbids
// innerHTML across the code base.
import type { I18n } from '../lib/messages';
import { t } from '../lib/messages';

export type Child = Node | string | null | false | undefined;

export interface Attrs {
  class?: string;
  id?: string;
  type?: string;
  title?: string;
  role?: string;
  hidden?: boolean;
  disabled?: boolean;
  checked?: boolean;
  value?: number | string;
  autocomplete?: string;
  spellcheck?: string;
  oninput?: (event: Event) => void;
  max?: number;
  href?: string;
  lang?: string;
  'aria-label'?: string;
  'aria-live'?: string;
  'data-tone'?: string;
  'data-style'?: string;
  onclick?: (event: MouseEvent) => void;
  onchange?: (event: Event) => void;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key === 'onclick' || key === 'onchange' || key === 'oninput') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'class') {
      el.className = String(value);
    } else if (
      key === 'disabled' ||
      key === 'checked' ||
      key === 'hidden' ||
      key === 'value' ||
      key === 'max'
    ) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === false || child === undefined) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function clear(el: Element): void {
  el.replaceChildren();
}

/** Fill every `data-i18n`, `data-i18n-title` and `data-i18n-label` element of a static page. */
export function applyI18n(i18n: I18n, root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(i18n, el.dataset.i18n ?? '');
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(i18n, el.dataset.i18nTitle ?? '');
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    el.setAttribute('aria-label', t(i18n, el.dataset.i18nLabel ?? ''));
  }
  document.documentElement.lang = i18n.getUILanguage();
}
