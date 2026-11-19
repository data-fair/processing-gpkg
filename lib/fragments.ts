import type { AxiosInstance } from 'axios'
import type { LogFunctions } from '@data-fair/lib-common-types/processings.js'
import { dfRetry, errorData } from './retry.ts'

/**
 * Grouping the datasets of one file under a parent relies on data-fair fragments: a
 * dataset with `partOf: { type: 'dataset', id }` pointing at a meta-only dataset is
 * hidden from listings, gets its permissions from that parent, is shown on the parent's
 * page and is deleted with it. A fragment cannot be published on a portal or a catalog:
 * the parent is.
 */
export interface PartOf {
  type: 'dataset'
  id: string
}

export const partOfParent = (parentId: string): PartOf => ({ type: 'dataset', id: parentId })

const describe = (err: any) => {
  const detail = errorData(err)
  const body = typeof detail === 'string' ? detail : detail ? JSON.stringify(detail) : ''
  return body ? `${err.message}: ${body}` : err.message
}

/**
 * Attach an existing dataset to the parent, for a family created before the checkbox
 * existed or while it was unchecked. Unchecking the box afterwards detaches nothing.
 *
 * A dataset that already belongs to another resource (attached by hand) is left as is.
 * data-fair refuses to attach a dataset published on a portal or a catalog, declared as
 * reference data or owned by someone else. Such a refusal is logged as a warning and the
 * run goes on: the data is still updated, only the grouping is missing.
 *
 * Returns true when the dataset is a fragment of the parent.
 */
export const attachToParent = async (
  axios: AxiosInstance,
  live: { id: string, title?: string, partOf?: { type: string, id: string } },
  parentId: string,
  log: LogFunctions
): Promise<boolean> => {
  const label = live.title || live.id
  const current = live.partOf
  if (current?.type === 'dataset' && current.id === parentId) return true
  if (current) {
    await log.warning(`"${label}" already belongs to the ${current.type} ${current.id}: it is not moved under the parent dataset`)
    return false
  }

  try {
    await dfRetry(() => axios.patch(`api/v1/datasets/${live.id}`, { partOf: partOfParent(parentId) }), log, { label: `PATCH api/v1/datasets/${live.id}` })
  } catch (err: any) {
    await log.warning(`Could not attach "${label}" to the parent dataset: ${describe(err)}`)
    return false
  }
  await log.info(`"${label}" attached to the parent dataset`)
  return true
}

/**
 * The meta-only dataset standing for the whole file. Its title and description belong to
 * whoever publishes it once created: they are set here and never again.
 */
export const createParentDataset = async (axios: AxiosInstance, title: string, origin: string, log: LogFunctions): Promise<{ id: string, title: string }> => {
  const dataset = (await dfRetry(() => axios.post('api/v1/datasets', { title, origin, isMetaOnly: true }), log, { label: 'POST api/v1/datasets', creates: true })).data
  await log.info(`Parent dataset created, id="${dataset.id}", title="${dataset.title}"`)
  return { id: dataset.id, title: dataset.title }
}
