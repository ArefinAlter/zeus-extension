// Generates src/lib/protocol.generated.ts from the committed schemas.
//
//   node scripts/gen-types.mjs [--check]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GENERATED_FILE, generateTypes } from './lib/types-gen.mjs';

const ts = await generateTypes();
if (process.argv.includes('--check')) {
  const current = existsSync(GENERATED_FILE) ? readFileSync(GENERATED_FILE, 'utf8') : '';
  if (current !== ts) {
    console.error('src/lib/protocol.generated.ts is stale: run npm run gen:types');
    process.exit(1);
  }
  console.log('protocol.generated.ts is up to date');
} else {
  writeFileSync(GENERATED_FILE, ts, 'utf8');
  console.log(`wrote ${GENERATED_FILE} (${ts.length} bytes)`);
}
