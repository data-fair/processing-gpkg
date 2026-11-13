import { pipeline } from 'node:stream/promises'
import type { AxiosRequestConfig } from 'axios'

import fs from 'fs-extra'
import path from 'path'

import type { GpkgProcessingContext } from './context.ts'

/** The URL without the credentials it may embed (https://user:password@host/…), for messages */
export const displayUrl = (url: string): string => {
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    return parsed.href
  } catch {
    return '(invalid URL)'
  }
}

/**
 * Allows you to download a file using the HTTP protocol
 * @param processingConfig  Processing configuration, obtained from the form data (processing-config-schema.json)
 * @param tmpFile           Name of the temporary file to transfer the downloaded file
 * @param axios             Server for API requests
 * @returns Name of extracted file
 */
export const fetchHTTP = async (processingConfig: GpkgProcessingContext['processingConfig'], tmpFile: string, axios: GpkgProcessingContext['axios']) => {
  // the context's axios follows no redirect by default and has no timeout: a remote
  // source needs both. The timeout covers the wait for the response and any idle
  // period of the stream, not the whole download
  const opts: AxiosRequestConfig = { responseType: 'stream', maxRedirects: 5, timeout: 60000 }

  // File retrieval and download
  let res
  try {
    res = await axios.get(processingConfig.url.trim(), opts)
  } catch (err: any) {
    if ((err.status ?? err.response?.status) === 404) throw new Error(`File not found: ${displayUrl(processingConfig.url.trim())}`)
    throw err
  }
  await pipeline(res.data, fs.createWriteStream(tmpFile))

  // Retrieving the file name. It comes from the remote server (or the user) and is only
  // used to check the extension, but it is reduced to a base name all the same
  return remoteFilename(processingConfig, res)
}

const remoteFilename = (processingConfig: GpkgProcessingContext['processingConfig'], res: any): string | undefined => {
  const name = rawRemoteFilename(processingConfig, res)
  return name ? path.basename(name) : undefined
}

const rawRemoteFilename = (processingConfig: GpkgProcessingContext['processingConfig'], res: any): string | undefined => {
  if (typeof processingConfig.filename === 'string' && processingConfig.filename) return processingConfig.filename
  const disposition: string | undefined = res.headers['content-disposition']
  if (disposition && disposition.includes('filename=')) {
    const match = disposition.match(/filename="?(.*?)"?;/) ?? disposition.match(/filename="(.*)"/) ?? disposition.match(/filename=(.*)/)
    if (match) return match[1]
  }
  if (res.request?.res?.responseUrl) return decodeURIComponent(path.parse(res.request.res.responseUrl).base)
}
