import config from '#config'
import { strict as assert } from 'node:assert'
import { it, describe, after } from 'node:test'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as gpkgPlugin from '../index.ts'

import processingConfigSchema from '../processing-config-schema.json' with { type: 'json' }

const url = 'https://www.data.gouv.fr/api/1/datasets/r/0abf0b26-317f-4055-a0e3-8f4ea772853e'

// data-fair indexes bulk lines asynchronously without changing the dataset status,
// dropping a dataset during this indexing puts it in error, so wait for the expected line count
const waitIndexed = async (axios: any, datasetId: string, expected: number) => {
  for (let i = 0; i < 30; i++) {
    const { total } = (await axios.get(`api/v1/datasets/${datasetId}/lines`, { params: { size: 0 } })).data
    if (total === expected) return
    await new Promise(resolve => setTimeout(resolve, 2000))
  }
  assert.fail(`dataset ${datasetId} was not indexed with ${expected} lines`)
}

/**
 * Lists the layers of a file, creates editable datasets from some of them, then updates these datasets.
 */
describe('Geopackage processing', () => {
  // config produced by the create test, reused by the update test
  let createdConfig: any
  let axios: any
  const createdIds: string[] = []

  after(async () => {
    for (const id of createdIds) await axios.delete(`api/v1/datasets/${id}`)
  })

  // Each plugin should expose a processing config schema

  it('should expose a processing config schema for users', async () => {
    assert.equal(processingConfigSchema.type, 'object')
  })

  it('should display the layers of a gpkg file', async () => {
    const context = testUtils.context({
      processingConfig: {
        datasetMode: 'list',
        url,
      },
      tmpDir: 'data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'create')
    assert.ok(context.processingConfig.layers.some((l: any) => l.name === 'commune'))
  })

  it('should run a task with a gpkg file to create an edit dataset', async function () {
    // WARNING !!!
    console.warn('Bulk_lines errors may appear (undefined). This is a 413 (Request Entity Too Large) error, which is not acceptable locally.')
    console.warn('To fix this, you need to change the BATCH_SIZE variable in stream-layer.ts.')

    // small layers only: the commune layer (35k polygons) takes several minutes to be indexed on staging
    const context = testUtils.context({
      processingConfig: {
        datasetMode: 'create',
        dataset: {
          editableCreate: true
        },
        layers: [
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
        url
      },
      tmpDir: 'data/'
    }, config, false)
    axios = context.axios

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.datasets.length, 2)
    createdIds.push(...context.processingConfig.datasets.map((d: any) => d.dataset.id))
    for (const { dataset, layer } of context.processingConfig.datasets) {
      await waitIndexed(axios, dataset.id, context.processingConfig.layers.find((l: any) => l.nb === layer.nb).lines)
    }
    createdConfig = context.processingConfig
  })

  it('should run a task with a gpkg file to update an edit dataset', async function () {
    assert.ok(createdConfig, 'the create test must succeed first')
    const context = testUtils.context({ processingConfig: createdConfig, tmpDir: 'data/' }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    for (const { dataset, layer } of createdConfig.datasets) {
      await waitIndexed(axios, dataset.id, createdConfig.layers.find((l: any) => l.nb === layer.nb).lines)
    }
  })

  // We've kept the file dataset test in the comments, as it's too large for local testing.
  /**
  it('should run a task with a gpkg file to create a file dataset', async function () {
    const context = testUtils.context({
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
        ],
        url
      },
      tmpDir: 'data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
  })
  */

  // We've kept the zip test in the comments, as it's too large for local testing.
  /**
  it('should run a task with a zip file', async function () {
    const context = testUtils.context({
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
        ],
        url: 'https://www.data.gouv.fr/api/1/datasets/r/26c5be7d-56d2-4d1f-a9ce-b800f0b0f16e'
      },
      tmpDir: 'data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
  })
  */
})
