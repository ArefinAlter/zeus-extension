// Localised text lookups. Error codes and class names are stable machine strings; what a person
// reads is looked up by code, then by class, and only then falls back to a generic sentence
// (spec 00 section 11). The English diagnostic carried in an envelope is never shown on its own.
import type { ExtApi } from './platform';
import { errorMessageKey } from './errors';

export type I18n = ExtApi['i18n'];

/** `getMessage` with the key as the fallback so a missing entry is visible instead of blank. */
export function t(i18n: I18n, key: string, substitutions?: string | string[]): string {
  const text = i18n.getMessage(key, substitutions);
  return text === '' ? key : text;
}

/** Text for an error: its own entry, else its class entry, else the generic sentence. */
export function errorText(i18n: I18n, code: string, errorClass?: string): string {
  const byCode = i18n.getMessage(errorMessageKey(code));
  if (byCode !== '') return byCode;
  if (errorClass !== undefined) {
    const byClass = i18n.getMessage(`errClass_${errorClass}`);
    if (byClass !== '') return byClass;
  }
  return t(i18n, 'errGeneric');
}
