import type { RunFunction, ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

import { spawn, exec } from 'child_process'
import util from 'util'
import fs from 'fs-extra'
import * as path from 'path'
import { pipeline } from 'node:stream/promises'
import { ogr2ogr } from 'ogr2ogr'

const execute = util.promisify(exec)

let processType = ''

export const run: RunFunction<ProcessingConfig> = async (context) => {
  const { pluginConfig, processingConfig, processingId, secrets, dir, tmpDir, axios, log, patchConfig, ws } = context
  try {
    await log.info('Réception du traitement')

    await download(processingConfig, secrets, dir, axios, log)

    // TODO : Corriger ce problème
    // const sortie = await exec('ogrinfo', ['./BDT_3-5_GPKG_LAMB93_D005-ED2026-03-15.gpkg'], log)
    // const data = await ogr2ogr('../BDT_3-5_GPKG_LAMB93_D005-ED2026-03-15.gpkg')
    // log.info('data : ', data)

    // let { stream } = await ogr2ogr(data, { format: 'ESRI Shapefile' })

    // Convert ESRI Shapefile stream to KML text.
    // let { text } = await ogr2ogr(stream, { format: 'KML' })
    // log.info('Texte : ', text)

    // await createDataset(context)
  } catch (err) {
    log.error(`Error !!!!!! ${err} `)
  }
}

export const download = async (processingConfig, secrets, dir, axios, log) => {
  try {
    await fs.ensureDir(dir)

    await log.step('Téléchargement du fichier')
    let tmpFile = path.join(dir, 'file')
    await fs.ensureFile(tmpFile)

    const url = new URL(processingConfig.url)
    let filename = decodeURIComponent(path.parse(processingConfig.url).base)

    filename = await fetchHTTP(processingConfig, secrets, tmpFile, axios) || filename

    // Try to prevent weird bug with NFS by forcing syncing file before reading it
    const fd = await fs.open(tmpFile, 'r')
    await fs.fsync(fd)
    await fs.close(fd)
    await log.info(`Le fichier a été téléchargé (${filename})`)

    let gpkgFilename

    if (filename.includes('.zip')) {
      await log.info(`Dézippage du fichier ${filename}`)

      // Unzip
      await execute(`unzip -j ${tmpFile} -d ${tmpFile}-dezip`)
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
        const tabSplit = filesGpkg[0].split('/')
        gpkgFilename = tabSplit[tabSplit.length - 1]
        tmpFile = filesGpkg[0]
      }
    } else if (filename.includes('gpkg')) {
      await log.info('Récupération du fichier gpkg')
      gpkgFilename = filename
    } else {
      await log.info('Le format n \'est pas pris en charge')
      throw new Error('Format non pris en charge')
    }

    await log.info(`Traitement du fichier ${gpkgFilename}`)
    await log.info(`Fichier réel ${tmpFile}`)
  } catch (err) {
    await log.error(`Erreur : ${err}`)
  }
}

class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FileNotFoundError'
  }
}

const fetchHTTP = async (processingConfig: ProcessingConfig, secrets: ProcessingContext['secrets'], tmpFile: string, axios: ProcessingContext['axios']) => {
  const password = secrets?.password ?? processingConfig.password
  const opts: any = { responseType: 'stream', maxRedirects: 4 }
  if (processingConfig.username && password) {
    opts.auth = { username: processingConfig.username, password }
  }
  let res
  try {
    res = await axios.get(processingConfig.url, opts)
  } catch (err: any) {
    if (err.response?.status === 404) throw new FileNotFoundError(`File not found: ${processingConfig.url}`)
    throw err
  }
  await pipeline(res.data, fs.createWriteStream(tmpFile))
  if (processingConfig.filename) return processingConfig.filename
  if (res.headers['content-disposition'] && res.headers['content-disposition'].includes('filename=')) {
    if (res.headers['content-disposition'].match(/filename=(.*);/)) return res.headers['content-disposition'].match(/filename=(.*);/)[1]
    if (res.headers['content-disposition'].match(/filename="(.*)"/)) return res.headers['content-disposition'].match(/filename="(.*)"/)[1]
    if (res.headers['content-disposition'].match(/filename=(.*)/)) return res.headers['content-disposition'].match(/filename=(.*)/)[1]
  }
  if (res.request && res.request.res && res.request.res.responseUrl) return decodeURIComponent(path.parse(res.request.res.responseUrl).base)
}

const createDataset = async ({ processingConfig, secrets, processingId, axios, log, patchConfig }: ProcessingContext<ProcessingConfig>) => {
  await log.step('Creating dataset')
  const dataset = (await axios.post('api/v1/datasets', {
    title: processingConfig.dataset.title,
    description: '',
    isRest: true,
    schema: [{ key: 'message', type: 'string' }, { key: 'test', type: 'number' }],
    extras: { processingId }
  })).data
  await log.info(`Dataset created, id="${dataset.id}", title="${dataset.title}"`)
  await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
  return dataset
}
