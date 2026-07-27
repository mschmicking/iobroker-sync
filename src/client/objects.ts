/**
 * Object-layer API on top of `SocketClient`: scripts and folders under
 * `script.js.` in the ioBroker object tree.
 */

import {
  FolderObject,
  IoBrokerObject,
  ObjectsApi,
  ObjectViewResult,
  ScriptCommon,
  ScriptObject,
  SocketClient,
} from '../types';

const SCRIPT_NAMESPACE = 'script.js.';
// Verified endkey used by the Admin UI itself to bound a getObjectView range scan.
const VIEW_ENDKEY = `${SCRIPT_NAMESPACE}香`;

export class AdminObjectsApi implements ObjectsApi {
  constructor(private readonly socket: SocketClient) {}

  async listScripts(): Promise<ScriptObject[]> {
    const result = await this.socket.emit<ObjectViewResult<ScriptObject>>('getObjectView', [
      'system',
      'script',
      { startkey: SCRIPT_NAMESPACE, endkey: VIEW_ENDKEY },
    ]);
    return (result?.rows ?? [])
      .map((row) => row.value)
      .filter((value): value is ScriptObject => !!value && value.type === 'script');
  }

  async listFolders(): Promise<FolderObject[]> {
    const result = await this.socket.emit<ObjectViewResult<FolderObject>>('getObjectView', [
      'system',
      'channel',
      { startkey: SCRIPT_NAMESPACE, endkey: VIEW_ENDKEY },
    ]);
    return (result?.rows ?? [])
      .map((row) => row.value)
      .filter((value): value is FolderObject => !!value && value.type === 'channel');
  }

  async getScript(id: string): Promise<ScriptObject | null> {
    const obj = await this.socket.emit<IoBrokerObject | null>('getObject', [id]);
    if (!obj || obj.type !== 'script') {
      return null;
    }
    return obj;
  }

  /**
   * Only ever sends `{common: {source, engineType}}`. The parameter type
   * enforces this at the call site; we do not merge in any other fields
   * here so a bug elsewhere cannot smuggle `enabled`/`engine`/etc. through.
   */
  async extendScript(id: string, common: Pick<ScriptCommon, 'source' | 'engineType'>): Promise<void> {
    await this.socket.emit('extendObject', [id, { common: { source: common.source, engineType: common.engineType } }]);
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    await this.socket.emit('extendObject', [id, { common: { enabled } }]);
  }

  async createScript(obj: ScriptObject): Promise<void> {
    await this.socket.emit('setObject', [obj._id, obj]);
  }

  /**
   * Creates any missing `channel` folder objects along the path to `scriptId`,
   * e.g. for `script.js.a.b.c` it checks/creates `script.js.a` then
   * `script.js.a.b` (never the script id itself). Never touches an existing
   * folder. Returns the ids actually created, in path order.
   */
  async ensureFolders(scriptId: string): Promise<string[]> {
    if (!scriptId.startsWith(SCRIPT_NAMESPACE)) {
      return [];
    }
    const rest = scriptId.slice(SCRIPT_NAMESPACE.length);
    const segments = rest.split('.').filter((s) => s.length > 0);
    // Every path prefix except the last segment (the script name itself) is a folder.
    const folderSegments = segments.slice(0, -1);

    const created: string[] = [];
    let path = SCRIPT_NAMESPACE.slice(0, -1); // "script.js"
    for (const segment of folderSegments) {
      path = `${path}.${segment}`;
      const existing = await this.socket.emit<IoBrokerObject | null>('getObject', [path]);
      if (!existing) {
        const folder: FolderObject = {
          _id: path,
          type: 'channel',
          common: { name: segment, expert: true },
          native: {},
        };
        await this.socket.emit('setObject', [path, folder]);
        created.push(path);
      }
    }
    return created;
  }

  /** Deletion policy (confirmation, backup) lives in the command layer, not here. */
  async deleteObject(id: string): Promise<void> {
    await this.socket.emit('delObject', [id]);
  }
}
