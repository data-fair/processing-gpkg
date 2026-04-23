import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'

import fs from 'fs-extra'
import * as path from 'path'

import { runCommand } from './spawn-process.ts'

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

  if (!(await fs.pathExists(tmpFileGeoJSON))) {
    await log.info('Création du fichier temporaire')
    if (isStopped()) return

    await runCommand('ogr2ogr', ['-f', 'GeoJSON', '-lco', 'RFC7946=YES', '-t_srs', 'EPSG:4326', tmpFileGeoJSON, tmpFile, layerName])
  }

  return tmpFileGeoJSON
}
