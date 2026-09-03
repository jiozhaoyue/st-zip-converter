/** --dry-run 用:同接口但不落盘、不持有资源。 */
export class NullZipWriter {
  add() {}
  addLazy() {}
  async waitForRoom() {}
  async close() {
    return null;
  }
  async abort() {}
}
