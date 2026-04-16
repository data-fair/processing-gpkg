import type { ProcessingConfig } from '../types/processingConfig/index.ts'

import config from '#config'
import { strict as assert } from 'node:assert'
import { it, describe } from 'node:test'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as helloWorldPlugin from '../index.ts'

import pluginConfigSchema from '../plugin-config-schema.json' with { type: 'json' }
import processingConfigSchema from '../processing-config-schema.json' with { type: 'json' }

describe('Hello world processing', () => {
  // Each plugins should expose a plugin config schema and a processing config schema
  it('should expose a plugin config schema for super admins', async () => {
    assert.equal(pluginConfigSchema.properties.pluginMessage.default, 'Hello')
  })
  it('should expose a processing config schema for users', async () => {
    assert.equal(processingConfigSchema.type, 'object')
  })

  it('should run a task', async function () {
    const context = testUtils.context({
      pluginConfig: { pluginMessage: 'Hello' },
      processingConfig: {
        datasetMode: 'create',
        dataset: { title: 'Hello world test' },
        message: 'world test !',
        delay: 1
      }
    }, config, false)

    await helloWorldPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.dataset.title, 'Hello world test')
  })

  it('should use secrets', async function () {
    const processingConfig: ProcessingConfig = {
      datasetMode: 'create',
      dataset: { title: 'Hello world test' },
      message: 'world test !',
      delay: 1,
      secretField: 'Texte secret'
    }

    const prepareRes = await helloWorldPlugin.prepare({ processingConfig, secrets: { } })
    assert.ok(prepareRes.processingConfig)
    assert.equal(prepareRes.processingConfig.secretField, '********')

    assert.ok(prepareRes.secrets)
    assert.equal(prepareRes.secrets.secretField, 'Texte secret', 'the secret is not correctly returned by prepare function')

    const context = testUtils.context({
      pluginConfig: { pluginMessage: 'Hello' },
      processingConfig: prepareRes.processingConfig,
      secrets: prepareRes.secrets,
    }, config, false)

    await helloWorldPlugin.run(context)
  })
})
