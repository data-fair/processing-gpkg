import type { PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

/**
 * Called when the configuration is saved. This plugin has no secret to move out of the
 * config, so the config and secrets are returned unchanged.
 */
const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  return { processingConfig, secrets }
}

export default prepare
