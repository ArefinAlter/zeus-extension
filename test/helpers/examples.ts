import examplesFile from '../../schema/examples/spec-examples.json';

export interface SpecExample {
  source: string;
  ref: string;
  line: number;
  value: unknown;
}

export const specExamples: SpecExample[] = (examplesFile as { examples: SpecExample[] }).examples;

export const ID_PREFIX = 'https://zeus.invalid/schema/';

/** `native-messaging.v1#/$defs/X` as a full schema id. */
export const fullRef = (ref: string): string => ID_PREFIX + ref;

const endsWith = (suffix: string) => (e: SpecExample) => e.ref.endsWith(suffix);
export const extensionExamples = specExamples.filter(endsWith('/ExtensionToDaemonMessage'));
export const daemonExamples = specExamples.filter(endsWith('/DaemonToExtensionMessage'));
export const eventExamples = specExamples.filter(endsWith('domain#/$defs/Event'));
