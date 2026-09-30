# Pricing matches the normalized model name exactly

> Grilled in #47 (2026-09-30), replacing the substring match the retired
> `ai-usage/usage-lib.mjs` priced with. #46 pinned the alias principle and left the
> matcher to this ticket.

A model name prices only when it equals a Pricing key after normalization — bracketed
qualifiers stripped, trimmed, lowercased. No substring, no longest-key-wins. The alias
table is the load-bearing mechanism for variant ids (ADR-0013 fingerprints the model, so
one id per model is already the rule): a name neither an alias nor a Pricing entry covers
stays unpriced, permanently.

## Why not the substring match it replaces

The retired matcher priced a model when a Pricing key was contained in it, longest key
winning — forgiving to unknown variants, which silently borrowed the longest key's rate.
Priced-once (ADR-0014) removes the repair that made that cheap to live with: a borrowed
rate that is wrong is wrong invisibly and forever, while an unpriced record is null — the
durable marker #46 named, visible on the wire and queryable in the store. Exact match
makes the table explicit — every rate a model can be charged is written in it — and moves
the variant problem into the alias table, where a missing alias is an edit away.

## Consequences

- A new dated snapshot or relay id prices null until an alias or an entry covers it. That
  is the accepted state, not a defect; the fix is an alias, and nulls already stored stay
  null.
- `deepseek-v4-flash-vision-exp` carried no entry — the substring match priced it
  implicitly at deepseek-v4-flash rates. Exact match needs it written out: its own entry
  at those same rates, so the record keeps its identity and its price is explicit.
- The substring trap (`glm-5.3` must not resolve to `glm-5.3-flash`) dissolves — exact
  comparison cannot confuse a key with its extension — and the tests that pinned it are
  replaced by pins on the alias chain and on un-aliased variants pricing null.
- The warning is not the matcher's business: the stderr line for an unpriced model is
  #46's decision and lands with the commands (#48). The pricing module prices null and
  says nothing.
