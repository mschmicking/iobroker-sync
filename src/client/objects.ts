/**
 * Object-layer API on top of `SocketClient`: scripts and folders under
 * `script.js.` in the ioBroker object tree.
 */

import {
  FolderObject,
  IoBrokerObject,
  MARKER_KINDS,
  MarkerKind,
  ObjectsApi,
  ObjectViewResult,
  ScriptCommon,
  ScriptMarkerEntry,
  ScriptObject,
  SocketClient,
} from '../types';

const SCRIPT_NAMESPACE = 'script.js.';
// Verified endkey used by the Admin UI itself to bound a getObjectView range scan.
const VIEW_ENDKEY = `${SCRIPT_NAMESPACE}香`;

const JS_NAMESPACE = 'javascript.';

/** `javascript.*.<kind>.*` — every instance's markers of one kind, for every script. */
function markerPattern(kind: MarkerKind): string {
  return `${JS_NAMESPACE}*.${kind}.*`;
}

/**
 * Splits a marker id into the script it belongs to and which kind it is:
 * `javascript.2.scriptEnabled.common.garage` -> `script.js.common.garage`, scriptEnabled.
 *
 * Returns null for anything that is not one — including ids with something other than
 * a bare instance number in front of the kind, so that a state someone else parked
 * under `javascript.` cannot be mistaken for ours and deleted.
 */
export function parseMarkerId(stateId: string): { scriptId: string; kind: MarkerKind } | null {
  if (!stateId.startsWith(JS_NAMESPACE)) {
    return null;
  }
  for (const kind of MARKER_KINDS) {
    const infix = `.${kind}.`;
    const kindAt = stateId.indexOf(infix);
    if (kindAt === -1) {
      continue;
    }
    const instance = stateId.slice(JS_NAMESPACE.length, kindAt);
    if (!/^\d+$/.test(instance)) {
      continue;
    }
    const suffix = stateId.slice(kindAt + infix.length);
    if (suffix) {
      return { scriptId: `${SCRIPT_NAMESPACE}${suffix}`, kind };
    }
  }
  return null;
}

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
    if (obj?.type !== 'script') {
      return null;
    }
    return obj;
  }

  /**
   * Only ever sends `{common: {source, engineType}}`. The parameter type
   * enforces this at the call site; we do not merge in any other fields
   * here so a bug elsewhere cannot smuggle `enabled`/`engine`/etc. through.
   */
  async extendScript(
    id: string,
    common: Pick<ScriptCommon, 'source' | 'engineType'>,
  ): Promise<void> {
    await this.socket.emit('extendObject', [
      id,
      { common: { source: common.source, engineType: common.engineType } },
    ]);
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

  /**
   * Reads the value side and the object side separately and unions them, because a
   * marker can exist as either half alone and the halves are what we need to tell apart.
   *
   * One half failing is tolerated: `getStates` and `getForeignObjects` are separate
   * commands with separate histories across Admin versions, and a partial answer here
   * still beats reporting nothing. Only a total failure propagates.
   */
  async listScriptMarkers(): Promise<ScriptMarkerEntry[]> {
    const perKind = await Promise.all(MARKER_KINDS.map((kind) => this.listMarkersOfKind(kind)));
    return perKind.flat().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  private async listMarkersOfKind(kind: MarkerKind): Promise<ScriptMarkerEntry[]> {
    const pattern = markerPattern(kind);
    const [values, objects] = await Promise.allSettled([
      this.readMarkerValues(pattern),
      this.socket.emit<Record<string, unknown> | null>('getForeignObjects', [pattern, 'state']),
    ]);

    if (values.status === 'rejected' && objects.status === 'rejected') {
      throw values.reason;
    }

    const valueIds = new Set(values.status === 'fulfilled' ? Object.keys(values.value ?? {}) : []);
    const objectIds = new Set(
      objects.status === 'fulfilled' ? Object.keys(objects.value ?? {}) : [],
    );

    const entries: ScriptMarkerEntry[] = [];
    for (const id of new Set([...valueIds, ...objectIds])) {
      const parsed = parseMarkerId(id);
      // The pattern is a wildcard match, so it can catch ids that merely look the part
      // (`javascript.0.scriptEnabled` with no suffix, or a non-numeric instance).
      // parseMarkerId is the authority on what is really ours.
      if (parsed?.kind !== kind) {
        continue;
      }
      entries.push({
        id,
        scriptId: parsed.scriptId,
        kind,
        hasValue: valueIds.has(id),
        hasObject: objectIds.has(id),
      });
    }
    return entries;
  }

  /**
   * `getStates` is the current command; `getForeignStates` is its deprecated alias and
   * the only one older Admin builds answer. Trying both costs one extra round trip on
   * instances that need it and nothing on instances that do not.
   */
  private async readMarkerValues(pattern: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.socket.emit<Record<string, unknown> | null>('getStates', [pattern]);
    } catch {
      return this.socket.emit<Record<string, unknown> | null>('getForeignStates', [pattern]);
    }
  }

  async deleteScriptMarker(entry: ScriptMarkerEntry): Promise<void> {
    if (!parseMarkerId(entry.id)) {
      // Belt and braces: this API is reachable from command code, and the whole point
      // of it is deleting things, so it refuses anything outside its own namespace.
      throw new Error(`Refusing to delete "${entry.id}": not a script marker.`);
    }

    // Value first. If this throws we stop here on purpose — deleting the object while
    // the value survives would manufacture the exact orphan this code exists to remove.
    if (entry.hasValue) {
      await this.socket.emit('delState', [entry.id]);
    }

    if (entry.hasObject) {
      // Admin's delState is documented to take the object with it. Verify rather than
      // assume: on an instance where it does not, the object has to go separately.
      const remaining = await this.socket.emit<IoBrokerObject | null>('getObject', [entry.id]);
      if (remaining) {
        await this.socket.emit('delObject', [entry.id]);
      }
    }
  }
}
