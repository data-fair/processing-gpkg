import type { GpkgProcessingContext } from './context.ts'
import { streamLayerToDataset } from './stream-layer.ts'

export let nbFinalize = 0
export let nbUpdate = 0
let displayProgress: boolean = false

// Use to enable or disable progress log display at the right time
export const displayingProgress = (display = true) => {
  displayProgress = display
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
 * @param stopSignal            Program stop signal
 * @returns A `PendingFinalization` whose `promise` settles once the event arrives,
 *          the run is stopped, the wait times out, or fails — never rejects.
 */
export const trackFinalization = (
  ws: GpkgProcessingContext['ws'],
  log: GpkgProcessingContext['log'],
  datasetId: string,
  datasetTitle: string,
  opts: { successMessage: string, checkDraft?: boolean },
  progressInfo: { name: string, total: number, progressType?: 'finalize' | 'update' },
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
      if (progressInfo.progressType === 'update') {
        nbUpdate += 1
        if (displayProgress) await log.progress(progressInfo.name, nbUpdate, progressInfo.total)
      } else {
        nbFinalize += 1
        if (displayProgress) await log.progress(progressInfo.name, nbFinalize, progressInfo.total)
      }
    })
  return { promise, datasetId, datasetTitle }
}

/**
 * Allows you to start adding data to the layers in order to process multiple datasets simultaneously.
 *
 * @param axios                   Server for API requests
 * @param datasetId               Id of the dataset whose finalization should be awaited.
 * @param datasetTitle            Human-readable dataset title, used in log messages.
 * @param stream.idStream         Stream ID for displaying progress
 * @param stream.tmpFile          Full path of the file to be processed
 * @param stream.layerName        Name of the layer from which the data is extracted
 * @param stream.featureCount     Number of rows of data to extract
 * @param stream.layerSRSDefined  Indicates whether the layer has a defined SRS or not
 * @param stream.layerSRS         User-specified SRS name, if the SRS is not defined
 * @param stream.stop             Function allowing the program to stop if requested
 * @param stopSignal              Program stop signal
 * @returns A `PendingFinalization` whose `promise` settles once the event arrives,
 *          the run is stopped, the wait times out, or fails — never rejects.
 */
export const trackAddLayer = (
  axios: GpkgProcessingContext['axios'],
  log: GpkgProcessingContext['log'],
  datasetId: string,
  datasetTitle: string,
  stream: { idStream: number, tmpFile: string, layerName: string, featureCount: number, layerSRSDefined: boolean, layerSRS: string, stop: () => boolean },
  stopSignal : Promise<void>
): PendingFinalization => {
  const journalPromise = streamLayerToDataset(stream.idStream, stream.tmpFile, stream.layerName, stream.featureCount, stream.layerSRSDefined, stream.layerSRS, datasetId, axios, log, stream.stop, datasetTitle)
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

/**
 * Allows you to start adding data to the layers in order to process multiple datasets simultaneously.
 *
 * @param log           Log system displayed in the user interface.
 * @param datasetId     Id of the dataset whose finalization should be awaited.
 * @param datasetTitle  Human-readable dataset title, used in log messages.
 * @param updateSchema  Schema update function, pre-configured with the correct data
 * @param stopSignal    Program stop signal
 * @returns A `PendingFinalization` whose `promise` settles once the event arrives,
 *          the run is stopped, the wait times out, or fails — never rejects.
 */
export const trackUpdateSchema = (
  log: GpkgProcessingContext['log'],
  datasetId: string,
  datasetTitle: string,
  updateSchema: () => Promise<void>,
  stopSignal : Promise<void>
): PendingFinalization => {
  const journalPromise = updateSchema()
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
      await log.warning(`La mise à jour du schéma pour le jeu de données "${datasetTitle}" n'a pas pu être finalisé (${error.message}), vous pouvez relancer son traitement.`)
      return { ok: false as const, error }
    })
  return { promise, datasetId, datasetTitle }
}

/**
 * Allows you to count an update across multiple datasets simultaneously;
 * used for datasets with errors or that do not require modifications.
 *
 * @param log           Log system displayed in the user interface.
 * @param progressName  Name of the relevant progress task
 * @param total         Total number of tasks to complete for progress
 * @param datasetId     Id of the dataset whose finalization should be awaited.
 * @param datasetTitle  Human-readable dataset title, used in log messages.
 * @param stopSignal    Program stop signal
 * @returns A `PendingFinalization` whose `promise` settles once the event arrives,
 *          the run is stopped, the wait times out, or fails — never rejects.
 */
export const addUpdate = (
  log: GpkgProcessingContext['log'],
  progressName: string,
  total: number,
  datasetId: string,
  datasetTitle: string,
  stopSignal : Promise<void>
):PendingFinalization => {
  const addOne = async () => {
    nbUpdate += 1
    if (displayProgress) await log.progress(progressName, nbUpdate, total)
  }

  const journalPromise = addOne()
    .then(journal => ({ kind: 'event' as const, journal }))
  const stopPromise = stopSignal.then(() => ({ kind: 'stopped' as const }))

  const promise = Promise.race([journalPromise, stopPromise])
    .then(async (result) => {
      if (result.kind === 'stopped') {
        return { ok: false as const, error: new Error('stopped') }
      }
      const journal: any = result.journal
      await log.info(`Le jeu de données "${datasetTitle}" a été finalisé`)
      return { ok: true as const, journal }
    })
    .catch(async (error: Error) => {
      await log.warning(`La mise à jour du schéma pour le jeu de données "${datasetTitle}" n'a pas pu être finalisé (${error.message}), vous pouvez relancer son traitement.`)
      return { ok: false as const, error }
    })
  return { promise, datasetId, datasetTitle }
}
