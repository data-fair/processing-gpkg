import type { RunFunction } from '@data-fair/lib-common-types/processings.js'
import type { CreateDatasets, ProcessingConfig, Parameters, UpdateDatasets, ExistingDataset } from '#types/processingConfig/index.ts'
import { formatBytes } from '@data-fair/lib-utils/format/bytes.js'

import util from 'util'
import fs from 'fs-extra'
import path from 'path'
import FormData from 'form-data'

import type { LayersList, GpkgProcessingContext } from './context.ts'
import { fetchHTTP } from './fetch.ts'
import { createTmpFile, removeSymlinks } from './tmp-file.ts'
import { runCommand, getOgrEnv } from './spawn-process.ts'
import { addUpdate, displayingProgress, nbUpdate, resetTracking, trackAddLayer, trackFinalization, trackUpdateSchema, type PendingFinalization } from './track.ts'
import { normalizedSRS } from './utils/normalizeSRS.ts'
import { dfRetry } from './retry.ts'

/**
 * Allows for a requested program shutdown to be scheduled.
 *
 * `stopSignal` is a promise that resolves the moment `stop()` is called. Long-running
 * waiters (typically `ws.waitForJournal` in phase 2) race against it so they can bail
 * out immediately instead of timing out after several minutes.
 */
let shouldBeStopped = false
let stopSignal: Promise<void> = new Promise(() => {})
let resolveStop: () => void = () => {}

export const stop: () => Promise<void> = async () => {
  shouldBeStopped = true
  resolveStop()
}

/**
 * POST a GeoJSON file to data-fair as a multipart form. The form is rebuilt on every
 * attempt of the retry: the file stream it holds can only be read once.
 */
const sendFile = async (axios: GpkgProcessingContext['axios'], log: GpkgProcessingContext['log'], url: string, filePath: string, fields: Record<string, string>, creates = false) => {
  return await dfRetry(async () => {
    const formData = new FormData()
    for (const [key, value] of Object.entries(fields)) formData.append(key, value)
    formData.append('file', fs.createReadStream(filePath), { filename: path.basename(filePath) })
    const getLength = util.promisify(formData.getLength.bind(formData))
    const contentLength = await getLength()
    await log.info(`Uploading ${formatBytes(contentLength!, 'en')}`)
    return await axios({
      method: 'post',
      url,
      data: formData,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      headers: { ...formData.getHeaders(), 'content-length': contentLength }
    })
  }, log, { label: `POST ${url}`, creates })
}

type GeometrySRS = { haveSRS: boolean, SRS: string }
type LayersFieldList = Record<number, { name: string, fields: any[], featureCount: number, haveSRS: boolean, geometrySRS?: GeometrySRS }>

/**
 * Input function, allows data processing to begin
 * @param context Context of the request
 */
export const run: RunFunction<ProcessingConfig> = async (context) => {
  shouldBeStopped = false
  stopSignal = new Promise<void>(resolve => { resolveStop = resolve })
  resetTracking()

  try {
    // Retrieving the contextual elements necessary for processing
    const { processingConfig, patchConfig } = context
    const tmpFile = await download(context)

    if (shouldBeStopped) return
    if (!tmpFile) return
    const layersFieldList = await extraction(context, tmpFile)

    if (shouldBeStopped) return
    if (!layersFieldList) return

    if (processingConfig.datasetMode === 'create') {
      const result = await createDatasets(context, layersFieldList, tmpFile)

      if (result?.updateConfig?.length) await patchConfig({ datasetMode: 'update', datasets: result.updateConfig, layers: result.layersList, url: processingConfig.url.trim() } as any)
    } else if (processingConfig.datasetMode === 'update') {
      await updateDatasets(context, layersFieldList, tmpFile)
      await patchConfig({ url: processingConfig.url.trim() } as any)
    } else {
      const createConfig: LayersList[] = Object.keys(layersFieldList).map(idLayer => ({
        add: false,
        nb: Number(idLayer),
        name: layersFieldList[Number(idLayer)].name,
        lines: layersFieldList[Number(idLayer)].featureCount,
        titleEditable: '',
        titleReadOnly: '',
        haveSRS: layersFieldList[Number(idLayer)].haveSRS,
        SRS: ''
      }))

      await patchConfig({ datasetMode: 'create', haveList: true, layers: createConfig, dataset: { editableCreate: false }, url: processingConfig.url.trim() } as any)
    }
  } finally {
    // nothing is uploaded after a stop, but an editable dataset that was being filled keeps
    // the lines already sent: a new run refills it
    if (shouldBeStopped) await context.log.warning('Processing interrupted. Nothing more was uploaded, but an editable dataset that was being filled may be incomplete: run the processing again to refill it.')
    // Settle the stop signal so any continuation chained on it (the `stopSignal.then(...)`
    // branches inside `trackFinalization`) is released. At this point all the relevant
    // `Promise.race` calls have already resolved via the journal branch, so this late
    // resolution is a no-op behaviour-wise — it only frees handlers.
    resolveStop()
  }
}

/**
 * Allows you to download the file and place it in a temporary folder for later processing.
 * We only process .zip and .gpkg formats; any other format will result in an error.
 * @param processingConfig  Processing configuration, obtained from the form data (processing-config-schema.json)
 * @param tmpDir            Directory where to download the file
 * @param axios             Server for API requests
 * @param log               Log system that is displayed on the user interface
 * @returns Full path of the file to be processed
 */
const download = async ({ processingConfig, tmpDir, axios, log } : GpkgProcessingContext) => {
  await fs.ensureDir(tmpDir)

  await log.step('Downloading the file')
  let tmpFile = path.join(tmpDir, 'file')
  await fs.ensureFile(tmpFile)
  if (shouldBeStopped) return

  const url = new URL(processingConfig.url.trim())
  let filename = decodeURIComponent(path.basename(url.pathname))
  if (shouldBeStopped) return

  filename = await fetchHTTP(processingConfig, tmpFile, axios) || filename
  if (shouldBeStopped) return

  // Try to prevent weird bug with NFS by forcing syncing file before reading it
  const fd = await fs.open(tmpFile, 'r')
  await fs.fsync(fd)
  await fs.close(fd)
  await log.info(`File downloaded (${filename})`)
  if (shouldBeStopped) return

  let gpkgFilename

  // Check the file format
  if (filename.toLowerCase().endsWith('.zip')) {
    await log.info(`Unzipping ${filename}`)

    // Unzip
    await runCommand('unzip', ['-o', '-j', tmpFile, '-d', `${tmpFile}-dezip`])
    await removeSymlinks(`${tmpFile}-dezip`)

    // We are looking for the .gpkg files contained in the .zip file.
    const filesGpkg: string[] = []
    const files = await fs.readdir(`${tmpFile}-dezip`)
    for (const file of files) {
      if (file.toLowerCase().endsWith('.gpkg')) {
        filesGpkg.push(`${tmpFile}-dezip/${file}`)
      }
    }

    const nbFiles = filesGpkg.length
    if (shouldBeStopped) return

    if (nbFiles <= 0) {
      throw new Error('The zip archive contains no .gpkg file.')
    } else {
      // We keep the first .gpkg file we find, we ignore the others
      gpkgFilename = path.basename(filesGpkg[0])
      tmpFile = filesGpkg[0]
    }
  } else if (filename.toLowerCase().endsWith('.gpkg')) {
    gpkgFilename = filename
  } else {
    throw new Error(`Unsupported file format (${filename}): only .gpkg files and .zip archives containing one are accepted.`)
  }

  await log.info(`Processing ${gpkgFilename}`)

  return tmpFile
}

/**
 * Allows you to retrieve the layers of a file and organize their structure
 * @param log       Log system that is displayed on the user interface
 * @param tmpFile   Full path of the file to be processed
 * @returns Dictionary of available layer structures (id: {name, fields, featureCount})
 */
const extraction = async ({ log }: GpkgProcessingContext, tmpFile : string) => {
  await log.step('Reading the structure of the layers')

  // Display layers
  const proc = await runCommand('ogrinfo', ['-if', 'GPKG', '-al', '-so', '-json', tmpFile], { env: getOgrEnv() })
  if (shouldBeStopped) return

  const result = proc.stdout
  const jsonStructure = JSON.parse(result)
  if (shouldBeStopped) return

  const layers = jsonStructure.layers
  const layersFieldList: LayersFieldList = {}

  for (let i = 0; i < layers.length; i++) {
    // Layers fields
    let error = false
    for (let j = 0; j < layers[i].fields.length; j++) {
      if (shouldBeStopped) return

      if (!layers[i].fields[j].type) {
        await log.warning(`The field ${layers[i].fields[j].name} of the layer ${i + 1} - ${layers[i].name} has no type, the layer is skipped`)
        error = true
        break
      }

      let typeCorrect = layers[i].fields[j].type.toLowerCase()
      let format

      // Check the types
      if (typeCorrect.includes('integer')) {
        typeCorrect = 'integer'
      }

      if (typeCorrect.includes('real')) {
        typeCorrect = 'number'
      }

      if (typeCorrect.includes('date')) {
        typeCorrect = 'string'
        format = 'date'
      }

      if (layers[i].fields[j].subType && layers[i].fields[j].subType.toLowerCase().includes('boolean')) {
        typeCorrect = 'boolean'
      }

      layers[i].fields[j] = {
        ...layers[i].fields[j],
        key: layers[i].fields[j].name,
        type: typeCorrect,
        format,
        'x-transform': { type: typeCorrect, format }
      }
    }

    if (!error && !layers[i].geometryFields?.length) {
      await log.warning(`The layer ${i + 1} - ${layers[i].name} has no geometry, it is skipped`)
    } else if (!error) {
      // Adding geometries
      layers[i].fields.push({
        title: 'geometry',
        name: 'geometry',
        key: 'geometry',
        type: 'string',
        'x-refersTo': 'https://purl.org/geojson/vocab#geometry',
        'x-capabilities': {
          textAgg: false
        }
      })

      // SRS
      const coordinateSystem = layers[i].geometryFields[0].coordinateSystem.wkt
      const srsDefined = !coordinateSystem.includes('Undefined SRS')

      await log.info(`Layer ${i + 1} - ${layers[i].name} - ${layers[i].featureCount} lines`)
      if (!srsDefined) {
        await log.warning(`The file defines no SRS (spatial reference system of the geometries) for the layer ${i + 1} - ${layers[i].name}: set it in the SRS field of the layer (File layers tab)`)
      }

      layersFieldList[i + 1] = { name: layers[i].name, fields: layers[i].fields, featureCount: layers[i].featureCount, haveSRS: srsDefined }
    }
  }

  return layersFieldList
}

/**
 * Allows you to create the requested layer datasets
 * @param processingConfig  Processing configuration, obtained from the form data (processing-config-schema.json)
 * @param processingId      Identifier of the processing currently in use
 * @param axios             Server for API requests
 * @param tmpDir            Directory where to download temporary files
 * @param log               Log system that is displayed on the user interface
 * @param ws                Data Fair's Websocket allows retrieving the dataset response.
 * @param layersFieldList   Dictionary containing the structure of the file's layers (id: {name, fields, featureCount})
 * @param tmpFile           Full path of the file to be processed
 * @returns   A list of objects associating layers and datasets, or nothing at all to stop the program
 */
const createDatasets = async ({ processingConfig: rawConfig, processingId, axios, tmpDir, log } : GpkgProcessingContext, layersFieldList: LayersFieldList, tmpFile: string) => {
  const processingConfig = rawConfig as CreateDatasets & Parameters
  await log.step('Creating the datasets')

  const layersList: LayersList[] = []

  for (let layer of processingConfig.layers as LayersList[]) {
    if (layer.add || processingConfig.addAllLayers) {
      layer = {
        ...layer,
        add: true,
        SRS: normalizedSRS(layer.SRS),
        title: layer.titleEditable || layer.name || 'untitled',
        titleReadOnly: layer.titleEditable || layer.name || 'untitled'
      }
    }
    layersList.push(layer)
  }

  const layersListCreate: LayersList[] = []
  const updateConfig = []
  let idStream = 0
  const streamPendingFinalizations: PendingFinalization[] = []

  // SECURITY (normally not necessary) : Checking the availability of the layers (in the event that the download URL has been changed accidentally)
  for (const layer of layersList) {
    if (layer.add) {
      const idLayer = layer.nb
      const nameLayer = layer.name
      if (!(idLayer in layersFieldList && layersFieldList[idLayer].name === nameLayer)) {
        await log.warning(`The layer ${idLayer} - ${nameLayer} is not in the file, it is skipped (has the URL changed?)`)
      } else {
        layersListCreate.push(layer)
      }
    }
  }

  // If there are no layers to extract, we stop here to simplify the display of logs on the interface.
  if (layersListCreate.length <= 0) {
    await log.warning('No layer selected, nothing to create')
    return
  }

  await log.info(`Extracting the layers ${layersListCreate.map(layer => (`${layer.nb} - ${layer.name}`)).join(', ')}`)

  // A stop interrupts the loop but the datasets created so far are still returned, so that
  // the config is switched to update mode and the next run refills them instead of
  // creating duplicates
  for (const layer of layersListCreate) {
    if (shouldBeStopped) break

    await log.info('---')
    await log.info(`Creating the dataset of the layer ${layer.nb} - ${layersFieldList[layer.nb].name}`)

    let dataset : { id: string, title: string, href: string, page: string }

    if (processingConfig.dataset!.editableCreate) {
      const fields = layersFieldList[layer.nb].fields

      // Display names and types of the fields for debug
      await log.debug(`   Fields: ${fields.map(f => `${f.key} (${f.type})`).join(', ')}`)

      // Create the dataset, empty
      dataset = (await dfRetry(() => axios.post('api/v1/datasets', {
        title: `${layer.title}`,
        description: '',
        isRest: true,
        schema: fields,
        origin: processingConfig.url,
        extras: { processingId }
      }), log, { label: 'POST api/v1/datasets', creates: true })).data
      await log.info(`   Dataset created, id="${dataset.id}", title="${dataset.title}"`)
      updateConfig.push({ dataset: { id: dataset.id, href: dataset.href, title: dataset.title }, layer: { nb: layer.nb, name: layer.name } })

      if (shouldBeStopped) break

      // Dataset population
      idStream += 1
      const streamInformation = { idStream, tmpFile, layerName: layer.name, featureCount: layer.lines, layerSRSDefined: layer.haveSRS, layerSRS: layer.SRS, stop: () => shouldBeStopped }
      streamPendingFinalizations.push(trackAddLayer(axios, log, dataset.id, dataset.title, streamInformation, stopSignal))
    } else {
      const tmpFileGeoJSON = await createTmpFile(tmpDir, tmpFile, layer.name, layer.haveSRS, layer.SRS, log, () => shouldBeStopped)
      if (shouldBeStopped) break
      if (!tmpFileGeoJSON) continue

      dataset = (await sendFile(axios, log, 'api/v1/datasets', tmpFileGeoJSON, { origin: processingConfig.url, title: layer.title! }, true)).data
      await log.info(`   Dataset created, id="${dataset.id}", title="${dataset.title}"`)
      updateConfig.push({ dataset: { id: dataset.id, href: dataset.href, title: dataset.title }, layer: { nb: layer.nb, name: layer.name } })
    }
  }

  if (streamPendingFinalizations.length > 0) {
    await Promise.allSettled(streamPendingFinalizations.map(p => p.promise))
  }

  return { layersList, updateConfig }
}

/**
 * Allows updating a dataset, either by force (schema reset) or by non-force (data replacement).
 * @param processingConfig  Processing configuration, obtained from the form data (processing-config-schema.json)
 * @param axios             Server for API requests
 * @param tmpDir            Directory where to download temporary files
 * @param log               Log system that is displayed on the user interface
 * @param ws                Data Fair's Websocket allows retrieving the dataset response.
 * @param layersFieldList   Dictionary containing the structure of the file's layers (id: {name, fields, featureCount})
 * @param tmpFile           Full path of the file to be processed
 * @returns   Returns nothing, used to stop the program
 */
const updateDatasets = async ({ processingConfig: rawConfig, axios, tmpDir, log, ws } : GpkgProcessingContext, layersFieldList: LayersFieldList, tmpFile: string) => {
  const processingConfig = rawConfig as UpdateDatasets
  await log.step('Updating the datasets')

  // If there are no updates to extract, we stop here to simplify the display of logs on the interface.
  if (!processingConfig.datasets || processingConfig.datasets.length <= 0) {
    await log.warning('No dataset to update in the configuration')
    return
  }

  for (const layer of (processingConfig.layers ?? []) as LayersList[]) {
    if (!(layer.nb in layersFieldList)) continue
    layersFieldList[layer.nb] = {
      ...layersFieldList[layer.nb],
      geometrySRS: {
        haveSRS: layer.haveSRS,
        SRS: normalizedSRS(layer.SRS)
      },
    }
  }

  // We check whether we need to process a file or editable dataset.
  const datasetsUpdate = []

  for (const update of processingConfig.datasets) {
    if (!update.dataset.id || !update.dataset.title) {
      await log.warning('A dataset of the configuration is incomplete (missing id or title), it is skipped')
      await log.info('')
      continue
    }

    let targetDataset
    try {
      targetDataset = (await axios.get(`api/v1/datasets/${update.dataset.id}`)).data
    } catch (err : any) {
      if ((err.status ?? err.response?.status) === 404) {
        await log.warning(`The dataset ${update.dataset.title} (${update.dataset.id}) does not exist, it may have been deleted`)
      } else {
        await log.warning(`The dataset ${update.dataset.title} (${update.dataset.id}) could not be read (${err.status ?? err.response?.status ?? err.message}), it is skipped`)
      }
      await log.info('')
      continue
    }

    // SECURITY (normally not necessary) : Checking the availability of the layers (in the event that the download URL has been changed accidentally)
    if (!(update.layer.nb! in layersFieldList && update.layer.name! === layersFieldList[update.layer.nb!].name)) {
      await log.warning(`The layer ${update.layer.nb} - ${update.layer.name} is not in the file, the dataset ${update.dataset.title} is skipped (has the URL changed?)`)
      await log.info('')
      continue
    }

    const goodUpdate = {
      ...update,
      editable: targetDataset.isRest ?? false
    }
    datasetsUpdate.push(goodUpdate)
  }

  const pendingFinalizations: PendingFinalization[] = []
  const updatePendingFinalizations: PendingFinalization[] = []
  const updateProgressName = 'Waiting for the schema updates to be finalized'
  const listUpdatesDatasets: { [k: string]: unknown, forceUpdate?: boolean, dataset: ExistingDataset, layer: { nb?: number, name?: string } }[] = []
  // datasets whose drop / schema update failed: sending lines to them would only mix old and new data
  const failedDatasets = new Set<string>()

  for (const update of datasetsUpdate) {
    // Schema verification
    if (shouldBeStopped) return

    const dataset = update.dataset
    const idLayer = update.layer.nb!
    const nameLayer = update.layer.name!
    const editable = update.editable

    if (editable) {
      // Retrieving the dataset schema
      const datasetSchema : { key: string, type: string }[] = (await axios.get(`api/v1/datasets/${dataset.id}`)).data.schema
      if (shouldBeStopped) return

      if (update.forceUpdate) {
        await log.info(`Forced schema update of the dataset ${dataset.title}`)

        const updateSchema = async () => {
          // Drop the old data
          await dfRetry(() => axios.post(`api/v1/datasets/${dataset.id}/_bulk_lines?drop=true`, []), log, { label: `POST api/v1/datasets/${dataset.id}/_bulk_lines`, creates: true })
          if (shouldBeStopped) return

          // We are waiting for the dataset to finish processing.
          // We are certain of the ID and title definitions with the previous check.
          await ws.waitForJournal(dataset.id!, 'finalize-end')

          // Update the schema
          const updateDataset = await dfRetry(() => axios.post(`api/v1/datasets/${dataset.id}`, {
            schema: layersFieldList[idLayer].fields,
            origin: processingConfig.url
          }), log, { label: `POST api/v1/datasets/${dataset.id}` })
          if (shouldBeStopped) return

          if (updateDataset.data.status !== 'finalized') {
            pendingFinalizations.push(trackFinalization(ws, log, dataset.id!, dataset.title!, { successMessage: 'is finalized' },
              { name: updateProgressName, total: processingConfig.datasets!.length, progressType: 'update' }, stopSignal))
          } else {
            pendingFinalizations.push(addUpdate(log, updateProgressName, processingConfig.datasets!.length, dataset.id!, dataset.title!, stopSignal))
          }
        }

        // We are certain of the ID and title definitions with the previous check.
        updatePendingFinalizations.push(trackUpdateSchema(log, dataset.id!, dataset.title!, updateSchema, stopSignal))

        listUpdatesDatasets.push(update)
      } else {
        // Check if the schemas match.
        await log.info(`Checking that the schema of the dataset ${dataset.title} matches the layer ${idLayer} - ${nameLayer}`)

        let compatible = true
        const datasetSchemaMap = new Map(datasetSchema.map(datasetField => [datasetField.key.toLowerCase(), datasetField.type.toLowerCase()]))
        // We don't establish equality in both directions because of the attributes added during the processing of the dataset, such as the update date, for example.
        for (const field of layersFieldList[idLayer].fields) {
          if (shouldBeStopped) return

          const typeFieldDataset = datasetSchemaMap.get(field.name.toLowerCase())
          await log.debug(`Type field dataset : ${typeFieldDataset} - File : ${field.name} ${field.type}`)

          if (typeFieldDataset !== field.type.toLowerCase()) {
            compatible = false
            break
          }
        }

        if (compatible) {
          listUpdatesDatasets.push(update)

          // Drop the old data
          if (shouldBeStopped) return
          const updateSchema = async () => {
            await dfRetry(() => axios.post(`api/v1/datasets/${dataset.id}/_bulk_lines?drop=true`, []), log, { label: `POST api/v1/datasets/${dataset.id}/_bulk_lines`, creates: true })

            pendingFinalizations.push(trackFinalization(ws, log, dataset.id!, dataset.title!, { successMessage: 'is finalized' },
              { name: updateProgressName, total: processingConfig.datasets!.length, progressType: 'update' }, stopSignal))
          }

          // We are certain of the ID and title definitions with the previous check.
          updatePendingFinalizations.push(trackUpdateSchema(log, dataset.id!, dataset.title!, updateSchema, stopSignal))
        } else {
          await log.warning(`The schema of the dataset ${dataset.title} does not match the layer ${idLayer} - ${nameLayer}, the dataset is not updated (enable "Force schema update" to replace its schema)`)
          await log.info('')
          pendingFinalizations.push(addUpdate(log, updateProgressName, processingConfig.datasets!.length, dataset.id!, dataset.title!, stopSignal))
          continue
        }
      }
    } else {
      if (update.forceUpdate) {
        await log.info(`Forced schema update of the dataset ${dataset.title}`)
      }
      listUpdatesDatasets.push(update)
    }
  }

  // Wait for all schema updates to complete before updating data
  if (updatePendingFinalizations.length > 0 || pendingFinalizations.length > 0) {
    displayingProgress()
    await log.task(updateProgressName)
    await log.progress(updateProgressName, nbUpdate, updatePendingFinalizations.length)

    // pendingFinalizations is filled while updatePendingFinalizations settle, so they are read in this order
    for (const list of [updatePendingFinalizations, pendingFinalizations]) {
      for (const p of list) {
        if (!(await p.promise).ok) failedDatasets.add(p.datasetId)
      }
    }
    displayingProgress(false)

    await log.info('')
    await log.info('---')
  }

  const streamPendingFinalizations: PendingFinalization[] = []
  let idStream = 0

  // We process each dataset to be updated
  for (const update of listUpdatesDatasets) {
    if (shouldBeStopped) return

    const dataset = update.dataset
    const idLayer = update.layer.nb!
    const nameLayer = update.layer.name!
    const editable = update.editable
    const layerSRSDefined = layersFieldList[idLayer].geometrySRS?.haveSRS ?? layersFieldList[idLayer].haveSRS
    const layerSRS = layersFieldList[idLayer].geometrySRS?.SRS ?? ''

    await log.info('')
    if (failedDatasets.has(dataset.id!)) {
      await log.warning(`The dataset ${dataset.title} is not updated: deleting its previous lines or updating its schema failed`)
      continue
    }
    await log.info(`Updating the dataset ${dataset.title} with the layer ${idLayer} - ${nameLayer}`)

    // Data update
    if (editable) {
      idStream += 1

      const streamInformation = {
        idStream,
        tmpFile,
        layerName: layersFieldList[idLayer].name,
        featureCount: layersFieldList[idLayer].featureCount,
        layerSRSDefined,
        layerSRS,
        stop: () => shouldBeStopped
      }

      streamPendingFinalizations.push(trackAddLayer(axios, log, dataset.id!, dataset.title!, streamInformation, stopSignal))
      await log.info('')
    } else {
      const tmpFileGeoJSON = await createTmpFile(tmpDir, tmpFile, layersFieldList[idLayer].name, layerSRSDefined, layerSRS, log, () => shouldBeStopped)
      if (shouldBeStopped) return
      if (!tmpFileGeoJSON) continue

      await sendFile(axios, log, `api/v1/datasets/${dataset.id}${update.forceUpdate ? '' : '?draft=true'}`, tmpFileGeoJSON, { origin: processingConfig.url as string })

      if (shouldBeStopped) return

      await log.info('File uploaded')
      await log.info('')
    }
  }

  if (streamPendingFinalizations.length > 0) {
    await Promise.allSettled(streamPendingFinalizations.map(p => p.promise))
  }
}
