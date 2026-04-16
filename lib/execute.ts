import type { RunFunction, ProcessingContext } from '@data-fair/lib-common-types/processings.js'
import type { ProcessingConfig } from '#types/processingConfig/index.ts'

/**
 * True when an interruption is requested for this processing.
 * This is set by the `stop` function, which is called when the processing is stopped.
 */
let shouldBeStopped = false

export const run: RunFunction<ProcessingConfig> = async (context) => {
  const { processingConfig, log } = context
  await log.step('Starting processing')
  await log.info('Context (log in extra)', context)

  if (processingConfig.delay) await applyDelay(context)
  if (shouldBeStopped) return // If the processing should be stopped, we return early to stop it gracefully

  // To test error handling in processings
  if (processingConfig.throwError) {
    throw new Error('Intentional error during processing execution')
  }

  await sendTestMail(context)
  if (shouldBeStopped) return

  let dataset
  if (processingConfig.datasetMode === 'create') dataset = await createDataset(context)
  else if (processingConfig.datasetMode === 'update') dataset = await checkDataset(context)
  if (shouldBeStopped) return

  await testLogProgress(context)
  if (shouldBeStopped) return

  await addLine(context, dataset.id)

  if (processingConfig.deleteOnComplete) return { deleteOnComplete: true as const }
}

/**
 * Sets `shouldBeStopped = true` to indicate that the processing should be stopped.
 * The `run` function checks the `shouldBeStopped` variable to stop the processing gracefully.
 */
export const stop: () => Promise<void> = async () => { shouldBeStopped = true }

/**
 * Utility function to test that the processing correctly handles interruption.
 *
 * When a processing is shouldBeStopped:
 * - The `stop` function is called (sets `shouldBeStopped = true`)
 * - If `ignoreStop` is false: this function detects the stop and returns early (graceful stop)
 * - If `ignoreStop` is true: this function continues running, but the processing should still
 *   be killed by processings after a timeout if the run doesn't finish by itself
 */
const applyDelay = async ({ processingConfig, log }: ProcessingContext<ProcessingConfig>) => {
  await log.step('Applying delay')
  await log.info(`Pausing for ${processingConfig.delay} second(s) ...`)

  // Check each second if the processing should be shouldBeStopped, to be able to stop it during the delay
  for (let i = 0; i < (processingConfig.delay || 0); i++) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (shouldBeStopped && !processingConfig.ignoreStop) {
      return await log.warning('Gracefully interrupted during wait')
    }
  }
}

/**
 * Sends a test email if the configuration provides it (`email.from` and `email.to` fields filled in).
 * Builds a simple email with an attachment and sends it via the processing mail service.
 */
const sendTestMail = async ({ processingConfig, log, sendMail }: ProcessingContext<ProcessingConfig>) => {
  if (!processingConfig.email?.to || !processingConfig.email?.from) return
  await log.step('Sending test email')
  const mail = {
    from: processingConfig.email.from,
    to: processingConfig.email.to,
    subject: 'Hello world processing !',
    text: 'A test email',
    attachments: [{ filename: 'test.txt', content: 'A test attachment' }]
  }
  await log.info('Mail content: ' + JSON.stringify(mail))
  // @ts-ignore they are maybe an types error in the lib-common-types
  await sendMail(mail)
}

/**
 * Creates a new REST dataset with the title and schema defined in the config.
 * Updates the config with the id and title of the created dataset for future runs.
 */
const createDataset = async ({ processingConfig, secrets, processingId, axios, log, patchConfig }: ProcessingContext<ProcessingConfig>) => {
  await log.step('Creating dataset')
  const dataset = (await axios.post('api/v1/datasets', {
    title: processingConfig.dataset.title,
    description: secrets?.secretField ?? processingConfig.secretField ?? '',
    isRest: true,
    schema: [{ key: 'message', type: 'string' }],
    extras: { processingId }
  })).data
  await log.info(`Dataset created, id="${dataset.id}", title="${dataset.title}"`)
  await patchConfig({ datasetMode: 'update', dataset: { id: dataset.id, title: dataset.title } })
  return dataset
}

/**
 * Checks that the configured dataset exists and returns its information.
 * Updates its description with the secret if it has changed.
 * Throws an error if the dataset is not found.
 */
const checkDataset = async ({ processingConfig, secrets, axios, log }: ProcessingContext<ProcessingConfig>) => {
  await log.step('Checking dataset')
  const dataset = (await axios.get(`api/v1/datasets/${processingConfig.dataset.id}`)).data
  if (!dataset) throw new Error(`Dataset not found, id="${processingConfig.dataset.id}"`)
  await log.info(`Dataset exists, id="${dataset.id}", title="${dataset.title}"`)
  if (secrets?.secretField) {
    await log.step('Updating secret')
    await axios.patch(`api/v1/datasets/${dataset.id}`, { description: secrets.secretField })
  }
  return dataset
}

/**
 * Tests the progress log system by simulating a long task over 100 steps.
 * Each step takes 100ms, preceded by an initial 2s delay, with stop check at each iteration.
 */
const testLogProgress = async ({ log }: ProcessingContext<ProcessingConfig>) => {
  await log.task('Task with progress')
  await log.progress('Task with progress', 0, 100)
  await new Promise(resolve => setTimeout(resolve, 2000))
  for (let i = 0; i < 100; i++) {
    if (shouldBeStopped) return
    await new Promise(resolve => setTimeout(resolve, 100))
    await log.progress('Task with progress', i + 1, 100)
  }
}

/**
 * Adds or updates the welcome line in the dataset.
 * The message is the concatenation of the plugin message and the config message.
 * Waits for the dataset finalization to complete via websocket before returning.
 */
const addLine = async ({ pluginConfig, processingConfig, axios, log, ws }: ProcessingContext<ProcessingConfig>, datasetId: string) => {
  await log.step('Writing welcome message')
  await axios.put(`api/v1/datasets/${datasetId}/lines/hello`, {
    message: pluginConfig.pluginMessage + ' ' + processingConfig.message
  })
  await log.info('1 data line written')
  await ws.waitForJournal(datasetId, 'finalize-end')
}
