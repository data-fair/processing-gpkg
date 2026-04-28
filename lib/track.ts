import type { GpkgProcessingContext } from './context.ts'
import { streamLayerToDataset } from './stream-layer.ts'

export let nbFinalize = 0
let displayProgress: boolean = false

export const displayingProgress = () => {
  displayProgress = true
}

export type PendingFinalization = {
  promise: Promise<{ ok: true, journal: any } | { ok: false, error: Error }>
  datasetId: string
  datasetTitle: string
}

/**
 * Starts listening for the `finalize-end` journal event of a dataset without blocking.
 *
 * `ws.waitForJournal` is invoked synchronously so the WebSocket subscription is set
 * up immediately after the upload — this keeps the race window between "event emitted
 * by the server" and "listener attached on the client" down to a single roundtrip,
 * matching the behaviour of the original sequential flow. The returned promise never
 * rejects: failures are converted into a warning log and an `{ ok: false }` result so
 * one bad finalization cannot abort `Promise.allSettled` over the whole batch. The
 * wait also races against the module-level `stopSignal`, so a `stop()` triggers an
 * immediate bail-out without waiting for the journal timeout.
 *
 * @param ws                    Data Fair WebSocket client used to receive journal events.
 * @param log                   Log system displayed in the user interface.
 * @param datasetId             Id of the dataset whose finalization should be awaited.
 * @param datasetTitle          Human-readable dataset title, used in log messages.
 * @param opts.successMessage   Message logged when the finalization succeeds.
 * @param opts.checkDraft       When true, a draft state on the journal triggers a schema-
 *                              incompatibility warning instead of the success message
 *                              (used by update flows).
 * @param progressInfo.name     Name of the corresponding task log
 * @param progressInfo.total    Total number of pending datasets
 * @returns A `PendingFinalization` whose `promise` settles once the event arrives,
 *          the run is stopped, the wait times out, or fails — never rejects.
 */
export const trackFinalization = (
  ws: GpkgProcessingContext['ws'],
  log: GpkgProcessingContext['log'],
  datasetId: string,
  datasetTitle: string,
  opts: { successMessage: string, checkDraft?: boolean },
  progressInfo: { name: string, total: number },
  stopSignal : Promise<void>
): PendingFinalization => {
  const journalPromise = ws.waitForJournal(datasetId, 'finalize-end')
    .then(journal => ({ kind: 'event' as const, journal }))
  const stopPromise = stopSignal.then(() => ({ kind: 'stopped' as const }))

  const promise = Promise.race([journalPromise, stopPromise])
    .then(async (result) => {
      if (result.kind === 'stopped') {
        return { ok: false as const, error: new Error('stopped') }
      }
      const journal: any = result.journal
      if (opts.checkDraft && (journal.draft !== undefined || journal.draft)) {
        await log.warning(`Le schéma du jeu de données "${datasetTitle}" n'est pas compatible avec la couche . Le jeu est passé en mode brouillon, à vous de le valider ou non.`)
      } else {
        await log.info(`Le jeu de données "${datasetTitle}" ${opts.successMessage}`)
      }
      return { ok: true as const, journal }
    })
    .catch(async (error: Error) => {
      await log.warning(`Le jeu de données "${datasetTitle}" n'a pas pu être finalisé (${error.message}), vous pouvez relancer son traitement.`)
      return { ok: false as const, error }
    })
    .finally(async () => {
      nbFinalize += 1
      if (displayProgress) await log.progress(progressInfo.name, nbFinalize, progressInfo.total)
    })
  return { promise, datasetId, datasetTitle }
}

export const trackAddLayer = (
  axios: GpkgProcessingContext['axios'],
  log: GpkgProcessingContext['log'],
  datasetId: string,
  datasetTitle: string,
  stream: { idStream: number, tmpFile: string, layerName: string, featureCount: number, stop: () => boolean, track: () => void },
  stopSignal : Promise<void>
): PendingFinalization => {
  const journalPromise = streamLayerToDataset(stream.idStream, stream.tmpFile, stream.layerName, stream.featureCount, datasetId, axios, log, stream.stop, datasetTitle, stream.track)
    .then(journal => ({ kind: 'event' as const, journal }))
  const stopPromise = stopSignal.then(() => ({ kind: 'stopped' as const }))

  const promise = Promise.race([journalPromise, stopPromise])
    .then(async (result) => {
      if (result.kind === 'stopped') {
        return { ok: false as const, error: new Error('stopped') }
      }
      const journal: any = result.journal
      return { ok: true as const, journal }
    })
    .catch(async (error: Error) => {
      await log.warning(`L'envoi de données vers le jeu de données "${datasetTitle}" n'a pas pu être finalisé (${error.message}), vous pouvez relancer son traitement.`)
      return { ok: false as const, error }
    })
  return { promise, datasetId, datasetTitle }
}
