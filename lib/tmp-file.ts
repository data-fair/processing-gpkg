import fs from 'fs-extra'
import path from 'path'

import { runCommand, getOgrEnv, layerArg } from './spawn-process.ts'
import type { GpkgProcessingContext } from './context.ts'

/**
 * Name of a local file built from a name read in the downloaded file (sheet or layer name):
 * no directory part, so that it stays in the tmp directory
 */
export const safeLocalName = (name: string) => name.replace(/[/\\]/g, '_')

/**
 * unzip restores the symbolic links of an archive: reading or writing one of
 * them would reach a file of the worker outside of the tmp directory.
 */
export const removeSymlinks = async (dir: string): Promise<void> => {
  for (const f of await fs.readdir(dir)) {
    if ((await fs.lstat(path.join(dir, f))).isSymbolicLink()) await fs.remove(path.join(dir, f))
  }
}

/**
 * Allows you to create a temporary .geojson file from a layer in the data file, to be sent to create a file dataset.
 * @param dir               Directory where to store the file
 * @param tmpFile           Name of the temporary file containing the original data (multi-layered gpkg)
 * @param layerName         Name of the layer to be extracted
 * @param layerSRSDefined   Indicates whether the layer has a defined SRS or not
 * @param layerSRS          User-specified SRS name, if the SRS is not defined
 * @param log               Log system that is displayed on the user interface
 * @param isStopped         Function allowing the program to stop if requested
 * @returns   Name of the temporary file created to send
 */
export const createTmpFile = async (dir : string, tmpFile : string, layerName : string, layerSRSDefined: boolean, layerSRS: string, log: GpkgProcessingContext['log'], isStopped: () => boolean) => {
  const tmpFileGeoJSON = path.join(dir, `${safeLocalName(layerName)}.geojson`)

  try {
    // If there are two updates with the same layer, it is only downloaded once.
    if (!(await fs.pathExists(tmpFileGeoJSON))) {
      await log.info('Création du fichier temporaire')
      if (isStopped()) return

      if (!layerSRSDefined && layerSRS && layerSRS.length > 0) {
        await runCommand('ogr2ogr', ['-if', 'GPKG', '-f', 'GeoJSON', '-lco', 'RFC7946=YES', '-s_srs', layerSRS, '-t_srs', 'EPSG:4326', '-lco', 'COORDINATE_PRECISION=6', tmpFileGeoJSON, tmpFile, layerArg(layerName)], { env: getOgrEnv() })
      } else {
        await runCommand('ogr2ogr', ['-if', 'GPKG', '-f', 'GeoJSON', '-lco', 'RFC7946=YES', '-t_srs', 'EPSG:4326', '-lco', 'COORDINATE_PRECISION=6', tmpFileGeoJSON, tmpFile, layerArg(layerName)], { env: getOgrEnv() })
      }
    }
  } catch (err : any) {
    await log.warning(`ogr2ogr en échec : ${err.message}`)
    return undefined
  }

  return tmpFileGeoJSON
}
