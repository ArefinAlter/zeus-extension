// The InterruptReason values straight from the protocol schema, so the classification table is
// checked against the contract and not against a copy typed by hand.
import nmSchema from '../../schema/native-messaging.v1.schema.json';
import type { InterruptReason } from '../../src/lib/protocol';

export const InterruptReasonValues = (nmSchema.$defs.InterruptReason as { enum: InterruptReason[] })
  .enum;
