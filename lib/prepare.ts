import type { PrepareFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

/**
 * When the configuration is saved, we need to hide the secret value and store it in the secrets store.
 * - If the secret field is a new value, we store it in the secrets and replace it with '********' in the config.
 * - If the secret field is an empty value, we remove it from the secrets.
 */
const prepare: PrepareFunction<ProcessingConfig> = async ({ processingConfig, secrets }) => {
  const secretField = processingConfig.secretField

  if (secretField && secretField !== '********') {
    secrets.secretField = secretField
    processingConfig.secretField = '********'
  } else if (secrets.secretField && secretField === '') {
    delete secrets.secretField
  }

  return { processingConfig, secrets }
}

export default prepare
