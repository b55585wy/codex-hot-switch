import type { LarkChannel } from '@larksuiteoapi/node-sdk';
import { sendManagedCard } from '../card/managed';
import { eventActor, isOnline, type FleetNode } from './model';
import type { FleetRuntimeOptions } from './runtime';

export function createFleetPicker(channel: LarkChannel): FleetRuntimeOptions['picker'] {
  return async (event, nodes: FleetNode[]) => {
    const nameCounts = new Map<string, number>();
    for (const node of nodes) {
      const key = node.name.toLocaleLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const elements: object[] = nodes.map(node => {
      const online = isOnline(node);
      const duplicate = (nameCounts.get(node.name.toLocaleLowerCase()) ?? 0) > 1;
      const description = { tag: 'markdown', content:
        `**${node.name}** · ${online ? '在线' : '离线或版本不兼容'}${duplicate ? `\n设备 ID：${node.id}` : ''}` };
      if (!online) return description;
      const selectButton = {
        tag: 'button', text: { tag: 'plain_text', content: `选择 ${node.name}` }, type: 'default',
        behaviors: [{ type: 'callback', value: { a: 'fleet.select', targetNodeId: node.id } }],
      };
      return { tag: 'column_set', flex_mode: 'none', horizontal_spacing: 'medium', columns: [
        { tag: 'column', width: 'weighted', weight: 1, vertical_align: 'center', elements: [description] },
        { tag: 'column', width: 'auto', vertical_align: 'center', elements: [selectButton] },
      ] };
    });
    elements.push({ tag: 'markdown', content: '私聊：/电脑 电脑名\n未绑定项目群：/电脑 绑定 电脑名\n文档评论：/电脑 文档 文件类型 文件token' });
    await sendManagedCard(channel, typeof event.data.chatId === 'string' ? event.data.chatId : eventActor(event),
      { schema: '2.0', header: { title: { tag: 'plain_text', content: '执行电脑' } }, body: { elements } },
      undefined, false, typeof event.data.chatId === 'string' ? 'chat_id' : 'open_id');
  };
}
