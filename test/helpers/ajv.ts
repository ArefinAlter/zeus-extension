// Ajv is a development-only reference: it validates the contracts independently of the
// extension's own schema interpreter, which cannot be used to test itself.
import { Ajv2020 } from 'ajv/dist/2020.js';
import commonSchema from '../../schema/common.schema.json';
import domainSchema from '../../schema/domain.schema.json';
import nmSchema from '../../schema/native-messaging.v1.schema.json';

export function makeAjv(): Ajv2020 {
  const ajv = new Ajv2020({
    strict: true,
    strictTypes: false,
    strictRequired: false,
    allErrors: false,
    allowUnionTypes: true,
  });
  ajv.addKeyword({ keyword: 'x-zeus-secret' });
  ajv.addSchema(commonSchema);
  ajv.addSchema(domainSchema);
  ajv.addSchema(nmSchema);
  return ajv;
}

const ajv = makeAjv();

/** Validate against `native-messaging.v1#/$defs/<def>` (or any `<doc>#<pointer>` id). */
export function ajvValid(ref: string, value: unknown): boolean {
  const validate = ajv.getSchema(ref);
  if (!validate) throw new Error(`Ajv cannot resolve ${ref}`);
  return validate(value) === true;
}

export function ajvErrors(ref: string, value: unknown): string {
  const validate = ajv.getSchema(ref);
  if (!validate) throw new Error(`Ajv cannot resolve ${ref}`);
  validate(value);
  return JSON.stringify(validate.errors?.slice(0, 3) ?? []);
}
