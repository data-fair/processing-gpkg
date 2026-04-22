import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'

import { spawn } from 'child_process'
import fs from 'fs-extra'
import * as path from 'path'

/**
 * Allows you to create a temporary .geojson file from a layer in the data file, to be sent to create a file dataset.
 * @param dir         Directory where to store the file
 * @param tmpFile     Name of the temporary file containing the original data (multi-layered gpkg)
 * @param layerName   Name of the layer to be extracted
 * @param log         Log system that is displayed on the user interface
 * @param isStopped   Function allowing the program to stop if requested
 * @returns   Name of the temporary file created to send
 */
export const createTmpFile = async (dir : string, tmpFile : string, layerName : string, log: LogFunctions, isStopped: () => boolean) => {
  const tmpFileGeoJSON = path.join(dir, `${layerName}.geojson`)

  if (!(await fs.exists(tmpFileGeoJSON))) {
    await log.info('Création du fichier temporaire')
    if (isStopped()) return

    const proc = spawn('ogr2ogr', ['-f', 'GeoJSON', '-lco', 'RFC7946=YES', '-t_srs', 'EPSG:4326', tmpFileGeoJSON, tmpFile, layerName])

    const stderrChunks: Buffer[] = []
    proc.stderr.on('data', (d: Buffer) => {
      stderrChunks.push(d)
    })

    const procClosed = new Promise<number>((resolve) => {
      proc.on('close', (code) => {
        resolve(code ?? 0)
      })
    })

    proc.on('error', (err) => { throw err })

    const exitCode = await procClosed
    if (exitCode !== 0) {
      const stderr = Buffer.concat(stderrChunks).toString()
      throw new Error(`ogr2ogr en échec avec le code ${exitCode}: ${stderr}`)
    }
  }

  return tmpFileGeoJSON
}
