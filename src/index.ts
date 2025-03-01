export type ChunkSize = number | ((file: File) => number);

export interface IFileChunkOptions {
  chunkSize: ChunkSize;
  concurrency?: number;
  maxRetries?: number;
}

export interface IFileChunk {
  chunk: Blob;
  current: number;
  count: number;
}

const defaultOptions: Required<IFileChunkOptions> = {
  chunkSize: 1024 * 1024 * 5, // 5MB, Amazon minimum limit is 5MB
  concurrency: 10,
  maxRetries: 3
};

// @ref: https://chatgpt.com/c/676ace72-732c-8013-9342-48797a30f123
// https://github.com/rxaviers/async-pool
// https://stackoverflow.com/questions/42896456/get-which-promise-completed-in-promise-race

class FileChunk {
  public file: File;
  public options: IFileChunkOptions;

  get chunkCount(): number {
    return Math.ceil(this.file.size / this.chunkSize);
  }

  get chunkSize(): number {
    const { chunkSize } = this.options;
    if (typeof chunkSize === 'number') return chunkSize;
    if (typeof chunkSize === 'function') return chunkSize(this.file);
    throw new Error('Invalid chunkSize option');
  }

  get meta() {
    const { file, options } = this;
    return {
      file,
      options,
      chuckSize: this.chunkSize,
      chunkCount: this.chunkCount
    };
  }

  constructor(inFile: File, inOptions: IFileChunkOptions) {
    this.file = inFile;
    this.options = { ...defaultOptions, ...inOptions } as Required<IFileChunkOptions>;
  }

  createIterator(): IterableIterator<Blob> {
    const { file } = this;
    const chunkSize = this.chunkSize;
    let currentIndex = 0;

    return {
      [Symbol.iterator]() {
        return this;
      },
      next(): IteratorResult<Blob> {
        if (currentIndex < file.size) {
          const chunk = file.slice(currentIndex, currentIndex + chunkSize);
          currentIndex += chunkSize;
          return { value: chunk, done: false };
        } else {
          return { value: null, done: true };
        }
      }
    };
  }

  async processChunks(processChunk: (fileChunk: IFileChunk) => Promise<any>): Promise<any[]> {
    const { concurrency, maxRetries } = this.options;
    const chunkIterator = this.createIterator();
    const chunks = [...chunkIterator];

    // 创建一个队列并行处理分片
    const results: Promise<any>[] = [];
    const activeTasks: Promise<any>[] = [];
    let attempts = 0;

    for (const [index, chunk] of chunks.entries()) {
      const current = index + 1;
      const task = processChunk({ chunk, current, count: this.chunkCount })
        .then((res) => {
          // remove the task from the active tasks list when it's done
          activeTasks.splice(activeTasks.indexOf(task), 1);
          results[index] = res;
          return res;
        })
        .catch((err) => {
          // retry the task, up to maxRetries
          if (attempts++ >= maxRetries!) throw err;
          return this.processChunks(processChunk);
        });

      activeTasks.push(task);

      // 控制并行任务数量
      if (activeTasks.length >= concurrency!) {
        await Promise.race(activeTasks); // 等待一个任务完成
      }
    }

    // 处理剩余未完成的任务
    await Promise.all(activeTasks);

    return results;
  }
}

export default FileChunk;
