import type { RunFunction } from '@data-fair/lib-common-types/processings.js'
import type { CreateDatasets, ProcessingConfig, Parameters, UpdateDatasets, ExistingDataset } from '#types/processingConfig/index.ts'
import { formatBytes } from '@data-fair/lib-utils/format/bytes.js'

import util from 'util'
import fs from 'fs-extra'
import path from 'path'
import FormData from 'form-data'

import type { LayersList, GpkgProcessingContext } from './context.ts'
import { fetchHTTP } from './fetch.ts'
import { createTmpFile } from './tmp-file.ts'
import { runCommand } from './spawn-process.ts'
import { addUpdate, displayingProgress, nbUpdate, trackAddLayer, trackFinalization, trackUpdateSchema, type PendingFinalization } from './track.ts'
import { normalizedSRS } from './utils/normalizeSRS.ts'

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

type GeometrySRS = { haveSRS: boolean, SRS: string }
type LayersFieldList = Record<number, { name: string, fields: any[], featureCount: number, haveSRS: boolean, geometrySRS?: GeometrySRS }>

/**
 * Input function, allows data processing to begin
 * @param context Context of the request
 */
export const run: RunFunction<ProcessingConfig> = async (context) => {
  shouldBeStopped = false
  stopSignal = new Promise<void>(resolve => { resolveStop = resolve })

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

  await log.step('Téléchargement du fichier')
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
  await log.info(`Le fichier a été téléchargé (${filename})`)
  if (shouldBeStopped) return

  let gpkgFilename

  // Check the file format
  if (filename.toLowerCase().endsWith('.zip')) {
    await log.info(`Dézippage du fichier ${filename}`)

    // Unzip
    await runCommand('unzip', ['-j', tmpFile, '-d', `${tmpFile}-dezip`])

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
      throw new Error('Il n\'y a pas de fichiers .gpkg à traiter dans ce zip.')
    } else {
      // We keep the first .gpkg file we find, we ignore the others
      gpkgFilename = path.basename(filesGpkg[0])
      tmpFile = filesGpkg[0]
    }
  } else if (filename.toLowerCase().endsWith('.gpkg')) {
    gpkgFilename = filename
  } else {
    throw new Error('Le format n\'est pas pris en charge')
  }

  await log.info(`Traitement du fichier ${gpkgFilename}`)

  return tmpFile
}

/**
 * Allows you to retrieve the layers of a file and organize their structure
 * @param log       Log system that is displayed on the user interface
 * @param tmpFile   Full path of the file to be processed
 * @returns Dictionary of available layer structures (id: {name, fields, featureCount})
 */
const extraction = async ({ log }: GpkgProcessingContext, tmpFile : string) => {
  await log.step('Récupération de la structure des données')

  // Display layers
  const proc = await runCommand('ogrinfo', ['-al', '-so', '-json', tmpFile])
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
        await log.warning(`Pas de type pour l'attribut ${layers[i].fields[j].name} de la couche ${i + 1} - ${layers[i].name}`)
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

    if (!error) {
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

      await log.info(`Couche ${i + 1} - ${layers[i].name} - ${layers[i].featureCount} lignes`)
      if (!srsDefined) {
        await log.warning(`Le SRS (le système de référence spatiale pour le traitement des géométries) n'est pas défini dans le fichier pour la couche ${i + 1} - ${layers[i].name}`)
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
const createDatasets = async ({ processingConfig: rawConfig, processingId, axios, tmpDir, log, ws } : GpkgProcessingContext, layersFieldList: LayersFieldList, tmpFile: string) => {
  const processingConfig = rawConfig as CreateDatasets & Parameters
  await log.step('Construction des jeux de données')

  const layersList: LayersList[] = []

  for (let layer of processingConfig.layers as LayersList[]) {
    if (layer.add || processingConfig.addAllLayers) {
      layer = {
        ...layer,
        SRS: normalizedSRS(layer.SRS),
        title: layer.titleEditable ?? (layer.name ?? 'untitled'),
        titleReadOnly: layer.titleEditable ?? (layer.name ?? 'untitled')
      }
      layersList.push(layer)
    }
  }

  // If there are no layers to extract, we stop here to simplify the display of logs on the interface.
  if (layersList.length <= 0) {
    await log.warning('Pas de couches renseignées')
    return
  }

  const layersListCreate: LayersList[] = []
  const updateConfig = []
  let idStream = 0
  const streamPendingFinalizations: PendingFinalization[] = []

  // SECURITY (normally not necessary) : Checking the availability of the layers (in the event that the download URL has been changed accidentally)
  for (const layer of layersList) {
    const idLayer = layer.nb
    const nameLayer = layer.name
    if (!(idLayer in layersFieldList && layersFieldList[idLayer].name === nameLayer)) {
      await log.warning(`La couche ${idLayer} - ${nameLayer} n'est pas présente dans les couches disponibles`)
    } else {
      layersListCreate.push(layer)
    }
  }

  await log.info(`Extraction des couches ${layersListCreate.map(layer => (`${layer.nb} - ${layer.name}`)).join(', ')}`)

  for (const layer of layersListCreate) {
    if (shouldBeStopped) return

    await log.info('---')
    await log.info(`Création du jeu de données pour la couche ${layer.nb} - ${layersFieldList[layer.nb].name}`)

    let dataset : { id: string, title: string, href: string, page: string }

    if (processingConfig.dataset!.editableCreate) {
      const fields = layersFieldList[layer.nb].fields

      // Display names and types of the fields for debug
      await log.debug(`   Champs : ${fields.map(f => `${f.key} (${f.type})`).join(', ')}`)

      // Create the dataset, empty
      dataset = (await axios.post('api/v1/datasets', {
        title: `${layer.title}`,
        description: '',
        isRest: true,
        schema: fields,
        origin: processingConfig.url,
        extras: { processingId }
      })).data
      await log.info(`   Jeu de données créé, id="${dataset.id}", titre="${dataset.title}"`)

      if (shouldBeStopped) return

      // Dataset population
      idStream += 1
      const streamInformation = { idStream, tmpFile, layerName: layer.name, featureCount: layer.lines, layerSRSDefined: layer.haveSRS, layerSRS: layer.SRS, stop: () => shouldBeStopped }
      streamPendingFinalizations.push(trackAddLayer(axios, log, dataset.id, dataset.title, streamInformation, stopSignal))
    } else {
      const tmpFileGeoJSON = await createTmpFile(tmpDir, tmpFile, layer.name, layer.haveSRS, layer.SRS, log, () => shouldBeStopped)
      if (!tmpFileGeoJSON) return

      const formData = new FormData()
      formData.append('origin', processingConfig.url)
      formData.append('title', layer.title)
      formData.append('file', await fs.createReadStream(tmpFileGeoJSON), { filename: path.parse(tmpFileGeoJSON).base })
      const getLength = util.promisify(formData.getLength.bind(formData))
      const contentLength = await getLength()
      await log.info(`Chargement de ${formatBytes(contentLength!)}`)

      if (shouldBeStopped) return

      dataset = (await axios({
        method: 'post',
        url: 'api/v1/datasets',
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData.getHeaders(), 'content-length': contentLength }
      })).data
      await log.info(`   Jeu de données créé, id="${dataset.id}", titre="${dataset.title}"`)
    }

    if (shouldBeStopped) return

    const datasetObject = { id: dataset.id, href: dataset.href, title: dataset.title }
    const updateObject = { dataset: datasetObject, layer: { nb: layer.nb, name: layer.name } }
    updateConfig.push(updateObject)
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
  await log.step('Mise à jour des jeux de données')

  // If there are no updates to extract, we stop here to simplify the display of logs on the interface.
  if (!processingConfig.datasets || processingConfig.datasets.length <= 0) {
    await log.warning('Pas de mises à jour renseignées')
    return
  }

  for (const layer of processingConfig.layers as LayersList[]) {
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
      await log.warning('Le jeu de données est incomplet (id ou titre manquant)')
      await log.info('')
      continue
    }

    const targetDataset = (await axios.get(`api/v1/datasets/${update.dataset.id}`)).data
    if (!targetDataset) {
      await log.warning('Le jeu de données n\'existe pas. Il a peut-être été supprimé.')
      await log.info('')
      continue
    }

    // SECURITY (normally not necessary) : Checking the availability of the layers (in the event that the download URL has been changed accidentally)
    if (!(update.layer.nb! in layersFieldList && update.layer.name! === layersFieldList[update.layer.nb!].name)) {
      await log.warning(`La couche ${update.layer.nb} - ${update.layer.name} n'est pas présente dans les couches disponibles`)
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
  const updateProgressName = 'En attente de la finalisation de la mise à jour des schémas'
  const listUpdatesDatasets: { [k: string]: unknown, forceUpdate?: boolean, dataset: ExistingDataset, layer: { nb?: number, name?: string }, formData?: FormData }[] = []

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
        await log.info(`Mise à jour forcée du schéma du jeu de données ${dataset.title}`)

        const updateSchema = async () => {
          // Drop the old data
          await axios.post(`api/v1/datasets/${dataset.id}/_bulk_lines?drop=true`, [])
          if (shouldBeStopped) return

          // We are waiting for the dataset to finish processing.
          // We are certain of the ID and title definitions with the previous check.
          await ws.waitForJournal(dataset.id!, 'finalize-end')

          // Update the schema
          const updateDataset = await axios.post(`api/v1/datasets/${dataset.id}`, {
            schema: layersFieldList[idLayer].fields,
            origin: processingConfig.url
          })
          if (shouldBeStopped) return

          if (updateDataset.data.status !== 'finalized') {
            pendingFinalizations.push(trackFinalization(ws, log, dataset.id!, dataset.title!, { successMessage: 'a été finalisé' },
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
        await log.info(`Vérification de la compatibilité des schémas pour le jeu de données ${dataset.title} et la couche ${idLayer} - ${nameLayer}`)

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
            await axios.post(`api/v1/datasets/${dataset.id}/_bulk_lines?drop=true`, [])

            pendingFinalizations.push(trackFinalization(ws, log, dataset.id!, dataset.title!, { successMessage: 'a été finalisé' },
              { name: updateProgressName, total: processingConfig.datasets!.length, progressType: 'update' }, stopSignal))
          }

          // We are certain of the ID and title definitions with the previous check.
          updatePendingFinalizations.push(trackUpdateSchema(log, dataset.id!, dataset.title!, updateSchema, stopSignal))
        } else {
          await log.warning(`Les schémas du jeu de données ${dataset.title} et de la couche ${idLayer} - ${nameLayer} ne sont pas compatibles`)
          await log.info('')
          pendingFinalizations.push(addUpdate(log, updateProgressName, processingConfig.datasets!.length, dataset.id!, dataset.title!, stopSignal))
          continue
        }
      }
    } else {
      if (update.forceUpdate) {
        await log.info(`Mise à jour forcée du schéma du jeu de données ${dataset.title}`)
      }
      listUpdatesDatasets.push(update)
    }
  }

  // Wait for all schema updates to complete before updating data
  if (updatePendingFinalizations.length > 0 || pendingFinalizations.length > 0) {
    displayingProgress()
    await log.task(updateProgressName)
    await log.progress(updateProgressName, nbUpdate, updatePendingFinalizations.length)

    await Promise.allSettled(updatePendingFinalizations.map(p => p.promise))
    await Promise.allSettled(pendingFinalizations.map(p => p.promise))
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
    const formData = new FormData()
    const editable = update.editable

    await log.info('')
    await log.info(`Mise à jour du jeu ${dataset.title} avec la couche ${idLayer} - ${nameLayer}`)

    // Data update
    if (editable) {
      idStream += 1

      const streamInformation = {
        idStream,
        tmpFile,
        layerName: layersFieldList[idLayer].name,
        featureCount: layersFieldList[idLayer].featureCount,
        layerSRSDefined: layersFieldList[idLayer].geometrySRS!.haveSRS,
        layerSRS: layersFieldList[idLayer].geometrySRS!.SRS,
        stop: () => shouldBeStopped
      }

      streamPendingFinalizations.push(trackAddLayer(axios, log, dataset.id!, dataset.title!, streamInformation, stopSignal))
      await log.info('')
    } else {
      const tmpFileGeoJSON = await createTmpFile(tmpDir, tmpFile, layersFieldList[idLayer].name, layersFieldList[idLayer].geometrySRS!.haveSRS, layersFieldList[idLayer].geometrySRS!.SRS, log, () => shouldBeStopped)
      if (!tmpFileGeoJSON) return

      formData.append('file', await fs.createReadStream(tmpFileGeoJSON), { filename: path.parse(tmpFileGeoJSON).base })
      formData.append('origin', processingConfig.url)
      const getLength = util.promisify(formData!.getLength.bind(formData))
      const contentLength = await getLength()
      await log.info(`Chargement de ${formatBytes(contentLength!)}`)

      if (shouldBeStopped) return

      await axios({
        method: 'post',
        url: `api/v1/datasets/${dataset.id}${update.forceUpdate ? '' : '?draft=true'}`,
        data: formData,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: { ...formData!.getHeaders(), 'content-length': contentLength }
      })

      if (shouldBeStopped) return

      await log.info('Mise à jour complète')
      await log.info('')
    }
  }

  if (streamPendingFinalizations.length > 0) {
    await Promise.allSettled(streamPendingFinalizations.map(p => p.promise))
  }
}
