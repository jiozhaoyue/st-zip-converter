import yauzl from 'yauzl';

/**
 * 流式 zip 读取。yauzl 一次只允许一个打开的 read stream,所以 entries() 迭代器
 * 逐条产出,并在推进到下一条目前确认上一条的流已经读完——消费方要么 read() 要么
 * openStream() 后必须把流读到结束,要么显式 skip()。
 */
export class ZipReader {
  #zip;

  constructor(zip) {
    this.#zip = zip;
  }

  static async open(filePath) {
    const zip = await new Promise((resolve, reject) => {
      yauzl.open(filePath, { lazyEntries: true, decodeStrings: true, autoClose: false }, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
    return new ZipReader(zip);
  }

  get entryCount() {
    return this.#zip.entryCount;
  }

  #nextRaw() {
    return new Promise((resolve, reject) => {
      const onEntry = (entry) => { detach(); resolve(entry); };
      const onEnd = () => { detach(); resolve(null); };
      const onError = (err) => { detach(); reject(err); };
      const detach = () => {
        this.#zip.off('entry', onEntry);
        this.#zip.off('end', onEnd);
        this.#zip.off('error', onError);
      };
      this.#zip.on('entry', onEntry);
      this.#zip.on('end', onEnd);
      this.#zip.on('error', onError);
      this.#zip.readEntry();
    });
  }

  async *entries() {
    let raw = await this.#nextRaw();
    while (raw) {
      const entry = raw;
      let stream = null;
      const api = {
        fileName: entry.fileName,
        uncompressedSize: entry.uncompressedSize,
        compressedSize: entry.compressedSize,
        lastModified: safeLastModified(entry),
        isDirectory: entry.uncompressedSize === 0 && entry.fileName.endsWith('/'),
        openStream: async () => {
          if (!stream) stream = await openReadStream(this.#zip, entry);
          return stream;
        },
        read: async () => {
          const s = await api.openStream();
          return await collectBuffer(s);
        },
        skip: () => {},
      };
      yield api;
      if (stream && !stream.readableEnded) {
        await drained(stream);
      }
      raw = await this.#nextRaw();
    }
  }

  /** 只拿条目名清单(不开文件流,走中央目录,大包也快)。 */
  async listPaths() {
    const paths = [];
    for await (const entry of this.entries()) {
      paths.push(entry.fileName);
      entry.skip();
    }
    return paths;
  }

  close() {
    return new Promise((resolve) => {
      this.#zip.once('close', resolve);
      this.#zip.close();
    });
  }
}

function openReadStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => {
      if (err) reject(err);
      else resolve(stream);
    });
  });
}

function collectBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function drained(stream) {
  return new Promise((resolve, reject) => {
    if (stream.readableEnded || stream.destroyed) {
      resolve();
      return;
    }
    stream.on('end', resolve);
    stream.on('close', resolve);
    stream.on('error', reject);
  });
}

function safeLastModified(entry) {
  try {
    const date = entry.getLastModDate();
    return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null;
  } catch {
    return null;
  }
}
