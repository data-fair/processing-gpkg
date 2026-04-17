import type { RunFunction } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

import { exec } from 'child_process'
import util from 'util'
import fs from 'fs-extra'
import * as path from 'path'

import { fetchHTTP } from './fetch.ts'
import { streamLayerToDataset } from './stream-layer.ts'

const execute = util.promisify(exec)

/**
 * Input function, allows data processing to begin
 * @param context Context of the request
 */
export const run: RunFunction<ProcessingConfig> = async (context) => {
  // Retrieving the contextual elements necessary for processing
  const { processingConfig, processingId, secrets, tmpDir, axios, log } = context
  try {
    const tmpFile = await download(processingConfig, secrets, tmpDir, axios, log)

    const layersFieldList = await extraction(tmpFile, log)

    // If there are no layers to extract, we stop here to simplify the display of logs on the interface.
    if (!processingConfig.idsLayers || processingConfig.idsLayers.length <= 0) {
      await log.debug('Pas de couches renseignées')
    } else {
      await createDatasets(processingConfig, processingId, axios, layersFieldList, tmpFile, log)
    }
  } catch (err) {
    log.error(`Erreur :  ${err} `)
    throw err
  }
}

/**
 * Allows you to download the file and place it in a temporary folder for later processing.
 * We only process .zip and .gpkg formats; any other format will result in an error.
 * @param processingConfig  Processing configuration, obtained from the form data (processing-config-schema.json)
 * @param secrets           Sensitive information if necessary (such as a password, for example)
 * @param dir               Directory where to download the file
 * @param axios             Server for API requests
 * @param log               Log system that is displayed on the user interface
 * @returns Full path of the file to be processed
 */
const download = async (processingConfig, secrets, dir, axios, log) => {
  await fs.ensureDir(dir)

  await log.step('Téléchargement du fichier')
  let tmpFile = path.join(dir, 'file')
  await fs.ensureFile(tmpFile)

  let filename = decodeURIComponent(path.parse(processingConfig.url).base)

  filename = await fetchHTTP(processingConfig, secrets, tmpFile, axios) || filename

  // Try to prevent weird bug with NFS by forcing syncing file before reading it
  const fd = await fs.open(tmpFile, 'r')
  await fs.fsync(fd)
  await fs.close(fd)
  await log.info(`Le fichier a été téléchargé (${filename})`)

  let gpkgFilename

  // Check the file format
  if (filename.endsWith('.zip')) {
    await log.info(`Dézippage du fichier ${filename}`)

    // Unzip
    await execute(`unzip -j ${tmpFile} -d ${tmpFile}-dezip`)

    // We are looking for the .gpkg files contained in the .zip file.
    const filesGpkg: string[] = []
    await fs.readdir(`${tmpFile}-dezip`)
      .then((files) => {
        files.forEach(async file => {
          if (file.endsWith('.gpkg')) {
            filesGpkg.push(`${tmpFile}-dezip/${file}`)
          }
        })
      })

    const nbFichiers = filesGpkg.length

    if (nbFichiers <= 0) {
      throw new Error('Il n\' y a pas de fichiers .gpkg à traiter dans ce zip.')
    } else {
      // We keep the first .gpkg file we find, we ignore the others
      const tabSplit = filesGpkg[0].split('/')
      gpkgFilename = tabSplit[tabSplit.length - 1]
      tmpFile = filesGpkg[0]
    }
  } else if (filename.endsWith('gpkg')) {
    await log.info('Récupération du fichier gpkg')
    gpkgFilename = filename
  } else {
    await log.info('Le format n\'est pas pris en charge')
    throw new Error('Format non pris en charge')
  }

  await log.info(`Traitement du fichier ${gpkgFilename}`)

  return tmpFile
}

/**
 * Allows you to retrieve the layers of a file and organize their structure
 * @param tmpFile   Full path of the file to be processed
 * @param log       Log system that is displayed on the user interface
 * @returns Dictionary of available layer structures (id: {name, fields, featureCount})
 */
const extraction = async (tmpFile, log) => {
  await log.step('Récupération de la structure des données')

  // Display layers
  const result = await execute(`ogrinfo -json ${tmpFile}`)

  const jsonStructure = await JSON.parse(result.stdout)

  const layers = jsonStructure.layers
  const layersFieldList: { [username: number]: { name: string, fields: any[], featureCount: number } } = []

  for (let i = 0; i < layers.length; i++) {
    for (let j = 0; j < layers[i].fields.length; j++) {
      let typeCorrect = layers[i].fields[j].type.toLowerCase()

      // Check the types
      if (typeCorrect.includes('integer')) {
        typeCorrect = 'integer'
      }

      if (typeCorrect.includes('real')) {
        typeCorrect = 'number'
      }

      layers[i].fields[j] = {
        ...layers[i].fields[j],
        key: layers[i].fields[j].name,
        type: typeCorrect
      }
      if (!layers[i].fields[j].type) {
        throw new Error(`Pas de type pour ${layers[i].fields[j].name}`)
      }
    }

    if (layers[i].fields.length <= 0) {
      await log.warn(`Couche ${i + 1} - ${layers[i].name} - Pas de propriétés, INUTILISABLE`)
    } else {
      await log.info(`Couche ${i + 1} - ${layers[i].name} - ${layers[i].featureCount} lignes`)
      layersFieldList[i + 1] = { name: layers[i].name, fields: layers[i].fields, featureCount: layers[i].featureCount }
    }
  }

  return layersFieldList
}

/**
 * Allows you to create the requested layer datasets
 * @param processingConfig  Processing configuration, obtained from the form data (processing-config-schema.json)
 * @param processingId      Identifier of the processing currently in use
 * @param axios             Server for API requests
 * @param layersFieldList   Dictionary containing the structure of the file's layers (id: {name, fields, featureCount})
 * @param tmpFile           Full path of the file to be processed
 * @param log               Log system that is displayed on the user interface
 */
const createDatasets = async (processingConfig, processingId, axios, layersFieldList: { [username: number]: { name: string, fields: any[], featureCount: number } }, tmpFile: string, log) => {
  await log.step('Construction des jeux de données')

  for (const idLayer of processingConfig.idsLayers) {
    if (!(idLayer in layersFieldList)) {
      await log.warn(`La couche ${idLayer} n\'est pas présente dans les couches disponibles`)
    } else {
      await log.info(`Création du jeu de données pour la couche ${idLayer} - ${layersFieldList[idLayer].name}`)

      // Display names and types of the fields
      for (const field of layersFieldList[idLayer].fields) {
        await log.debug(`   Nom : ${field.key} - Type : ${field.type}`)
      }

      // Create the dataset, empty
      const fields = layersFieldList[idLayer].fields
      const dataset = (await axios.post('api/v1/datasets', {
        title: `${processingConfig.dataset.prefix}-${layersFieldList[idLayer].name}`,
        description: '',
        isRest: true,
        schema: fields,
        extras: { processingId }
      })).data
      await log.info(`   Jeu de donnée créé, id="${dataset.id}", titre="${dataset.title}"`)

      // Dataset population
      await streamLayerToDataset(tmpFile, layersFieldList[idLayer].name, layersFieldList[idLayer].featureCount, dataset.id, axios, log)

      await log.info('Jeu de données complet')
      await log.info('')

      // await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
    }
  }
}
