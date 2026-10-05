// Entry point of the popup page.
import { createExtApi } from '../lib/platform';
import { mountPopup } from './app';

mountPopup(createExtApi());
