import {partitionThemeFiles} from './theme-fs.js'
import {applyIgnoreFilters} from './asset-ignore.js'
import {rejectGeneratedStaticAssets} from './asset-checksum.js'
import {renderTasksToStdErr} from './theme-ui.js'
import {AdminSession} from '@shopify/cli-kit/node/session'
import {Result, Checksum, Theme, ThemeFileSystem} from '@shopify/cli-kit/node/themes/types'
import {AssetParams, bulkUploadThemeAssets, deleteThemeAsset} from '@shopify/cli-kit/node/themes/api'
import {renderWarning, Task} from '@shopify/cli-kit/node/ui'
import {outputDebug, outputInfo, outputNewline, outputWarn} from '@shopify/cli-kit/node/output'

interface UploadOptions {
  nodelete?: boolean
  ignore?: string[]
  only?: string[]
  deferPartialWork?: boolean
}

type ChecksumWithSize = Checksum & {size: number}
type FileBatch = ChecksumWithSize[]

// Limits for Bulk Requests
export const MAX_BATCH_FILE_COUNT = 10
// 100KB
export const MAX_BATCH_BYTESIZE = 102400
export const MAX_UPLOAD_RETRY_COUNT = 2

export function uploadTheme(
  theme: Theme,
  session: AdminSession,
  checksums: Checksum[],
  themeFileSystem: ThemeFileSystem,
  options: UploadOptions = {},
) {
  const remoteChecksums = rejectGeneratedStaticAssets(checksums)
  const uploadResults: Map<string, Result> = new Map()
  const getProgress = (params: {current: number; total: number}) =>
    `[${Math.round((params.current / params.total) * 100)}%]`

  const uploadJobPromise = themeFileSystem
    .ready()
    .then(() => buildUploadJob(remoteChecksums, themeFileSystem, options, theme, session, uploadResults))

  const deleteJobPromise = uploadJobPromise
    .then((result) => result.promise)
    .then(() => reportFailedUploads(uploadResults))
    .then(() => buildDeleteJob(remoteChecksums, themeFileSystem, options, theme, session))

  const workPromise = options?.deferPartialWork
    ? Promise.resolve()
    : deleteJobPromise
        .then((result) => result.promise)
        .catch(() => {
          renderWarning({headline: 'Failed to delete outdated files from remote theme.'})
        })

  return {
    uploadResults,
    workPromise,
    renderThemeSyncProgress: async () => {
      if (options?.deferPartialWork) return

      const {progress: uploadProgress, promise: uploadPromise} = await uploadJobPromise
      await renderTasksToStdErr(
        createIntervalTask({
          promise: uploadPromise,
          titleGetter: () => `Uploading files to remote theme ${getProgress(uploadProgress)}`,
          timeout: 1000,
        }),
      )

      const {progress: deleteProgress, promise: deletePromise} = await deleteJobPromise
      await renderTasksToStdErr(
        createIntervalTask({
          promise: deletePromise,
          titleGetter: () => `Cleaning your remote theme ${getProgress(deleteProgress)}`,
          timeout: 1000,
        }),
      )
    },
  }
}

function createIntervalTask({
  promise,
  titleGetter,
  timeout,
}: {
  promise: Promise<unknown>
  titleGetter: () => string
  timeout: number
}) {
  const tasks: Task[] = []

  const addNextCheck = () => {
    tasks.push({
      title: titleGetter(),
      task: async () => {
        const result = await Promise.race([
          promise,
          new Promise((resolve) => setTimeout(() => resolve('timeout'), timeout)),
        ])

        if (result === 'timeout') {
          addNextCheck()
        }
      },
    })
  }

  addNextCheck()
  return tasks
}

async function buildDeleteJob(
  remoteChecksums: Checksum[],
  themeFileSystem: ThemeFileSystem,
  options: UploadOptions,
  theme: Theme,
  session: AdminSession,
): Promise<SyncJob> {
  if (options.nodelete) {
    return {progress: {current: 0, total: 0}, promise: Promise.resolve()}
  }

  const remoteFilesToBeDeleted = await getRemoteFilesToBeDeleted(remoteChecksums, themeFileSystem, options)
  const orderedFiles = orderFilesToBeDeleted(remoteFilesToBeDeleted)

  const progress = {current: 0, total: orderedFiles.length}
  const promise = Promise.all(
    orderedFiles.map((file) =>
      deleteThemeAsset(theme.id, file.key, session).then(() => {
        progress.current++
      }),
    ),
  ).then(() => {
    progress.current = progress.total
  })

  return {progress, promise}
}

async function getRemoteFilesToBeDeleted(
  remoteChecksums: Checksum[],
  themeFileSystem: ThemeFileSystem,
  options: UploadOptions,
): Promise<Checksum[]> {
  const filteredChecksums = await applyIgnoreFilters(remoteChecksums, themeFileSystem, options)
  const filesToBeDeleted = filteredChecksums.filter((checksum) => !themeFileSystem.files.has(checksum.key))
  outputDebug(`Files to be deleted:\n${filesToBeDeleted.map((file) => `-${file.key}`).join('\n')}`)
  return filesToBeDeleted
}

// Contextual Json Files -> Json Files -> Liquid Files -> Config Files -> Static Asset Files
function orderFilesToBeDeleted(files: Checksum[]): Checksum[] {
  const fileSets = partitionThemeFiles(files)
  return [
    ...fileSets.contextualizedJsonFiles,
    ...fileSets.templateJsonFiles,
    ...fileSets.sectionJsonFiles,
    ...fileSets.otherJsonFiles,
    ...fileSets.sectionLiquidFiles,
    ...fileSets.otherLiquidFiles,
    ...fileSets.configFiles,
    ...fileSets.staticAssetFiles,
  ]
}

interface SyncJob {
  progress: {current: number; total: number}
  promise: Promise<void>
}

async function buildUploadJob(
  remoteChecksums: Checksum[],
  themeFileSystem: ThemeFileSystem,
  options: UploadOptions,
  theme: Theme,
  session: AdminSession,
  uploadResults: Map<string, Result>,
): Promise<SyncJob> {
  const filesToUpload = await selectUploadableFiles(themeFileSystem, remoteChecksums, options)

  // Adjust unsyncedFileKeys to reflect only the files that are about to be uploaded
  themeFileSystem.unsyncedFileKeys.clear()
  filesToUpload.forEach((file) => themeFileSystem.unsyncedFileKeys.add(file.key))

  const {independentFiles, dependentFiles} = orderFilesToBeUploaded(filesToUpload)

  const progress = {current: 0, total: filesToUpload.length}

  const uploadFileBatches = (fileType: ChecksumWithSize[]) => {
    if (fileType.length === 0) return Promise.resolve()
    return Promise.all(
      createBatches(fileType).map((batch) =>
        uploadBatch(batch, themeFileSystem, session, theme.id, uploadResults).then(() => {
          progress.current += batch.length
          batch.forEach((file) => themeFileSystem.unsyncedFileKeys.delete(file.key))
        }),
      ),
    ).then(() => {})
  }

  // Fire off the dependent files first, then the independent files:
  const dependentFilesUploadPromise = dependentFiles.reduce(
    (promise, fileType) => promise.then(() => uploadFileBatches(fileType)),
    Promise.resolve(),
  )
  const independentFilesUploadPromise = Promise.resolve().then(() => uploadFileBatches(independentFiles.flat()))

  const promise = Promise.all([dependentFilesUploadPromise, independentFilesUploadPromise]).then(() => {
    progress.current += progress.total
  })

  return {progress, promise}
}

async function selectUploadableFiles(
  themeFileSystem: ThemeFileSystem,
  remoteChecksums: Checksum[],
  options: UploadOptions,
): Promise<ChecksumWithSize[]> {
  const localChecksums = calculateLocalChecksums(themeFileSystem)
  const filteredLocalChecksums = await applyIgnoreFilters(localChecksums, themeFileSystem, options)
  const remoteChecksumsMap = new Map(remoteChecksums.map((remote) => [remote.key, remote]))

  const filesToUpload = filteredLocalChecksums.filter((local) => {
    const remote = remoteChecksumsMap.get(local.key)
    return !remote || remote.checksum !== local.checksum
  })
  outputDebug(`Files to be uploaded:\n${filesToUpload.map((file) => `-${file.key}`).join('\n')}`)
  return filesToUpload
}

/**
 * We use this 2d array to batch files of the same type together
 * while maintaining the order between file types. The files with
 * dependencies we have are:
 * 1. Liquid sections need to be uploaded first
 * 2. JSON sections need to be uploaded afterward so they can reference Liquid sections
 * 3. JSON templates should be the next ones so they can reference sections
 * 4. Contextualized templates should be uploaded after as they are variations of templates
 * 5. Config files must be the last ones, but we need to upload config/settings_schema.json first, followed by config/settings_data.json
 *
 * The files with no dependencies we have are:
 * - The other Liquid files (for example, snippets)
 * - The other JSON files (for example, locales)
 * - The static assets
 *
 */
function orderFilesToBeUploaded(files: ChecksumWithSize[]): {
  independentFiles: ChecksumWithSize[][]
  dependentFiles: ChecksumWithSize[][]
} {
  const fileSets = partitionThemeFiles(files)
  return {
    independentFiles: [fileSets.otherJsonFiles, fileSets.otherLiquidFiles, fileSets.staticAssetFiles],
    dependentFiles: [
      fileSets.sectionLiquidFiles,
      fileSets.sectionJsonFiles,
      fileSets.templateJsonFiles,
      fileSets.contextualizedJsonFiles,
      fileSets.configFiles,
    ],
  }
}

function createBatches<T extends {size: number}>(files: T[]): T[][] {
  const batches: T[][] = []
  let currentBatch: T[] = []
  let currentBatchSize = 0

  for (const file of files) {
    const hasEnoughItems = currentBatch.length >= MAX_BATCH_FILE_COUNT
    const hasEnoughByteSize = currentBatchSize >= MAX_BATCH_BYTESIZE

    if (hasEnoughItems || hasEnoughByteSize) {
      batches.push(currentBatch)
      currentBatch = []
      currentBatchSize = 0
    }

    currentBatch.push(file)
    currentBatchSize += file.size ?? 0
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch)
  }

  return batches
}

function calculateLocalChecksums(localThemeFileSystem: ThemeFileSystem): ChecksumWithSize[] {
  const checksums: ChecksumWithSize[] = []

  localThemeFileSystem.files.forEach((file, key) => {
    checksums.push({
      key,
      checksum: file.checksum,
      size: (file.value || file.attachment)?.length ?? 0,
    })
  })

  return checksums
}

async function uploadBatch(
  batch: FileBatch,
  localThemeFileSystem: ThemeFileSystem,
  session: AdminSession,
  themeId: number,
  uploadResults: Map<string, Result>,
) {
  const uploadParams = batch.map((file) => {
    const value = localThemeFileSystem.files.get(file.key)?.value
    const attachment = localThemeFileSystem.files.get(file.key)?.attachment
    return {
      key: file.key,
      ...(value && {value}),
      ...(attachment && {attachment}),
    }
  })
  outputDebug(`Uploading the following files:\n${batch.map((file) => `-${file.key}`).join('\n')}`)
  const results = await handleBulkUpload(uploadParams, themeId, session)
  // store the results in uploadResults, overwriting any existing results
  results.forEach((result) => {
    uploadResults.set(result.key, result)
  })
}

async function handleBulkUpload(
  uploadParams: AssetParams[],
  themeId: number,
  session: AdminSession,
  count = 0,
): Promise<Result[]> {
  if (uploadParams.length === 0) {
    return []
  }
  if (count > 0) {
    outputDebug(
      `Retry Attempt ${count}/${MAX_UPLOAD_RETRY_COUNT} for the following files:
      ${uploadParams.map((param) => `-${param.key}`).join('\n')}`,
    )
  }

  const results = await bulkUploadThemeAssets(themeId, uploadParams, session)
  outputDebug(
    `File Upload Results:\n${results
      .map((result) => `-${result.key}: ${result.success ? 'success' : 'failure'}`)
      .join('\n')}`,
  )

  const failedUploadResults = results.filter((result) => result.success === false)
  if (failedUploadResults.length > 0) {
    outputDebug(
      `The following files failed to upload:\n${failedUploadResults.map((param) => `-${param.key}`).join('\n')}`,
    )
    const failedResults = await handleFailedUploads(failedUploadResults, uploadParams, themeId, session, count)
    return results.concat(failedResults)
  }
  return results
}

async function handleFailedUploads(
  failedUploadResults: Result[],
  uploadParams: AssetParams[],
  themeId: number,
  session: AdminSession,
  count: number,
): Promise<Result[]> {
  const failedUploadsSet = new Set(failedUploadResults.map((result) => result.key))
  const failedUploadParams = uploadParams.filter((param) => failedUploadsSet.has(param.key))

  if (count === MAX_UPLOAD_RETRY_COUNT) {
    outputDebug(
      `Max retry count reached for the following files:\n${failedUploadParams
        .map((param) => `-${param.key}`)
        .join('\n')}`,
    )
    return failedUploadResults
  }

  return handleBulkUpload(failedUploadParams, themeId, session, count + 1)
}

function reportFailedUploads(uploadResults: Map<string, Result>) {
  for (const [key, result] of uploadResults.entries()) {
    if (!result.success) {
      const errorMessage = result.errors?.asset?.map((err) => `-${err}`).join('\n')
      outputWarn(`Failed to upload file ${key}:`)
      outputInfo(`${errorMessage}`)
      outputNewline()
    }
  }
}
