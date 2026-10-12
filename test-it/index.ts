import config from '#config'
import { strict as assert } from 'node:assert'
import { it, describe, before, after } from 'node:test'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import testUtils from '@data-fair/lib-processing-dev/tests-utils.js'
import * as gpkgPlugin from '../index.ts'

import processingConfigSchema from '../processing-config-schema.json' with { type: 'json' }

/*
 * Small fixtures built from the data.gouv.fr admin-express file
 * (https://www.data.gouv.fr/api/1/datasets/r/0abf0b26-317f-4055-a0e3-8f4ea772853e):
 *   ogr2ogr -f GPKG -simplify 0.01 test.gpkg big.gpkg region
 *   ogr2ogr -f GPKG -update -simplify 0.01 test.gpkg big.gpkg departement -where "insee_reg = '53'"
 *   ogr2ogr -f GPKG -update test.gpkg big.gpkg -sql "SELECT id, nom, nature FROM epci LIMIT 5" -nln no_geometry
 *   zip test.zip test.gpkg
 * Layers: 1 - region (19 lines), 2 - departement (4 lines), 3 - no_geometry (5 lines, no geometry).
 */
const fixturesDir = path.join(import.meta.dirname, 'fixtures')

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
 * Lists the layers of a file, creates datasets from some of them, then updates these datasets.
 */
describe('Geopackage processing', () => {
  // serves the fixtures, the plugin only downloads files over HTTP
  const server = http.createServer((req, res) => {
    fs.createReadStream(path.join(fixturesDir, path.basename(req.url!)))
      .on('error', () => res.writeHead(404).end())
      .pipe(res)
  })
  let baseUrl: string

  // config produced by the create test, reused by the update test
  let createdConfig: any
  let axios: any
  const createdIds: string[] = []

  before(async () => {
    // the worker gives each run a fresh tmpDir, files left by a previous test run make unzip prompt
    fs.rmSync('data', { recursive: true, force: true })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  after(async () => {
    server.close()
    for (const id of createdIds) await axios.delete(`api/v1/datasets/${id}`)
  })

  // Each plugin should expose a processing config schema
  it('should expose a processing config schema for users', async () => {
    assert.equal(processingConfigSchema.type, 'object')
  })

  it('should display the layers of a gpkg file', async () => {
    const context = testUtils.context({
      processingConfig: { datasetMode: 'list', url: `${baseUrl}/test.gpkg` },
      tmpDir: 'data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'create')
    // the layer without geometry is skipped
    assert.deepEqual(context.processingConfig.layers.map((l: any) => l.name), ['region', 'departement'])
  })

  it('should display the layers of a gpkg file inside a zip', async () => {
    const context = testUtils.context({
      processingConfig: { datasetMode: 'list', url: `${baseUrl}/test.zip` },
      tmpDir: 'data/'
    }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.layers.length, 2)
  })

  it('should run a task with a gpkg file to create an edit dataset', async function () {
    const context = testUtils.context({
      processingConfig: {
        datasetMode: 'create',
        dataset: { editableCreate: true },
        layers: [
          { add: true, nb: 1, name: 'region', lines: 19, titleEditable: 'test-gpkg-edit' }
        ],
        url: `${baseUrl}/test.gpkg`
      },
      tmpDir: 'data/'
    }, config, false)
    axios = context.axios

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    assert.equal(context.processingConfig.datasets.length, 1)
    const datasetId = context.processingConfig.datasets[0].dataset.id
    createdIds.push(datasetId)
    await waitIndexed(axios, datasetId, 19)
    createdConfig = context.processingConfig
  })

  it('should run a task with a gpkg file to update an edit dataset', async function () {
    assert.ok(createdConfig, 'the create test must succeed first')
    const context = testUtils.context({ processingConfig: createdConfig, tmpDir: 'data/' }, config, false)

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    await waitIndexed(axios, createdConfig.datasets[0].dataset.id, 19)
  })

  it('should run a task with a gpkg file to create a file dataset', async function () {
    const context = testUtils.context({
      processingConfig: {
        datasetMode: 'create',
        dataset: { editableCreate: false },
        layers: [
          { add: true, nb: 2, name: 'departement', lines: 4, titleEditable: 'test-gpkg-file' }
        ],
        url: `${baseUrl}/test.gpkg`
      },
      tmpDir: 'data/'
    }, config, false)
    axios = context.axios

    await gpkgPlugin.run(context)
    assert.equal(context.processingConfig.datasetMode, 'update')
    createdIds.push(context.processingConfig.datasets[0].dataset.id)
  })
})
