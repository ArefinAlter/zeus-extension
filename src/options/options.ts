// Entry point of the options page.
import { createExtApi } from '../lib/platform';
import { mountOptions } from './app';

mountOptions(createExtApi());
