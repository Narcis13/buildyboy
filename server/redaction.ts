import type { Ctx } from './context.ts';
import { rulesWith, type RedactRule } from '../shared/redact.ts';

/** The default redaction rules plus the user's extra rules from Settings. */
export function rulesFor(ctx: Ctx) {
  return rulesWith(ctx.db.getSetting<RedactRule[] | null>('redaction_rules', null));
}
