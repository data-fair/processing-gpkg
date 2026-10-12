import { spawn, type SpawnOptions } from 'node:child_process'
import Debug from 'debug'

const debug = Debug('spawn-process')

// Run GDAL in a controlled environment, without the secrets and settings of the worker
const ogrEnvKeys = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'TZ', 'LD_LIBRARY_PATH']
const ogrEnvPrefixes = ['GDAL_', 'CPL_', 'OGR_', 'PROJ_']

export const getOgrEnv = (env: NodeJS.ProcessEnv = process.env): Record<string, string> => {
  const ogrEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (ogrEnvKeys.includes(key) || ogrEnvPrefixes.some(prefix => key.startsWith(prefix))) ogrEnv[key] = value
  }
  return ogrEnv
}

/**
 * A layer name is read in the downloaded file and given as an argument to ogr2ogr:
 * it must not be interpreted as an option
 */
export const layerArg = (layerName: string): string => {
  if (layerName.startsWith('-')) throw new Error(`nom de couche non supporté "${layerName}"`)
  return layerName
}

/**
 * Defining an interface for the return values from the execution of a command
 * @param stdout  Console output
 * @param stderr  Error output
 */
export interface SpawnResult {
  stdout: string
  stderr: string
}

/**
 * Allows you to execute a command asynchronously.
 * The output is sent back after execution has finished.
 * @param cmd       Main command to execute
 * @param args      Arguments for the command
 * @param options   Spawn options if needed (empty by default)
 * @returns   A promise with console output and command execution error
 */
export async function runCommand (cmd: string, args: string[], options: SpawnOptions = {}): Promise<SpawnResult> {
  debug(`${cmd} ${args.join(' ')}`)
  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(cmd, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout?.on('data', (chunk: Buffer) => { stdoutChunks.push(chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { stderrChunks.push(chunk) })

    child.on('error', reject)

    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString()
      const stderr = Buffer.concat(stderrChunks).toString()
      debug('stdout', stdout)
      debug('stderr', stderr)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr || `${cmd} en échec avec le code ${code}`))
    })
  })
}
