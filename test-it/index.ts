import config from '#config'
import { strict as assert } from 'node:assert'
import { it, describe } from 'node:test'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as gpkgPlugin from '../index.ts'

import processingConfigSchema from '../processing-config-schema.json' with { type: 'json' }

/**
 * Used to test the list of sofas in a file and the correct creation of datasets from a file.
 * We do not test the update because we cannot retrieve the necessary information for the test.
 */
describe('Geopackage processing', () => {
  // Each plugin should expose a processing config schema

  it('should expose a processing config schema for users', async () => {
    assert.equal(processingConfigSchema.type, 'object')
  })

  it('should display the layers of a gpkg file', async () => {
    const context = testUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'list',
        url: 'https://www.data.gouv.fr/api/1/datasets/r/0abf0b26-317f-4055-a0e3-8f4ea772853e',
      },
      tmpDir: 'test-data/'
    }, config, false)

    await gpkgPlugin.run(context)
  })

  it('should run a task with a gpkg file to create an edit dataset', async function () {
    // WARNING !!!
    console.warn('Bulk_lines errors may appear (undefined). This is a 413 (Request Entity Too Large) error, which is not acceptable locally.')
    console.warn('To fix this, you need to change the BATCH_SIZE variable in stream-layer.ts.')

    const context = testUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: {
          editableCreate: true
        },
        layers: [
          {
            add: true,
            nb: 2,
            name: 'commune',
            lines: 34877,
            titleEditable: 'test-edit-2'
          },
          {
            add: true,
            nb: 4,
            name: 'region',
            lines: 19,
            titleEditable: 'test-edit-4'
          },
          {
            add: true,
            nb: 6,
            name: 'epci',
            lines: 1266,
            titleEditable: 'test-edit-6'
          }
        ],
        url: 'https://www.data.gouv.fr/api/1/datasets/r/0abf0b26-317f-4055-a0e3-8f4ea772853e'
      },
      tmpDir: 'test-data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
  })

  // We've kept the file dataset test in the comments, as it's too large for local testing.
  /**
  it('should run a task with a gpkg file to create a file dataset', async function () {
    const context = testUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: {
          editableCreate: false
        },
        layers: [
          {
            add: true,
            nb: 2,
            name: 'commune',
            lines: 34877,
            titleEditable: 'test-file-2'
          },
          {
            add: true,
            nb: 4,
            name: 'region',
            lines: 19,
            titleEditable: 'test-file-4'
          },
          {
            add: true,
            nb: 6,
            name: 'epci',
            lines: 1266,
            titleEditable: 'test-file-6'
          }
        ]
        url: 'https://www.data.gouv.fr/api/1/datasets/r/0abf0b26-317f-4055-a0e3-8f4ea772853e'
      },
      tmpDir: 'test-data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
  })
  */

  // We've kept the zip test in the comments, as it's too large for local testing.
  /**
  it('should run a task with a zip file', async function () {
    const context = testUtils.context({
      pluginConfig: {},
      processingConfig: {
        datasetMode: 'create',
        dataset: {
          editableCreate: true
        },
        layers: [
          {
            add: true,
            nb: 1,
            name: 'circonscritptions_lgislatives_74',
            lines: 6,
            titleEditable: 'test-zip'
          }
        ]
        url: 'https://www.data.gouv.fr/api/1/datasets/r/26c5be7d-56d2-4d1f-a9ce-b800f0b0f16e',
        listIdsLayers: '1'
      },
      tmpDir: 'test-data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
  })
  */
})
