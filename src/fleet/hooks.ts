import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import type { FleetRuntime } from './runtime';

type FleetApiMethod = (...args: unknown[]) => Promise<unknown>;
type FleetObjectValue = Record<string, unknown>;

const FLEET_NODE_LABEL_PREFIX = '执行电脑：';
const FLEET_NODE_LABEL_ELEMENT_ID = 'fleet_node_label';
const fleetLegacyNodeLabels = new WeakMap<FleetObjectValue, FleetObjectValue>();

function fleetRecord(value: unknown): FleetObjectValue | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as FleetObjectValue : undefined;
}

function isFleetCard(value: unknown): value is FleetObjectValue {
  const record = fleetRecord(value);
  return !!record && !!(record.schema || record.elements || record.body);
}

function isFleetNodeLabel(element: unknown): element is FleetObjectValue {
  const record = fleetRecord(element);
  return record?.tag === 'markdown' && record.element_id === FLEET_NODE_LABEL_ELEMENT_ID;
}

function updateFleetNodeLabel(
  card: FleetObjectValue, elements: FleetObjectValue[], name: string, legacy: boolean,
): void {
  const content = `${FLEET_NODE_LABEL_PREFIX}${name}`;
  if (legacy) {
    const previous = fleetLegacyNodeLabels.get(card);
    if (previous && elements.includes(previous)) {
      (previous.elements as FleetObjectValue[])[0]!.content = content;
      return;
    }
    const label = { tag: 'note', elements: [{ tag: 'plain_text', content }] };
    fleetLegacyNodeLabels.set(card, label);
    elements.push(label);
    return;
  }
  let found = false;
  for (let index = 0; index < elements.length;) {
    const element = elements[index];
    if (!isFleetNodeLabel(element)) { index += 1; continue; }
    if (found) { elements.splice(index, 1); continue; }
    element.content = content;
    found = true;
    index += 1;
  }
  if (found) return;
  elements.push({ tag: 'markdown', element_id: FLEET_NODE_LABEL_ELEMENT_ID, content });
}

export function stampFleetCard(card: FleetObjectValue, runtime: FleetRuntime, name: string): void {
  const ownership = { __fleetNode: runtime.nodeId, __fleetProof: runtime.store.proof({ cardNode: runtime.nodeId }) };
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const record = fleetRecord(item);
    if (!record) return;
    const value = fleetRecord(record.value);
    if ((record.type === 'callback' || record.tag === 'button' || record.tag === 'select_static') && value) {
      Object.assign(value, ownership);
    }
    Object.values(record).forEach(visit);
  };
  visit(card);
  const body = fleetRecord(card.body);
  if (Array.isArray(body?.elements)) updateFleetNodeLabel(card, body.elements as FleetObjectValue[], name, false);
  else if (Array.isArray(card.elements)) updateFleetNodeLabel(card, card.elements as FleetObjectValue[], name, true);
}

function decorateFleetCardContent(content: unknown, runtime: FleetRuntime, name: string): unknown {
  if (typeof content !== 'string') {
    if (isFleetCard(content)) stampFleetCard(content, runtime, name);
    return content;
  }
  if (!content.trimStart().startsWith('{')) return content;
  let parsed: unknown;
  try { parsed = JSON.parse(content); } catch { return content; }
  if (!isFleetCard(parsed)) return content;
  stampFleetCard(parsed, runtime, name);
  return JSON.stringify(parsed);
}

function decorateFleetField(
  owner: unknown, key: string, runtime: FleetRuntime, name: string,
): void {
  const record = fleetRecord(owner);
  if (!record) return;
  const decorated = decorateFleetCardContent(record[key], runtime, name);
  if (decorated !== record[key]) record[key] = decorated;
}

function decorateFleetCardCreateRequest(request: unknown, runtime: FleetRuntime, name: string): void {
  decorateFleetField(fleetRecord(request)?.data, 'data', runtime, name);
}

function decorateFleetCardUpdateRequest(request: unknown, runtime: FleetRuntime, name: string): void {
  const data = fleetRecord(fleetRecord(request)?.data);
  decorateFleetField(fleetRecord(data?.card), 'data', runtime, name);
}

function decorateFleetMessageRequest(request: unknown, runtime: FleetRuntime, name: string): void {
  decorateFleetField(fleetRecord(request)?.data, 'content', runtime, name);
}

/** Only installed in opt-in fleet mode. Keep native API return values unchanged. */
export function installFleetHooks(
  channel: LarkChannel, runtime: FleetRuntime, name: string, onError: (error: unknown) => void,
): () => void {
  const restores: Array<() => void> = [];
  function wrap(
    owner: unknown, key: string, after?: (result: FleetObjectValue) => Promise<void>,
    decorate?: (request: unknown, runtime: FleetRuntime, name: string) => void,
  ): void {
    if (!owner || typeof owner !== 'object') return;
    const object = owner as Record<string, FleetApiMethod>;
    const original = object[key];
    if (typeof original !== 'function') return;
    object[key] = async (...args: unknown[]) => {
      if (decorate) decorate(args[0], runtime, name);
      const result = await original.apply(owner, args);
      // A failed metadata write must never turn an already-sent message into a retry.
      if (after) await after(result as FleetObjectValue).catch(onError);
      return result;
    };
    restores.push(() => { object[key] = original; });
  }
  const client = channel.rawClient;
  wrap(client.cardkit.v1.card, 'create', undefined, decorateFleetCardCreateRequest);
  wrap(client.cardkit.v1.card, 'update', undefined, decorateFleetCardUpdateRequest);
  const remember = async (result: FleetObjectValue): Promise<void> => {
    const id = (result.data as { message_id?: string } | undefined)?.message_id;
    if (id) await runtime.ownMessage(id);
  };
  wrap(client.im.v1.message, 'create', remember, decorateFleetMessageRequest);
  wrap(client.im.v1.message, 'reply', remember, decorateFleetMessageRequest);
  wrap(client.im.v1.message, 'patch', undefined, decorateFleetMessageRequest);
  wrap(client.im.v1.chat, 'create', async result => {
    const id = (result.data as { chat_id?: string } | undefined)?.chat_id;
    if (id) await runtime.bindRoute(`project:${id}`);
  });
  return () => restores.reverse().forEach(restore => restore());
}
