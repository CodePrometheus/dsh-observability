/**
 * Package-owned invariant companion for `dsh-observability`.
 * @module dsh-observability/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-observability'

/** Cordis companion plugin name. */
export const name = 'observability-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the folding projection's only owned relation is the
 * open-span map, whose entries are consumed and discarded as spans end, and
 * whose closed spans move inside the SDK pipeline past this package's
 * boundary. An independent companion can therefore observe neither the open
 * set at a comparable moment nor the exported result.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
