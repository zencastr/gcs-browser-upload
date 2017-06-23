import { put } from 'axios'
import FileMeta from './FileMeta'
import { getChecksum } from './FileProcessor'
import debug from './debug'
import SparkMD5 from 'spark-md5'
import retry from 'async-retry'
import {
  FileAlreadyUploadedError,
  UrlNotFoundError,
  UploadFailedError,
  UploadUnableToRecoverError,
  UnknownResponseError,
  MissingOptionsError,
  UploadIncompleteError,
  InvalidChunkSizeError
} from './errors'
import * as errors from './errors'

const MIN_CHUNK_SIZE = 262144

export default class Upload {
  static errors = errors;

  constructor (args, allowSmallChunks) {
    this.paused = false
    this.unpauseHandlers = []
    this.spark = new SparkMD5.ArrayBuffer()

    var opts = {
      chunkSize: MIN_CHUNK_SIZE,
      storage: window.localStorage,
      contentType: 'text/plain',
      onChunkUpload: () => {},
      onProgress: () => {},
      id: null,
      url: null,
      backoffMillis: 1000,
      backoffRetryLimit: 5,
      ...args
    }

    if ((opts.chunkSize % MIN_CHUNK_SIZE !== 0 || opts.chunkSize === 0) && !allowSmallChunks) {
      throw new InvalidChunkSizeError(opts.chunkSize)
    }

    if (!opts.id) {
      throw new MissingOptionsError('The \'id\' option is required')
    }

    if (!opts.url) {
      throw new MissingOptionsError('The \'url\' option is required')
    }

    debug('Creating new upload stream instance:')
    debug(` - Url: ${opts.url}`)
    debug(` - Id: ${opts.id}`)
    debug(' - File size: Unknown / Streaming')
    debug(` - Chunk size: ${opts.chunkSize}`)

    this.opts = opts
    this.meta = new FileMeta(opts.id, 0, opts.chunkSize, opts.storage)
  }

  async uploadChunk (index, chunk, backoff = 1) {
    const { opts, meta } = this
    const start = index * opts.chunkSize
    const end = index * opts.chunkSize + chunk.byteLength - 1

    if (this.paused) {
      await this.waitForUnpause()
    }

    const checksum = getChecksum(this.spark, chunk)

    const headers = {
      'Content-Type': opts.contentType,
      'Content-Range': `bytes ${start}-${end}/*`
    }

    debug(`Uploading chunk ${index}:`)
    debug(` - Chunk length: ${chunk.byteLength}`)
    debug(` - Start: ${start}`)
    debug(` - End: ${end}`)

    // if (backoff >= opts.backoffRetryLimit) {
    //   throw new UploadUnableToRecoverError()
    // }

    try {
      await retry(async (bail, num) => {
        const res = await safePut(opts.url, chunk, {
          headers, onUploadProgress: function (progressEvent) {
            opts.onProgress({
              totalBytes: start + chunk.byteLength,
              uploadedBytes: start + progressEvent.loaded,
              chunkIndex: index,
              chunkLength: chunk.byteLength
            })
          }
        })

        checkResponseStatus(res, opts, [200, 201, 308])
      }, {retries: opts.backoffRetryLimit, minTimeout: opts.backoffMillis})
    } catch (err) {
      throw new UploadUnableToRecoverError()
    }

    debug(`Chunk upload succeeded, adding checksum ${checksum}`)
    meta.addChecksum(index, checksum)

    opts.onChunkUpload({
      uploadedBytes: end + 1,
      chunkIndex: index,
      chunkLength: chunk.byteLength
    })
  }

  async getRemoteResumeIndex () {
    const { opts } = this
    const headers = {
      'Content-Range': 'bytes */*'
    }
    debug('Retrieving upload status from GCS')
    const res = await safePut(opts.url, null, { headers })

    debug(res)

    checkResponseStatus(res, opts, [308])
    const header = res.headers['range']
    debug(`Received upload status from GCS: ${header}`)
    const range = header.match(/(\d+?)-(\d+?)$/)
    const bytesReceived = parseInt(range[2]) + 1
    return Math.floor(bytesReceived / opts.chunkSize)
  }

  pause () {
    debug('Upload Stream paused')
    this.paused = true
  }

  unpause () {
    debug('Upload Stream unpaused')
    this.paused = false
    this.unpauseHandlers.forEach((fn) => fn())
    this.unpauseHandlers = []
  }

  waitForUnpause () {
    return new Promise((resolve) => {
      this.unpauseHandlers.push(resolve)
    })
  }

  cancel () {
    this.meta.reset()
    debug('Upload cancelled')
  }
}

function checkResponseStatus (res, opts, allowed = []) {
  const { status } = res
  if (allowed.indexOf(status) > -1) {
    return true
  }

  switch (status) {
    case 308:
      throw new UploadIncompleteError()

    case 201:
    case 200:
      throw new FileAlreadyUploadedError(opts.id, opts.url)

    case 404:
      throw new UrlNotFoundError(opts.url)

    case 500:
    case 502:
    case 503:
    case 504:
      throw new UploadFailedError(status)

    default:
      throw new UnknownResponseError(res)
  }
}

async function safePut () {
  try {
    return await put.apply(null, arguments)
  } catch (e) {
    if (e instanceof Error) {
      throw e
    } else {
      return e
    }
  }
}